/**
 * GeminiAgent: Gemini-based observation extraction
 *
 * Alternative to SDKAgent that uses Google's Gemini API directly
 * for extracting observations from tool usage.
 *
 * Responsibility:
 * - Call Gemini REST API for observation extraction
 * - Parse XML responses (same format as Claude)
 * - Sync to database and Chroma
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

// Gemini API endpoint
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini model types (available via API)
export type GeminiModel =
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-3-flash';

// Free tier RPM limits by model (requests per minute)
const GEMINI_RPM_LIMITS: Record<GeminiModel, number> = {
  'gemini-2.5-flash-lite': 10,
  'gemini-2.5-flash': 10,
  'gemini-2.5-pro': 5,
  'gemini-2.0-flash': 15,
  'gemini-2.0-flash-lite': 30,
  'gemini-3-flash': 5,
};

// Track last request time for rate limiting
let lastRequestTime = 0;

/**
 * Enforce RPM rate limit for Gemini free tier.
 * Waits the required time between requests based on model's RPM limit + 100ms safety buffer.
 * Skipped entirely if rate limiting is disabled (billing users with 1000+ RPM available).
 */
async function enforceRateLimitForModel(model: GeminiModel, rateLimitingEnabled: boolean): Promise<void> {
  // Skip rate limiting if disabled (billing users with 1000+ RPM)
  if (!rateLimitingEnabled) {
    return;
  }

  const rpm = GEMINI_RPM_LIMITS[model] || 5;
  const minimumDelayMs = Math.ceil(60000 / rpm) + 100; // (60s / RPM) + 100ms safety buffer

  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < minimumDelayMs) {
    const waitTime = minimumDelayMs - timeSinceLastRequest;
    logger.debug('SDK', `Rate limiting: waiting ${waitTime}ms before Gemini request`, { model, rpm });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Gemini content message format
 * role: "user" or "model" (Gemini uses "model" not "assistant")
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export class GeminiAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
 * Set the fallback agent for when Gemini API fails
 * Must be set after construction to avoid circular dependency
 */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Gemini agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Get Gemini configuration
      const { apiKey, model, rateLimitingEnabled } = this.getGeminiConfig();

      if (!apiKey) {
        throw new Error('Gemini API key not configured. Set CODEX_MEM_GEMINI_API_KEY (or CLAUDE_MEM_GEMINI_API_KEY) in settings, or GEMINI_API_KEY environment variable.');
      }

      this.ensureMemorySessionId(session);

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query Gemini with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

      if (initResponse.content) {
        // Add response to conversation history
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  // Rough estimate
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Process response using shared ResponseProcessor (no original timestamp for init - not from queue)
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Gemini'
        );
      } else {
        logger.error('SDK', 'Empty Gemini init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });

        if (this.fallbackAgent) {
          logger.warn('SDK', 'Gemini init response was empty, falling back to configured provider', {
            sessionDbId: session.sessionDbId,
            model
          });
          return this.fallbackAgent.startSession(session, worker);
        }
      }

      // Process pending messages
      // Track cwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture cwd from each message for worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        // This ensures backlog messages get their original timestamps, not current time
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          // Update last prompt number
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          // Build observation prompt
          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          // Add to conversation history and query Gemini with full context
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

          let observationResponseContent = obsResponse.content || '';
          let tokensUsed = 0;
          if (observationResponseContent) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: observationResponseContent });

            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          } else {
            observationResponseContent = this.buildFallbackObservationXml(message);
            session.conversationHistory.push({ role: 'assistant', content: observationResponseContent });
            logger.warn('SDK', 'Gemini observation response was empty; storing fallback observation', {
              sessionDbId: session.sessionDbId,
              toolName: message.tool_name || 'unknown'
            });
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            observationResponseContent,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Gemini',
            lastCwd
          );

        } else if (message.type === 'summarize') {
          // Build summary prompt
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Add to conversation history and query Gemini with full context
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Gemini',
            lastCwd
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Gemini agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Gemini agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to the configured provider
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Gemini API failed, falling back to configured provider', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        // Fall back to configured provider - it will use the same session with shared conversationHistory
        // Note: With claim-and-delete queue pattern, messages are already deleted on claim
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Gemini agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Convert shared ConversationMessage array to Gemini's contents format
   * Maps 'assistant' role to 'model' for Gemini API compatibility
   */
  private conversationToGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  }

  /**
   * Query Gemini via REST API with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   */
  private async queryGeminiMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean
  ): Promise<{ content: string; tokensUsed?: number }> {
    const contents = this.conversationToGeminiContents(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Gemini multi-turn (${model})`, {
      turns: history.length,
      totalChars
    });

    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

    // Enforce RPM rate limit for free tier (skipped if rate limiting disabled)
    await enforceRateLimitForModel(model, rateLimitingEnabled);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.3,  // Lower temperature for structured extraction
          maxOutputTokens: 4096,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();

      // gemini-3-flash can be unavailable or rejected for some accounts/regions.
      // Retry once with a widely-available flash model before failing.
      if ((response.status === 400 || response.status === 404) && model === 'gemini-3-flash') {
        const fallbackModel: GeminiModel = 'gemini-2.5-flash';
        logger.warn('SDK', 'Gemini model unavailable or rejected, retrying with fallback model', {
          requestedModel: model,
          fallbackModel,
          status: response.status
        });
        return this.queryGeminiMultiTurn(history, apiKey, fallbackModel, rateLimitingEnabled);
      }

      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as GeminiResponse;

    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error('SDK', 'Empty response from Gemini');
      return { content: '' };
    }

    const content = data.candidates[0].content.parts[0].text;
    const tokensUsed = data.usageMetadata?.totalTokenCount;

    return { content, tokensUsed };
  }

  /**
   * Get Gemini configuration from settings or environment
   * Issue #733: Uses centralized data-dir .env for credentials, not random project .env files
   */
  private getGeminiConfig(): { apiKey: string; model: GeminiModel; rateLimitingEnabled: boolean } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // API key: check settings first, then centralized codex-mem .env (NOT process.env)
    // This prevents Issue #733 where random project .env files could interfere
    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';

    // Model: from settings or default, with validation
    const defaultModel: GeminiModel = 'gemini-2.5-flash';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;
    const validModels: GeminiModel[] = [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-3-flash',
    ];

    let model: GeminiModel;
    if (validModels.includes(configuredModel as GeminiModel)) {
      model = configuredModel as GeminiModel;
    } else {
      logger.warn('SDK', `Invalid Gemini model "${configuredModel}", falling back to ${defaultModel}`, {
        configured: configuredModel,
        validModels,
      });
      model = defaultModel;
    }

    // Rate limiting: enabled by default for free tier users
    const rateLimitingEnabled = settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false';

    return { apiKey, model, rateLimitingEnabled };
  }

  private ensureMemorySessionId(session: ActiveSession): void {
    if (session.memorySessionId) return;

    const persistedSession = this.dbManager.getSessionById(session.sessionDbId);
    if (persistedSession.memory_session_id) {
      session.memorySessionId = persistedSession.memory_session_id;
      logger.info('SESSION', 'Gemini provider reusing persisted memory session ID', {
        sessionId: session.sessionDbId,
        memorySessionId: persistedSession.memory_session_id
      });
      return;
    }

    const syntheticMemorySessionId = `gemini-worker-${session.contentSessionId}`;
    session.memorySessionId = syntheticMemorySessionId;
    this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);

    logger.info('SESSION', 'Gemini provider initialized synthetic memory session ID', {
      sessionId: session.sessionDbId,
      memorySessionId: syntheticMemorySessionId
    });
  }

  private buildFallbackObservationXml(message: {
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    cwd?: string;
  }): string {
    const toolName = message.tool_name || 'UnknownTool';
    const toolInput = message.tool_input !== undefined ? JSON.stringify(message.tool_input) : '';
    const toolResponse = message.tool_response !== undefined ? JSON.stringify(message.tool_response) : '';

    const escapedToolName = this.escapeXml(toolName);
    const escapedToolInput = this.escapeXml(this.truncateForFallback(toolInput, 800));
    const escapedToolResponse = this.escapeXml(this.truncateForFallback(toolResponse, 800));
    const escapedCwd = this.escapeXml(message.cwd || '(unknown cwd)');

    return `<observation>
  <type>discovery</type>
  <title>Tool execution captured: ${escapedToolName}</title>
  <subtitle>Recorded with fallback when Gemini returned empty content</subtitle>
  <narrative>Gemini returned no parsable observation output. Captured tool execution details directly to avoid dropping memory updates.</narrative>
  <facts>
    <fact>Tool: ${escapedToolName}</fact>
    <fact>CWD: ${escapedCwd}</fact>
    <fact>Input: ${escapedToolInput}</fact>
    <fact>Response: ${escapedToolResponse}</fact>
  </facts>
  <concepts>
    <concept>what-changed</concept>
    <concept>problem-solution</concept>
  </concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>`;
  }

  private truncateForFallback(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}...(truncated)`;
  }

  private escapeXml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  }
}

/**
 * Check if Gemini is available (has API key configured)
 * Issue #733: Uses centralized data-dir .env, not random project .env files
 */
export function isGeminiAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return !!(settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY'));
}

/**
 * Check if Gemini is the selected provider
 */
export function isGeminiSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}

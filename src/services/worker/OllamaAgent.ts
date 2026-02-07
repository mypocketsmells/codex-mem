/**
 * OllamaAgent: Ollama-native observation extraction
 *
 * Uses Ollama's local HTTP API (/api/chat) for observation and summary extraction.
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  isAbortError,
  type WorkerRef
} from './agents/index.js';

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'gemma3:4b';
const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;
const DEFAULT_OLLAMA_TEMPERATURE = 0.2;
const DEFAULT_OLLAMA_NUM_CTX = 8192;

export type OllamaMode = 'native' | 'codex_bridge';

interface OllamaMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
  error?: string;
}

interface OllamaConfig {
  mode: OllamaMode;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  options: Record<string, unknown>;
}

function normalizeMode(rawValue: string | undefined): OllamaMode {
  return rawValue === 'codex_bridge' ? 'codex_bridge' : 'native';
}

function normalizeInteger(rawValue: string | undefined, defaultValue: number): number {
  const parsedValue = parseInt(String(rawValue ?? defaultValue), 10);
  return Number.isFinite(parsedValue) ? parsedValue : defaultValue;
}

function normalizeNumber(rawValue: string | undefined, defaultValue: number): number {
  const parsedValue = Number(String(rawValue ?? defaultValue));
  return Number.isFinite(parsedValue) ? parsedValue : defaultValue;
}

function parseOptionsObject(rawOptionsJson: string | undefined): Record<string, unknown> {
  if (!rawOptionsJson || !rawOptionsJson.trim()) {
    return {};
  }

  try {
    const parsedValue = JSON.parse(rawOptionsJson);
    if (parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)) {
      return parsedValue as Record<string, unknown>;
    }
  } catch {
    // Settings validation rejects invalid JSON. Runtime fallback remains safe.
  }

  return {};
}

export class OllamaAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const ollamaConfig = this.getOllamaConfig();
      const mode = ModeManager.getInstance().getActiveMode();

      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryOllamaMultiTurn(session.conversationHistory, ollamaConfig);

      if (initResponse.content) {
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Ollama'
        );
      } else {
        logger.error('SDK', 'Empty Ollama init response - session may lack context', {
          sessionId: session.sessionDbId,
          model: ollamaConfig.model
        });
      }

      let lastCwd: string | undefined;
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          const observationPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          session.conversationHistory.push({ role: 'user', content: observationPrompt });
          const observationResponse = await this.queryOllamaMultiTurn(session.conversationHistory, ollamaConfig);

          let tokensUsed = 0;
          if (observationResponse.content) {
            session.conversationHistory.push({ role: 'assistant', content: observationResponse.content });
            tokensUsed = observationResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            observationResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Ollama',
            lastCwd
          );
        } else if (message.type === 'summarize') {
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryOllamaMultiTurn(session.conversationHistory, ollamaConfig);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Ollama',
            lastCwd
          );
        }
      }

      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Ollama agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model: ollamaConfig.model
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Ollama agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      logger.failure('SDK', 'Ollama agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  private conversationToOllamaMessages(history: ConversationMessage[]): OllamaMessage[] {
    return history.map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content
    }));
  }

  private async queryOllamaMultiTurn(
    history: ConversationMessage[],
    ollamaConfig: OllamaConfig
  ): Promise<{ content: string; tokensUsed?: number }> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), ollamaConfig.timeoutMs);

    try {
      const response = await fetch(`${ollamaConfig.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: ollamaConfig.model,
          messages: this.conversationToOllamaMessages(history),
          stream: false,
          options: ollamaConfig.options
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }

      const responseBody = await response.json() as OllamaChatResponse;
      if (responseBody.error) {
        throw new Error(`Ollama API error: ${responseBody.error}`);
      }

      const content = responseBody.message?.content || '';
      const promptTokens = responseBody.prompt_eval_count || 0;
      const completionTokens = responseBody.eval_count || 0;
      const tokensUsed = promptTokens + completionTokens;

      return {
        content,
        tokensUsed: tokensUsed > 0 ? tokensUsed : undefined
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private getOllamaConfig(): OllamaConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const mode = normalizeMode(settings.CLAUDE_MEM_OLLAMA_MODE);
    const baseUrl = (settings.CLAUDE_MEM_OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).trim();
    const model = (settings.CLAUDE_MEM_OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
    const timeoutMs = normalizeInteger(settings.CLAUDE_MEM_OLLAMA_TIMEOUT_MS, DEFAULT_OLLAMA_TIMEOUT_MS);
    const temperature = normalizeNumber(settings.CLAUDE_MEM_OLLAMA_TEMPERATURE, DEFAULT_OLLAMA_TEMPERATURE);
    const numCtx = normalizeInteger(settings.CLAUDE_MEM_OLLAMA_NUM_CTX, DEFAULT_OLLAMA_NUM_CTX);
    const userOptions = parseOptionsObject(settings.CLAUDE_MEM_OLLAMA_OPTIONS_JSON);

    return {
      mode,
      baseUrl,
      model,
      timeoutMs,
      options: {
        ...userOptions,
        temperature,
        num_ctx: numCtx
      }
    };
  }
}

export function getConfiguredOllamaMode(): OllamaMode {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return normalizeMode(settings.CLAUDE_MEM_OLLAMA_MODE);
}

export function isOllamaAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const baseUrl = (settings.CLAUDE_MEM_OLLAMA_BASE_URL || '').trim();
  const model = (settings.CLAUDE_MEM_OLLAMA_MODEL || '').trim();

  if (!baseUrl || !model) {
    return false;
  }

  try {
    const parsedBaseUrl = new URL(baseUrl);
    return parsedBaseUrl.protocol === 'http:' || parsedBaseUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isOllamaSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'ollama';
}

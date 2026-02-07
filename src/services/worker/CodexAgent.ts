/**
 * CodexAgent: Codex CLI-based observation extraction
 *
 * Uses `codex exec` to generate XML observations/summaries from queued messages.
 * This provider path is independent of the Anthropic Claude SDK.
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  isAbortError,
  type WorkerRef
} from './agents/index.js';

const DEFAULT_CODEX_MODEL = 'gpt-5';
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
const VALID_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

export interface CodexExecRequest {
  prompt: string;
  cwd: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  useOpenSourceProvider?: boolean;
  localProvider?: 'ollama';
  extraEnvironment?: Record<string, string>;
}

export interface CodexExecResult {
  content: string;
  tokensUsed?: number;
  rawOutput: string;
}

export type CodexExecRunner = (request: CodexExecRequest) => Promise<CodexExecResult>;

function resolveCodexBinaryPath(): string {
  const configuredPath = process.env.CODEX_CODE_PATH?.trim();
  return configuredPath || 'codex';
}

function parseTokensUsed(rawOutput: string): number | undefined {
  const tokenMatch = rawOutput.match(/tokens used\s+([\d,]+)/i);
  if (!tokenMatch) return undefined;

  const normalized = tokenMatch[1].replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildPromptFromConversation(history: ConversationMessage[]): string {
  return history
    .map((message, index) => {
      const roleLabel = message.role === 'assistant' ? 'assistant' : 'user';
      return `# Message ${index + 1} (${roleLabel})\n${message.content}`;
    })
    .join('\n\n');
}

function summarizeOutputForError(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  if (!trimmed) return '(no codex output)';
  const lines = trimmed.split('\n');
  return lines.slice(-20).join('\n');
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export async function runCodexExecCommand(request: CodexExecRequest): Promise<CodexExecResult> {
  const tempDirectoryPath = mkdtempSync(join(tmpdir(), 'codex-mem-codex-'));
  const outputFilePath = join(tempDirectoryPath, 'last-message.txt');
  const codexBinaryPath = resolveCodexBinaryPath();

  const args = [
    'exec',
    '--skip-git-repo-check',
    '-m',
    request.model,
    '-c',
    `model_reasoning_effort="${request.reasoningEffort}"`,
    '--output-last-message',
    outputFilePath,
    request.prompt
  ];

  if (request.useOpenSourceProvider) {
    args.splice(2, 0, '--oss');
  }

  if (request.localProvider) {
    args.splice(3, 0, '--local-provider', request.localProvider);
  }

  return await new Promise<CodexExecResult>((resolve, reject) => {
    const childProcess = spawn(codexBinaryPath, args, {
      cwd: request.cwd,
      env: {
        ...process.env,
        ...(request.extraEnvironment || {})
      }
    });

    let stdout = '';
    let stderr = '';
    let didTimeout = false;

    const cleanup = () => {
      try {
        rmSync(tempDirectoryPath, { recursive: true, force: true });
      } catch {
        // Cleanup best-effort only.
      }
    };

    const timeoutHandle = setTimeout(() => {
      didTimeout = true;
      childProcess.kill('SIGTERM');
    }, request.timeoutMs);

    childProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    childProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    childProcess.on('error', (error) => {
      clearTimeout(timeoutHandle);
      cleanup();
      reject(error);
    });

    childProcess.on('close', (exitCode) => {
      clearTimeout(timeoutHandle);
      const rawOutput = `${stdout}\n${stderr}`.trim();
      const content = existsSync(outputFilePath) ? readFileSync(outputFilePath, 'utf-8').trim() : '';
      cleanup();

      if (didTimeout) {
        reject(new Error(`Codex CLI timed out after ${request.timeoutMs}ms`));
        return;
      }

      if (exitCode !== 0) {
        reject(new Error(`Codex CLI failed with exit code ${exitCode}: ${summarizeOutputForError(rawOutput)}`));
        return;
      }

      resolve({
        content,
        tokensUsed: parseTokensUsed(rawOutput),
        rawOutput
      });
    });
  });
}

interface CodexConfig {
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  useOpenSourceProvider?: boolean;
  localProvider?: 'ollama';
  extraEnvironment?: Record<string, string>;
}

export class CodexAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private codexExecRunner: CodexExecRunner;

  constructor(
    dbManager: DatabaseManager,
    sessionManager: SessionManager,
    codexExecRunner: CodexExecRunner = runCodexExecCommand
  ) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
    this.codexExecRunner = codexExecRunner;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      this.ensureMemorySessionId(session);
      const mode = ModeManager.getInstance().getActiveMode();
      const codexConfig = this.getCodexConfig();

      ensureDir(OBSERVER_SESSIONS_DIR);

      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initialResponse = await this.queryCodexMultiTurn(session.conversationHistory, codexConfig, OBSERVER_SESSIONS_DIR);

      if (initialResponse.content) {
        session.conversationHistory.push({ role: 'assistant', content: initialResponse.content });
        this.applyTokenEstimate(session, initialResponse.tokensUsed);

        await processAgentResponse(
          initialResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          initialResponse.tokensUsed || 0,
          null,
          'Codex'
        );
      }

      let lastCwd: string | undefined;
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        if (message.cwd) lastCwd = message.cwd;
        const processingCwd = lastCwd || OBSERVER_SESSIONS_DIR;
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
          const observationResponse = await this.queryCodexMultiTurn(session.conversationHistory, codexConfig, processingCwd);

          if (observationResponse.content) {
            session.conversationHistory.push({ role: 'assistant', content: observationResponse.content });
          }
          this.applyTokenEstimate(session, observationResponse.tokensUsed);

          await processAgentResponse(
            observationResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            observationResponse.tokensUsed || 0,
            originalTimestamp,
            'Codex',
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
          const summaryResponse = await this.queryCodexMultiTurn(session.conversationHistory, codexConfig, processingCwd);
          const normalizedSummaryResponse = this.normalizeSummaryResponse(
            summaryResponse.content || '',
            message.last_assistant_message || '',
            session.userPrompt
          );

          if (summaryResponse.content) {
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
          }
          this.applyTokenEstimate(session, summaryResponse.tokensUsed);

          await processAgentResponse(
            normalizedSummaryResponse,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            summaryResponse.tokensUsed || 0,
            originalTimestamp,
            'Codex',
            lastCwd
          );
        }
      }

      const sessionDurationMs = Date.now() - session.startTime;
      logger.success('SDK', 'Codex agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDurationMs / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Codex agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      logger.failure('SDK', 'Codex agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  private ensureMemorySessionId(session: ActiveSession): void {
    if (session.memorySessionId) return;

    const syntheticMemorySessionId = `codex-worker-${session.contentSessionId}`;
    session.memorySessionId = syntheticMemorySessionId;
    this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);

    logger.info('SESSION', 'Codex provider initialized synthetic memory session ID', {
      sessionId: session.sessionDbId,
      memorySessionId: syntheticMemorySessionId
    });
  }

  private applyTokenEstimate(session: ActiveSession, totalTokensUsed?: number): void {
    if (!totalTokensUsed || totalTokensUsed <= 0) return;

    // Codex CLI returns total token usage. We estimate a split for existing metrics.
    const inputEstimate = Math.floor(totalTokensUsed * 0.7);
    const outputEstimate = Math.max(0, totalTokensUsed - inputEstimate);
    session.cumulativeInputTokens += inputEstimate;
    session.cumulativeOutputTokens += outputEstimate;
  }

  private async queryCodexMultiTurn(
    history: ConversationMessage[],
    codexConfig: CodexConfig,
    cwd: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    const combinedPrompt = buildPromptFromConversation(history);

    logger.debug('SDK', 'Querying Codex CLI with multi-turn context', {
      turns: history.length,
      model: codexConfig.model,
      reasoningEffort: codexConfig.reasoningEffort,
      cwd
    });

    const result = await this.codexExecRunner({
      prompt: combinedPrompt,
      cwd,
      model: codexConfig.model,
      reasoningEffort: codexConfig.reasoningEffort,
      timeoutMs: codexConfig.timeoutMs,
      useOpenSourceProvider: codexConfig.useOpenSourceProvider,
      localProvider: codexConfig.localProvider,
      extraEnvironment: codexConfig.extraEnvironment
    });

    return {
      content: result.content,
      tokensUsed: result.tokensUsed
    };
  }

  private normalizeSummaryResponse(rawResponse: string, lastAssistantMessage: string, userPrompt: string): string {
    const trimmedResponse = rawResponse.trim();

    if (trimmedResponse.includes('<summary>') && trimmedResponse.includes('</summary>')) {
      return trimmedResponse;
    }

    const summarySource = (lastAssistantMessage.trim() || trimmedResponse || userPrompt.trim() || 'No summary content available.').trim();

    logger.warn('SDK', 'Codex summarize response lacked XML; using fallback summary structure', {
      sourceLength: summarySource.length
    });

    const escapedUserPrompt = escapeXml(userPrompt.trim() || 'Session summary');
    const escapedSummarySource = escapeXml(summarySource);

    return `<summary>
  <request>${escapedUserPrompt}</request>
  <investigated>${escapedSummarySource}</investigated>
  <learned>${escapedSummarySource}</learned>
  <completed>${escapedSummarySource}</completed>
  <next_steps>Continue from the latest assistant output.</next_steps>
  <notes>Fallback summary generated from unstructured Codex output.</notes>
</summary>`;
  }

  private getCodexConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const configuredProvider = settings.CLAUDE_MEM_PROVIDER;
    const ollamaMode = settings.CLAUDE_MEM_OLLAMA_MODE;

    const configuredModel = (settings.CLAUDE_MEM_CODEX_MODEL || DEFAULT_CODEX_MODEL).trim();
    let model = configuredModel || DEFAULT_CODEX_MODEL;

    const configuredReasoning = (settings.CLAUDE_MEM_CODEX_REASONING_EFFORT || DEFAULT_REASONING_EFFORT).trim();
    const reasoningEffort = VALID_REASONING_EFFORTS.has(configuredReasoning)
      ? configuredReasoning
      : DEFAULT_REASONING_EFFORT;

    let useOpenSourceProvider = false;
    let localProvider: 'ollama' | undefined;
    let extraEnvironment: Record<string, string> | undefined;

    if (configuredProvider === 'ollama' && ollamaMode === 'codex_bridge') {
      const ollamaModel = (settings.CLAUDE_MEM_OLLAMA_MODEL || model).trim();
      model = ollamaModel || model;

      useOpenSourceProvider = true;
      localProvider = 'ollama';

      const ollamaHost = (settings.CLAUDE_MEM_OLLAMA_BASE_URL || '').trim();
      if (ollamaHost) {
        extraEnvironment = { OLLAMA_HOST: ollamaHost };
      }
    }

    return {
      model,
      reasoningEffort,
      timeoutMs: DEFAULT_CODEX_TIMEOUT_MS,
      useOpenSourceProvider,
      localProvider,
      extraEnvironment
    };
  }
}

export function isCodexAvailable(): boolean {
  const codexBinaryPath = resolveCodexBinaryPath();
  const versionCheckResult = spawnSync(codexBinaryPath, ['--version'], {
    stdio: 'pipe',
    encoding: 'utf-8'
  });
  return versionCheckResult.status === 0;
}

export function isCodexSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'codex';
}

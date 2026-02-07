import { basename } from 'path';

export interface CodexHistoryRecord {
  session_id: string;
  ts: number;
  text: string;
}

export interface ParsedCodexHistoryRecord extends CodexHistoryRecord {
  lineNumber: number;
  workspacePath?: string;
}

export interface CodexIngestionState {
  historyPath: string;
  lastProcessedLineNumber: number;
  updatedAt: string;
}

export interface CodexRecordSelectionOptions {
  historyPath: string;
  includeSystem: boolean;
  previousState?: CodexIngestionState | null;
  sinceTs?: number;
  limit?: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface CodexSummaryRequest {
  contentSessionId: string;
  lastAssistantMessage: string;
}

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isSystemRecord(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  return (
    trimmed.startsWith('⚠') ||
    trimmed.startsWith('[experimental]') ||
    trimmed.includes('MCP startup incomplete') ||
    (trimmed.includes('MCP client') && trimmed.includes('timed out'))
  );
}

interface CodexSessionMetaLine {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
  };
}

interface CodexSessionEventLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    message?: string;
  };
}

interface CodexResponseItemOutputText {
  type?: string;
  text?: string;
}

interface CodexResponseItemLine {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    content?: CodexResponseItemOutputText[];
  };
}

function parseTimestampToUnixSeconds(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) return 0;
  return Math.floor(millis / 1000);
}

export function parseHistoryFileContents(content: string): ParsedCodexHistoryRecord[] {
  const lines = content.split('\n');
  const parsedRecords: ParsedCodexHistoryRecord[] = [];
  let currentSessionId: string | null = null;
  let currentWorkspacePath: string | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;

    try {
      const parsedJson = JSON.parse(line) as Partial<CodexHistoryRecord> & CodexSessionMetaLine & CodexSessionEventLine;

      // Legacy Codex history.jsonl format
      if (parsedJson.session_id !== undefined && parsedJson.text !== undefined && parsedJson.ts !== undefined) {
        parsedRecords.push({
          session_id: String(parsedJson.session_id),
          text: String(parsedJson.text),
          ts: Number(parsedJson.ts),
          lineNumber: index + 1
        });
        continue;
      }

      // New Codex session transcript format:
      // 1) session_meta line with session id
      if (
        parsedJson.type === 'session_meta' &&
        parsedJson.payload &&
        typeof parsedJson.payload.id === 'string' &&
        parsedJson.payload.id.trim().length > 0
      ) {
        currentSessionId = parsedJson.payload.id.trim();
        currentWorkspacePath =
          typeof parsedJson.payload.cwd === 'string' && parsedJson.payload.cwd.trim().length > 0
            ? parsedJson.payload.cwd.trim()
            : undefined;
        continue;
      }

      // 2) event_msg line for user messages
      if (
        parsedJson.type === 'event_msg' &&
        parsedJson.payload &&
        parsedJson.payload.type === 'user_message' &&
        typeof parsedJson.payload.message === 'string' &&
        currentSessionId
      ) {
        const messageText = parsedJson.payload.message.trim();
        if (!messageText) continue;

        const parsedRecord: ParsedCodexHistoryRecord = {
          session_id: currentSessionId,
          text: messageText,
          ts: parseTimestampToUnixSeconds(parsedJson.timestamp),
          lineNumber: index + 1
        };
        if (currentWorkspacePath) {
          parsedRecord.workspacePath = currentWorkspacePath;
        }

        parsedRecords.push(parsedRecord);
      }
    } catch {
      // Skip malformed lines for ingestion robustness.
    }
  }

  return parsedRecords;
}

export function parseLastAssistantMessagesFromTranscript(content: string): Map<string, string> {
  const lines = content.split('\n');
  const lastAssistantMessageBySession = new Map<string, string>();
  const lastFinalAssistantMessageBySession = new Map<string, string>();
  let currentSessionId: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;

    try {
      const parsedJson = JSON.parse(line) as CodexSessionMetaLine & CodexSessionEventLine & CodexResponseItemLine;

      if (
        parsedJson.type === 'session_meta' &&
        parsedJson.payload &&
        typeof parsedJson.payload.id === 'string' &&
        parsedJson.payload.id.trim().length > 0
      ) {
        currentSessionId = parsedJson.payload.id.trim();
        continue;
      }

      if (
        parsedJson.type === 'event_msg' &&
        parsedJson.payload &&
        parsedJson.payload.type === 'agent_message' &&
        typeof parsedJson.payload.message === 'string' &&
        currentSessionId
      ) {
        const assistantMessage = parsedJson.payload.message.trim();
        if (!assistantMessage) continue;
        lastAssistantMessageBySession.set(currentSessionId, assistantMessage);
      }

      if (
        parsedJson.type === 'response_item' &&
        parsedJson.payload &&
        parsedJson.payload.type === 'message' &&
        parsedJson.payload.role === 'assistant' &&
        Array.isArray(parsedJson.payload.content) &&
        currentSessionId
      ) {
        const responseItemMessage = parsedJson.payload.content
          .map(contentItem => {
            if (!contentItem || contentItem.type !== 'output_text') return '';
            if (typeof contentItem.text !== 'string') return '';
            return contentItem.text.trim();
          })
          .filter(Boolean)
          .join('\n')
          .trim();

        if (!responseItemMessage) continue;
        lastAssistantMessageBySession.set(currentSessionId, responseItemMessage);

        if (parsedJson.payload.phase === 'final_answer') {
          lastFinalAssistantMessageBySession.set(currentSessionId, responseItemMessage);
        }
      }
    } catch {
      // Skip malformed lines for ingestion robustness.
    }
  }

  // Prefer substantive final answers over commentary/status updates when both exist.
  for (const [sessionId, finalAnswerMessage] of lastFinalAssistantMessageBySession.entries()) {
    lastAssistantMessageBySession.set(sessionId, finalAnswerMessage);
  }

  return lastAssistantMessageBySession;
}

export function selectRecordsForIngestion(
  rawRecords: ParsedCodexHistoryRecord[],
  options: CodexRecordSelectionOptions
): ParsedCodexHistoryRecord[] {
  let selectedRecords = rawRecords;

  if (!options.includeSystem) {
    selectedRecords = selectedRecords.filter(record => !isSystemRecord(record.text));
  }

  if (
    options.previousState &&
    options.previousState.historyPath === options.historyPath
  ) {
    selectedRecords = selectedRecords.filter(
      record => record.lineNumber > options.previousState!.lastProcessedLineNumber
    );
  }

  if (options.sinceTs !== undefined) {
    selectedRecords = selectedRecords.filter(record => record.ts >= options.sinceTs!);
  }

  selectedRecords = [...selectedRecords].sort((left, right) => left.lineNumber - right.lineNumber);

  if (options.limit !== undefined) {
    selectedRecords = selectedRecords.slice(0, options.limit);
  }

  return selectedRecords;
}

export function toContentSessionId(sessionId: string): string {
  return `codex-${sessionId}`;
}

export function resolveWorkspacePathForRecord(
  record: ParsedCodexHistoryRecord,
  fallbackWorkspacePath: string
): string {
  const recordWorkspacePath = record.workspacePath?.trim();
  if (recordWorkspacePath) {
    return recordWorkspacePath;
  }
  return fallbackWorkspacePath;
}

export function workspacePathToProjectName(workspacePath: string): string {
  return basename(workspacePath);
}

export function buildSummaryRequests(
  records: ParsedCodexHistoryRecord[],
  lastAssistantMessageBySession: ReadonlyMap<string, string> = new Map()
): CodexSummaryRequest[] {
  const lastRecordBySession = new Map<string, ParsedCodexHistoryRecord>();

  for (const record of records) {
    if (!record.text.trim()) continue;
    lastRecordBySession.set(record.session_id, record);
  }

  return Array.from(lastRecordBySession.values())
    .sort((left, right) => left.ts - right.ts)
    .map(record => {
      const fallbackMessage = record.text.trim();
      const parsedAssistantMessage = lastAssistantMessageBySession.get(record.session_id)?.trim() || '';

      return {
        contentSessionId: toContentSessionId(record.session_id),
        lastAssistantMessage: parsedAssistantMessage || fallbackMessage,
      };
    });
}

export function shouldRetryStatus(statusCode: number): boolean {
  return RETRYABLE_STATUS_CODES.has(statusCode);
}

export function calculateRetryDelayMs(attempt: number, baseDelayMs: number): number {
  // attempt is 1-based. Delay grows exponentially: base, 2*base, 4*base...
  return baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
}

export async function postJsonWithRetry<T>(
  url: string,
  body: unknown,
  retryPolicy: RetryPolicy,
  fetchFn: typeof fetch = fetch,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms))
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const responseText = await response.text();
        const responseError = new Error(`${response.status} ${response.statusText}: ${responseText}`);
        const retryableStatus = shouldRetryStatus(response.status);
        if (!retryableStatus || attempt === retryPolicy.maxAttempts) {
          throw responseError;
        }
        lastError = responseError;
      } else {
        return await response.json() as T;
      }
    } catch (error) {
      const parsedError = error instanceof Error ? error : new Error(String(error));
      lastError = parsedError;

      // Non-retryable HTTP statuses should fail immediately.
      const statusCodeMatch = parsedError.message.match(/^(\d{3})\s/);
      if (statusCodeMatch) {
        const statusCode = Number(statusCodeMatch[1]);
        if (!shouldRetryStatus(statusCode)) {
          throw parsedError;
        }
      }

      if (attempt === retryPolicy.maxAttempts) {
        break;
      }
    }

    const delayMs = calculateRetryDelayMs(attempt, retryPolicy.baseDelayMs);
    await sleepFn(delayMs);
  }

  throw lastError ?? new Error('Request failed after retries');
}

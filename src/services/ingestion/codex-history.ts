export interface CodexHistoryRecord {
  session_id: string;
  ts: number;
  text: string;
}

export interface ParsedCodexHistoryRecord extends CodexHistoryRecord {
  lineNumber: number;
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

export function parseHistoryFileContents(content: string): ParsedCodexHistoryRecord[] {
  const lines = content.split('\n');
  const parsedRecords: ParsedCodexHistoryRecord[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;

    try {
      const parsedJson = JSON.parse(line) as Partial<CodexHistoryRecord>;
      if (parsedJson.session_id === undefined || parsedJson.text === undefined || parsedJson.ts === undefined) continue;

      parsedRecords.push({
        session_id: String(parsedJson.session_id),
        text: String(parsedJson.text),
        ts: Number(parsedJson.ts),
        lineNumber: index + 1
      });
    } catch {
      // Skip malformed lines for ingestion robustness.
    }
  }

  return parsedRecords;
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

export function buildSummaryRequests(records: ParsedCodexHistoryRecord[]): CodexSummaryRequest[] {
  const lastRecordBySession = new Map<string, ParsedCodexHistoryRecord>();

  for (const record of records) {
    if (!record.text.trim()) continue;
    lastRecordBySession.set(record.session_id, record);
  }

  return Array.from(lastRecordBySession.values())
    .sort((left, right) => left.ts - right.ts)
    .map(record => ({
      contentSessionId: toContentSessionId(record.session_id),
      lastAssistantMessage: record.text.trim(),
    }));
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

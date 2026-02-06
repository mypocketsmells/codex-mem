import { describe, it, expect, mock } from 'bun:test';
import {
  buildSummaryRequests,
  parseHistoryFileContents,
  postJsonWithRetry,
  selectRecordsForIngestion
} from '../../src/services/ingestion/codex-history.js';

describe('codex history ingestion helpers', () => {
  it('parses valid JSONL records and skips malformed lines', () => {
    const content = [
      '{"session_id":"s-1","ts":1000,"text":"first"}',
      'not-json',
      '{"session_id":"s-1","ts":1001,"text":"second"}',
      '{"session_id":"s-2","text":"missing-ts"}',
      '',
    ].join('\n');

    const parsed = parseHistoryFileContents(content);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      session_id: 's-1',
      ts: 1000,
      text: 'first',
      lineNumber: 1,
    });
    expect(parsed[1].lineNumber).toBe(3);
  });

  it('filters records by checkpoint, since, and limit', () => {
    const rawRecords = [
      { session_id: 's-1', ts: 10, text: 'a', lineNumber: 1 },
      { session_id: 's-1', ts: 20, text: 'b', lineNumber: 2 },
      { session_id: 's-2', ts: 30, text: 'c', lineNumber: 3 },
      { session_id: 's-2', ts: 40, text: 'd', lineNumber: 4 },
    ];

    const selected = selectRecordsForIngestion(rawRecords, {
      historyPath: '/tmp/history.jsonl',
      includeSystem: true,
      previousState: {
        historyPath: '/tmp/history.jsonl',
        lastProcessedLineNumber: 1,
        updatedAt: new Date(0).toISOString(),
      },
      sinceTs: 20,
      limit: 2,
    });

    expect(selected.map(record => record.lineNumber)).toEqual([2, 3]);
  });

  it('builds one summary request per session using the last session record', () => {
    const records = [
      { session_id: 's-1', ts: 10, text: 'hello', lineNumber: 1 },
      { session_id: 's-2', ts: 20, text: 'alpha', lineNumber: 2 },
      { session_id: 's-1', ts: 30, text: 'goodbye', lineNumber: 3 },
    ];

    const summaries = buildSummaryRequests(records);

    expect(summaries).toEqual([
      { contentSessionId: 'codex-s-2', lastAssistantMessage: 'alpha' },
      { contentSessionId: 'codex-s-1', lastAssistantMessage: 'goodbye' },
    ]);
  });

  it('retries transient HTTP failures and eventually succeeds', async () => {
    let attemptCount = 0;
    const fetchMock = mock(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => 'temporary',
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ success: true }),
      } as Response;
    });

    const sleepCalls: number[] = [];
    const result = await postJsonWithRetry<{ success: boolean }>(
      'http://localhost/test',
      { ping: true },
      { maxAttempts: 3, baseDelayMs: 5 },
      fetchMock as unknown as typeof fetch,
      async (ms) => { sleepCalls.push(ms); }
    );

    expect(result.success).toBe(true);
    expect(attemptCount).toBe(3);
    expect(sleepCalls).toEqual([5, 10]);
  });

  it('does not retry non-retryable HTTP errors', async () => {
    let attemptCount = 0;
    const fetchMock = mock(async () => {
      attemptCount++;
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'invalid',
      } as Response;
    });

    await expect(postJsonWithRetry(
      'http://localhost/test',
      { ping: true },
      { maxAttempts: 4, baseDelayMs: 5 },
      fetchMock as unknown as typeof fetch,
      async () => {}
    )).rejects.toThrow('400 Bad Request: invalid');

    expect(attemptCount).toBe(1);
  });
});

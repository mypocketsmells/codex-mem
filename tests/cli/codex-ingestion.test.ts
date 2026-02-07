import { afterEach, describe, it, expect, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import {
  buildSummaryRequests,
  parseHistoryFileContents,
  parseLastAssistantMessagesFromTranscript,
  postJsonWithRetry,
  resolveWorkspacePathForRecord,
  selectRecordsForIngestion,
  workspacePathToProjectName
} from '../../src/services/ingestion/codex-history.js';
import {
  loadCodexIngestionCheckpointState,
  saveCodexIngestionCheckpointState
} from '../../src/services/ingestion/CodexHistoryIngestor.js';

const temporaryDirectoriesToCleanup: string[] = [];

afterEach(() => {
  while (temporaryDirectoriesToCleanup.length > 0) {
    const tempDirectoryPath = temporaryDirectoriesToCleanup.pop();
    if (!tempDirectoryPath) continue;
    rmSync(tempDirectoryPath, { recursive: true, force: true });
  }
});

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

  it('parses codex session transcript format and keeps user_message entries only', () => {
    const transcriptContent = [
      '{"timestamp":"2026-02-06T07:07:46.842Z","type":"session_meta","payload":{"id":"session-abc"}}',
      '{"timestamp":"2026-02-06T07:07:47.000Z","type":"event_msg","payload":{"type":"agent_message","message":"ignore me"}}',
      '{"timestamp":"2026-02-06T07:07:48.000Z","type":"event_msg","payload":{"type":"user_message","message":"first prompt"}}',
      '{"timestamp":"2026-02-06T07:07:49.000Z","type":"event_msg","payload":{"type":"user_message","message":"   "}}',
      '{"timestamp":"2026-02-06T07:07:50.000Z","type":"session_meta","payload":{"id":"session-def"}}',
      '{"timestamp":"2026-02-06T07:07:51.000Z","type":"event_msg","payload":{"type":"user_message","message":"second prompt"}}'
    ].join('\n');

    const parsed = parseHistoryFileContents(transcriptContent);
    const firstTs = Math.floor(Date.parse('2026-02-06T07:07:48.000Z') / 1000);
    const secondTs = Math.floor(Date.parse('2026-02-06T07:07:51.000Z') / 1000);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      session_id: 'session-abc',
      ts: firstTs,
      text: 'first prompt',
      lineNumber: 3,
    });
    expect(parsed[1]).toEqual({
      session_id: 'session-def',
      ts: secondTs,
      text: 'second prompt',
      lineNumber: 6,
    });
  });

  it('captures workspacePath from session_meta payload cwd', () => {
    const transcriptContent = [
      '{"timestamp":"2026-02-06T07:07:46.842Z","type":"session_meta","payload":{"id":"session-abc","cwd":"/Users/me/project-one"}}',
      '{"timestamp":"2026-02-06T07:07:48.000Z","type":"event_msg","payload":{"type":"user_message","message":"first prompt"}}',
      '{"timestamp":"2026-02-06T07:07:50.000Z","type":"session_meta","payload":{"id":"session-def","cwd":"/Users/me/project-two"}}',
      '{"timestamp":"2026-02-06T07:07:51.000Z","type":"event_msg","payload":{"type":"user_message","message":"second prompt"}}'
    ].join('\n');

    const parsed = parseHistoryFileContents(transcriptContent);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].workspacePath).toBe('/Users/me/project-one');
    expect(parsed[1].workspacePath).toBe('/Users/me/project-two');
  });

  it('prefers record workspace path over fallback when resolving ingestion target workspace', () => {
    const recordWithWorkspacePath = {
      session_id: 'session-abc',
      ts: 10,
      text: 'hello',
      lineNumber: 1,
      workspacePath: '/Users/me/other-project'
    };

    const resolvedWorkspacePath = resolveWorkspacePathForRecord(
      recordWithWorkspacePath,
      '/Users/me/codex-mem'
    );

    expect(resolvedWorkspacePath).toBe('/Users/me/other-project');
    expect(workspacePathToProjectName(resolvedWorkspacePath)).toBe('other-project');
  });

  it('falls back to CLI workspace path when record workspace path is unavailable', () => {
    const recordWithoutWorkspacePath = {
      session_id: 'session-abc',
      ts: 10,
      text: 'hello',
      lineNumber: 1
    };

    const fallbackWorkspacePath = '/Users/me/codex-mem';
    const resolvedWorkspacePath = resolveWorkspacePathForRecord(
      recordWithoutWorkspacePath,
      fallbackWorkspacePath
    );

    expect(resolvedWorkspacePath).toBe(fallbackWorkspacePath);
    expect(workspacePathToProjectName(resolvedWorkspacePath)).toBe('codex-mem');
  });

  it('extracts latest assistant output from codex transcript events', () => {
    const transcriptContent = [
      '{"timestamp":"2026-02-06T07:07:46.842Z","type":"session_meta","payload":{"id":"session-abc"}}',
      '{"timestamp":"2026-02-06T07:07:47.000Z","type":"event_msg","payload":{"type":"agent_message","message":"first assistant"}}',
      '{"timestamp":"2026-02-06T07:07:48.000Z","type":"event_msg","payload":{"type":"agent_message","message":"second assistant"}}',
      '{"timestamp":"2026-02-06T07:07:50.000Z","type":"session_meta","payload":{"id":"session-def"}}',
      '{"timestamp":"2026-02-06T07:07:51.000Z","type":"event_msg","payload":{"type":"agent_message","message":"another session output"}}',
      '{"timestamp":"2026-02-06T07:07:52.000Z","type":"event_msg","payload":{"type":"user_message","message":"ignore me"}}'
    ].join('\n');

    const parsedAssistantMessages = parseLastAssistantMessagesFromTranscript(transcriptContent);

    expect(parsedAssistantMessages.get('session-abc')).toBe('second assistant');
    expect(parsedAssistantMessages.get('session-def')).toBe('another session output');
  });

  it('prefers response_item final answers over commentary event messages', () => {
    const transcriptContent = [
      '{"timestamp":"2026-02-06T07:07:46.842Z","type":"session_meta","payload":{"id":"session-abc"}}',
      '{"timestamp":"2026-02-06T07:07:47.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working on it"}}',
      '{"timestamp":"2026-02-06T07:07:48.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"final answer from response item"}]}}',
      '{"timestamp":"2026-02-06T07:07:49.000Z","type":"event_msg","payload":{"type":"agent_message","message":"next step commentary"}}'
    ].join('\n');

    const parsedAssistantMessages = parseLastAssistantMessagesFromTranscript(transcriptContent);
    expect(parsedAssistantMessages.get('session-abc')).toBe('final answer from response item');
  });

  it('produces non-empty observation and summary batches from a codex transcript', () => {
    const transcriptContent = [
      '{"timestamp":"2026-02-06T07:07:46.842Z","type":"session_meta","payload":{"id":"session-abc"}}',
      '{"timestamp":"2026-02-06T07:07:47.000Z","type":"event_msg","payload":{"type":"user_message","message":"first prompt"}}',
      '{"timestamp":"2026-02-06T07:07:48.000Z","type":"event_msg","payload":{"type":"user_message","message":"second prompt"}}',
      '{"timestamp":"2026-02-06T07:07:49.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"assistant final answer"}]}}'
    ].join('\n');

    const parsedRecords = parseHistoryFileContents(transcriptContent);
    const selectedRecords = selectRecordsForIngestion(parsedRecords, {
      historyPath: '/tmp/transcript.jsonl',
      includeSystem: true,
      previousState: null,
      limit: undefined,
      sinceTs: undefined
    });

    const lastAssistantMessageBySession = parseLastAssistantMessagesFromTranscript(transcriptContent);
    const summaryRequests = buildSummaryRequests(selectedRecords, lastAssistantMessageBySession);

    expect(selectedRecords.length).toBeGreaterThan(0);
    expect(summaryRequests.length).toBeGreaterThan(0);
    expect(summaryRequests[0]).toEqual({
      contentSessionId: 'codex-session-abc',
      lastAssistantMessage: 'assistant final answer'
    });
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

  it('prefers parsed assistant output when building summary requests', () => {
    const records = [
      { session_id: 's-1', ts: 10, text: 'user prompt', lineNumber: 1 },
      { session_id: 's-2', ts: 20, text: 'another prompt', lineNumber: 2 }
    ];

    const parsedAssistantMessages = new Map<string, string>([
      ['s-1', 'assistant answer'],
      ['s-2', 'assistant follow-up']
    ]);

    const summaries = buildSummaryRequests(records, parsedAssistantMessages);

    expect(summaries).toEqual([
      { contentSessionId: 'codex-s-1', lastAssistantMessage: 'assistant answer' },
      { contentSessionId: 'codex-s-2', lastAssistantMessage: 'assistant follow-up' },
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

  it('migrates legacy checkpoint state to fileCheckpoints map', () => {
    const tempDirectoryPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-state-migration-'));
    temporaryDirectoriesToCleanup.push(tempDirectoryPath);
    const stateFilePath = path.join(tempDirectoryPath, 'state.json');
    const historyPath = '/tmp/legacy-history.jsonl';

    writeFileSync(
      stateFilePath,
      JSON.stringify({
        historyPath,
        lastProcessedLineNumber: 42,
        updatedAt: new Date('2026-02-06T00:00:00.000Z').toISOString()
      }),
      'utf-8'
    );

    const state = loadCodexIngestionCheckpointState(stateFilePath);
    expect(state.fileCheckpoints[historyPath]).toBe(42);
  });

  it('saves checkpoint state with per-file map and legacy mirror fields', () => {
    const tempDirectoryPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-state-save-'));
    temporaryDirectoriesToCleanup.push(tempDirectoryPath);
    const stateFilePath = path.join(tempDirectoryPath, 'state.json');
    const primaryHistoryPath = '/tmp/history-one.jsonl';
    const secondaryHistoryPath = '/tmp/history-two.jsonl';

    saveCodexIngestionCheckpointState(
      stateFilePath,
      {
        fileCheckpoints: {
          [primaryHistoryPath]: 12,
          [secondaryHistoryPath]: 7
        },
        updatedAt: new Date('2026-02-06T00:00:00.000Z').toISOString()
      },
      {
        historyPath: primaryHistoryPath,
        lastProcessedLineNumber: 12
      }
    );

    const rawSavedState = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as {
      fileCheckpoints: Record<string, number>;
      historyPath: string;
      lastProcessedLineNumber: number;
    };

    expect(rawSavedState.fileCheckpoints[primaryHistoryPath]).toBe(12);
    expect(rawSavedState.fileCheckpoints[secondaryHistoryPath]).toBe(7);
    expect(rawSavedState.historyPath).toBe(primaryHistoryPath);
    expect(rawSavedState.lastProcessedLineNumber).toBe(12);
  });
});

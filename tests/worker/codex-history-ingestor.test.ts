import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import {
  discoverCodexSessionProjects,
  loadCodexIngestionCheckpointState,
  runCodexHistoryIngestion
} from '../../src/services/ingestion/CodexHistoryIngestor.js';

function createOkJsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload
  } as Response;
}

describe('CodexHistoryIngestor', () => {
  let sandboxRootPath: string | null = null;

  afterEach(() => {
    if (sandboxRootPath) {
      rmSync(sandboxRootPath, { recursive: true, force: true });
      sandboxRootPath = null;
    }
  });

  it('ingests multi-file transcripts and attributes project from per-record cwd', async () => {
    sandboxRootPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-ingestor-'));
    const transcriptFilePathOne = path.join(sandboxRootPath, 'session-one.jsonl');
    const transcriptFilePathTwo = path.join(sandboxRootPath, 'session-two.jsonl');
    const stateFilePath = path.join(sandboxRootPath, 'state.json');

    writeFileSync(
      transcriptFilePathOne,
      [
        '{"type":"session_meta","payload":{"id":"session-one","cwd":"/Users/dev/project-alpha"}}',
        '{"type":"event_msg","timestamp":"2026-02-06T10:00:00.000Z","payload":{"type":"user_message","message":"hello alpha"}}'
      ].join('\n'),
      'utf-8'
    );

    writeFileSync(
      transcriptFilePathTwo,
      [
        '{"type":"session_meta","payload":{"id":"session-two","cwd":"/Users/dev/project-beta"}}',
        '{"type":"event_msg","timestamp":"2026-02-06T10:01:00.000Z","payload":{"type":"user_message","message":"hello beta"}}'
      ].join('\n'),
      'utf-8'
    );

    const postedBodies: Array<{ url: string; body: any }> = [];
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      postedBodies.push({ url: String(url), body: parsedBody });
      return createOkJsonResponse({ ok: true });
    });

    const ingestionResult = await runCodexHistoryIngestion({
      historyPaths: [transcriptFilePathOne, transcriptFilePathTwo],
      workspacePath: '/fallback/workspace',
      includeSystem: false,
      skipSummaries: true,
      dryRun: false,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
      stateFilePath,
      port: 37777,
      ensureWorkerAvailableFn: async () => {},
      fetchFn: fetchMock as unknown as typeof fetch,
      sleepFn: async () => {}
    });

    expect(ingestionResult.selectedRecordCount).toBe(2);
    expect(ingestionResult.ingestedRecordCount).toBe(2);

    const initCalls = postedBodies.filter(entry => entry.url.endsWith('/api/sessions/init'));
    expect(initCalls).toHaveLength(2);
    expect(initCalls[0].body.project).toBe('project-alpha');
    expect(initCalls[1].body.project).toBe('project-beta');

    const observationCalls = postedBodies.filter(entry => entry.url.endsWith('/api/sessions/observations'));
    expect(observationCalls).toHaveLength(2);
    expect(observationCalls[0].body.cwd).toBe('/Users/dev/project-alpha');
    expect(observationCalls[1].body.cwd).toBe('/Users/dev/project-beta');

    const checkpointState = loadCodexIngestionCheckpointState(stateFilePath);
    expect(checkpointState.fileCheckpoints[transcriptFilePathOne]).toBe(2);
    expect(checkpointState.fileCheckpoints[transcriptFilePathTwo]).toBe(2);
  });

  it('migrates legacy single-file state into file checkpoints', async () => {
    sandboxRootPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-ingestor-'));
    const transcriptFilePath = path.join(sandboxRootPath, 'legacy-session.jsonl');
    const stateFilePath = path.join(sandboxRootPath, 'state.json');

    writeFileSync(
      transcriptFilePath,
      [
        '{"type":"session_meta","payload":{"id":"session-legacy","cwd":"/Users/dev/project-legacy"}}',
        '{"type":"event_msg","timestamp":"2026-02-06T10:00:00.000Z","payload":{"type":"user_message","message":"prompt one"}}',
        '{"type":"event_msg","timestamp":"2026-02-06T10:00:10.000Z","payload":{"type":"agent_message","message":"ignore"}}',
        '{"type":"event_msg","timestamp":"2026-02-06T10:00:20.000Z","payload":{"type":"user_message","message":"prompt two"}}'
      ].join('\n'),
      'utf-8'
    );

    writeFileSync(
      stateFilePath,
      JSON.stringify({
        historyPath: transcriptFilePath,
        lastProcessedLineNumber: 2,
        updatedAt: new Date('2026-02-06T10:00:30.000Z').toISOString()
      }),
      'utf-8'
    );

    const checkpointState = loadCodexIngestionCheckpointState(stateFilePath);
    expect(checkpointState.fileCheckpoints[transcriptFilePath]).toBe(2);

    const ingestionResult = await runCodexHistoryIngestion({
      historyPaths: [transcriptFilePath],
      workspacePath: '/fallback/workspace',
      includeSystem: false,
      skipSummaries: true,
      dryRun: true,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
      stateFilePath,
      port: 37777,
      ensureWorkerAvailableFn: async () => {}
    });

    expect(ingestionResult.selectedRecordCount).toBe(1);
    expect(ingestionResult.firstSelected?.lineNumber).toBe(4);
    expect(ingestionResult.lastSelected?.lineNumber).toBe(4);
  });

  it('discovers only ingestible projects with user messages', () => {
    sandboxRootPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-ingestor-'));
    const transcriptWithUserMessagePath = path.join(sandboxRootPath, 'session-with-user-message.jsonl');
    const metadataOnlyTranscriptPath = path.join(sandboxRootPath, 'session-metadata-only.jsonl');

    writeFileSync(
      transcriptWithUserMessagePath,
      [
        '{"type":"session_meta","payload":{"id":"session-with-user-message","cwd":"/Users/dev/project-ingestible"}}',
        '{"type":"event_msg","timestamp":"2026-02-06T10:00:00.000Z","payload":{"type":"user_message","message":"hello"}}'
      ].join('\n'),
      'utf-8'
    );

    writeFileSync(
      metadataOnlyTranscriptPath,
      [
        '{"type":"session_meta","payload":{"id":"session-metadata-only","cwd":"/Users/dev/project-metadata-only"}}'
      ].join('\n'),
      'utf-8'
    );

    const discoveryResult = discoverCodexSessionProjects(sandboxRootPath);
    expect(discoveryResult.discoveredSessionProjects).toContain('project-ingestible');
    expect(discoveryResult.discoveredSessionProjects).not.toContain('project-metadata-only');
    expect(discoveryResult.scannedFiles).toBe(2);
    expect(discoveryResult.lastScanEpochMs).toBeGreaterThan(0);
  });
});

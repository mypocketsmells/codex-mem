import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';
import {
  type RetryPolicy,
  type ParsedCodexHistoryRecord,
  type CodexIngestionState,
  buildSummaryRequests,
  parseHistoryFileContents,
  parseLastAssistantMessagesFromTranscript,
  postJsonWithRetry,
  resolveWorkspacePathForRecord,
  selectRecordsForIngestion,
  toContentSessionId,
  workspacePathToProjectName
} from './codex-history.js';
import { getCanonicalDataDirPath } from '../../shared/product-config.js';
import { getWorkerHost, getWorkerPort } from '../../shared/worker-utils.js';

export const CODEX_DEFAULT_HISTORY_PATH = join(homedir(), '.codex', 'history.jsonl');
export const CODEX_DEFAULT_SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');
export const CODEX_INGEST_STATE_FILE_NAME = 'codex-history-ingest-state.json';

interface HistoryRecordWithSource {
  historyPath: string;
  record: ParsedCodexHistoryRecord;
}

interface SelectedHistoryBatch {
  historyPath: string;
  selectedRecords: ParsedCodexHistoryRecord[];
  lastAssistantMessageBySession: Map<string, string>;
}

export interface CodexIngestionCheckpointState {
  fileCheckpoints: Record<string, number>;
  updatedAt: string;
  // Legacy compatibility fields.
  historyPath?: string;
  lastProcessedLineNumber?: number;
}

export interface CodexHistoryIngestionOptions {
  historyPaths: string[];
  workspacePath: string;
  includeSystem: boolean;
  skipSummaries: boolean;
  dryRun: boolean;
  retryPolicy: RetryPolicy;
  stateFilePath?: string;
  port?: number;
  workerHost?: string;
  sinceTs?: number;
  limit?: number;
  maxHistoryFiles?: number;
  ensureWorkerAvailableFn?: (port: number, host?: string) => Promise<void>;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface CodexHistoryIngestionResult {
  historyPaths: string[];
  stateFilePath: string;
  filesScanned: number;
  filesWithSelectedRecords: number;
  selectedRecordCount: number;
  ingestedRecordCount: number;
  stoppedAt?: { historyPath: string; lineNumber: number; message: string };
  summaryReport: {
    attempted: number;
    successful: number;
    failedSessionIds: string[];
  };
  sessionCountInBatch: number;
  firstSelected?: { historyPath: string; lineNumber: number };
  lastSelected?: { historyPath: string; lineNumber: number };
  updatedCheckpoints: Record<string, number>;
}

export interface CodexSessionProjectDiscoveryResult {
  discoveredSessionProjects: string[];
  scannedFiles: number;
  lastScanEpochMs: number;
}

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}

function buildWorkerBaseUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
}

function listJsonlFilesRecursive(directoryPath: string): string[] {
  if (!existsSync(directoryPath)) return [];

  const pendingPaths: string[] = [directoryPath];
  const jsonlFilePaths: string[] = [];

  while (pendingPaths.length > 0) {
    const currentPath = pendingPaths.pop();
    if (!currentPath || !existsSync(currentPath)) continue;

    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pendingPaths.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        jsonlFilePaths.push(fullPath);
      }
    }
  }

  return jsonlFilePaths;
}

function sortHistoryPathsByMtime(historyPaths: string[]): string[] {
  return [...historyPaths].sort((leftPath, rightPath) => {
    const leftStat = statSync(leftPath);
    const rightStat = statSync(rightPath);
    return leftStat.mtimeMs - rightStat.mtimeMs;
  });
}

export function resolveCodexSessionsRoot(): string {
  const configuredRoot = process.env.CODEX_MEM_CODEX_SESSIONS_DIR;
  if (configuredRoot && configuredRoot.trim().length > 0) {
    return configuredRoot.trim();
  }
  return CODEX_DEFAULT_SESSIONS_ROOT;
}

export function resolveDefaultCodexHistoryPaths(): string[] {
  const sessionsRoot = resolveCodexSessionsRoot();
  const sessionHistoryPaths = sortHistoryPathsByMtime(listJsonlFilesRecursive(sessionsRoot));
  if (sessionHistoryPaths.length > 0) {
    return sessionHistoryPaths;
  }
  return existsSync(CODEX_DEFAULT_HISTORY_PATH) ? [CODEX_DEFAULT_HISTORY_PATH] : [];
}

export function getCodexIngestionStateFilePath(): string {
  const configuredDataDir = process.env.CODEX_MEM_DATA_DIR || process.env.CLAUDE_MEM_DATA_DIR;
  const dataDir = configuredDataDir && configuredDataDir.trim().length > 0
    ? configuredDataDir
    : getCanonicalDataDirPath();
  return join(dataDir, CODEX_INGEST_STATE_FILE_NAME);
}

function normalizeCheckpointValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

export function loadCodexIngestionCheckpointState(stateFilePath: string): CodexIngestionCheckpointState {
  const emptyState: CodexIngestionCheckpointState = {
    fileCheckpoints: {},
    updatedAt: new Date(0).toISOString()
  };

  if (!existsSync(stateFilePath)) return emptyState;

  try {
    const parsed = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as Partial<
      CodexIngestionCheckpointState & CodexIngestionState
    >;

    const fileCheckpoints: Record<string, number> = {};

    if (parsed.fileCheckpoints && typeof parsed.fileCheckpoints === 'object') {
      for (const [historyPath, lineNumber] of Object.entries(parsed.fileCheckpoints)) {
        if (!historyPath) continue;
        const normalized = normalizeCheckpointValue(lineNumber);
        if (normalized === null) continue;
        fileCheckpoints[historyPath] = normalized;
      }
    }

    // Legacy format migration: single historyPath + line checkpoint.
    if (
      typeof parsed.historyPath === 'string' &&
      parsed.historyPath.trim().length > 0 &&
      normalizeCheckpointValue(parsed.lastProcessedLineNumber) !== null
    ) {
      const normalizedLineNumber = normalizeCheckpointValue(parsed.lastProcessedLineNumber)!;
      fileCheckpoints[parsed.historyPath.trim()] = normalizedLineNumber;
    }

    return {
      fileCheckpoints,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      historyPath: typeof parsed.historyPath === 'string' ? parsed.historyPath : undefined,
      lastProcessedLineNumber: normalizeCheckpointValue(parsed.lastProcessedLineNumber) ?? undefined
    };
  } catch {
    return emptyState;
  }
}

export function saveCodexIngestionCheckpointState(
  stateFilePath: string,
  state: CodexIngestionCheckpointState,
  legacyMirror?: { historyPath: string; lastProcessedLineNumber: number }
): void {
  const outputState: CodexIngestionCheckpointState = {
    fileCheckpoints: state.fileCheckpoints,
    updatedAt: state.updatedAt
  };

  if (legacyMirror) {
    outputState.historyPath = legacyMirror.historyPath;
    outputState.lastProcessedLineNumber = legacyMirror.lastProcessedLineNumber;
  }

  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(outputState, null, 2), 'utf-8');
}

export async function isWorkerHealthy(port: number, host: string = 'localhost'): Promise<boolean> {
  try {
    const response = await fetch(`${buildWorkerBaseUrl(host, port)}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureWorkerAvailable(port: number, host: string = 'localhost'): Promise<void> {
  if (await isWorkerHealthy(port, host)) return;

  const startResult = spawnSync(
    process.platform === 'win32' ? 'bun.exe' : 'bun',
    ['plugin/scripts/worker-service.cjs', 'start'],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe'
    }
  );

  if (startResult.status !== 0) {
    throw new Error(`Failed to start worker: ${startResult.stderr || startResult.stdout || 'unknown error'}`);
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    if (await isWorkerHealthy(port, host)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error('Worker did not become healthy after startup attempt');
}

async function ingestObservationRecord(
  historyRecordWithSource: HistoryRecordWithSource,
  workspacePathFallback: string,
  port: number,
  workerHost: string,
  retryPolicy: RetryPolicy,
  fetchFn: typeof fetch,
  sleepFn: (ms: number) => Promise<void>
): Promise<void> {
  const { record, historyPath } = historyRecordWithSource;
  const baseUrl = buildWorkerBaseUrl(workerHost, port);
  const contentSessionId = toContentSessionId(record.session_id);
  const resolvedWorkspacePath = resolveWorkspacePathForRecord(record, workspacePathFallback);
  const project = workspacePathToProjectName(resolvedWorkspacePath);
  const promptText = record.text.trim();

  if (!promptText) return;

  await postJsonWithRetry(
    `${baseUrl}/api/sessions/init`,
    {
      contentSessionId,
      project,
      prompt: promptText,
      platform: 'codex'
    },
    retryPolicy,
    fetchFn,
    sleepFn
  );

  await postJsonWithRetry(
    `${baseUrl}/api/sessions/observations`,
    {
      contentSessionId,
      tool_name: 'CodexHistoryEntry',
      tool_input: {
        source: historyPath,
        line_number: record.lineNumber,
        timestamp: record.ts
      },
      tool_response: {
        text: promptText
      },
      cwd: resolvedWorkspacePath
    },
    retryPolicy,
    fetchFn,
    sleepFn
  );
}

async function ingestSummaries(
  ingestedHistoryRecords: HistoryRecordWithSource[],
  lastAssistantMessageBySession: ReadonlyMap<string, string>,
  port: number,
  workerHost: string,
  retryPolicy: RetryPolicy,
  fetchFn: typeof fetch,
  sleepFn: (ms: number) => Promise<void>
): Promise<{ attempted: number; successful: number; failedSessionIds: string[] }> {
  const ingestedRecords = ingestedHistoryRecords.map(entry => entry.record);
  const summaries = buildSummaryRequests(ingestedRecords, lastAssistantMessageBySession);
  const baseUrl = buildWorkerBaseUrl(workerHost, port);

  let successful = 0;
  const failedSessionIds: string[] = [];

  for (const summary of summaries) {
    try {
      await postJsonWithRetry(
        `${baseUrl}/api/sessions/summarize`,
        {
          contentSessionId: summary.contentSessionId,
          last_assistant_message: summary.lastAssistantMessage,
        },
        retryPolicy,
        fetchFn,
        sleepFn
      );
      successful++;
    } catch {
      failedSessionIds.push(summary.contentSessionId);
    }
  }

  return {
    attempted: summaries.length,
    successful,
    failedSessionIds
  };
}

export async function runCodexHistoryIngestion(options: CodexHistoryIngestionOptions): Promise<CodexHistoryIngestionResult> {
  const stateFilePath = options.stateFilePath || getCodexIngestionStateFilePath();
  const checkpointState = loadCodexIngestionCheckpointState(stateFilePath);
  const fetchFn = options.fetchFn || fetch;
  const sleepFn = options.sleepFn || (async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms)));
  const ensureWorker = options.ensureWorkerAvailableFn || ensureWorkerAvailable;
  const workerPort = typeof options.port === 'number' ? options.port : getWorkerPort();
  const workerHost = options.workerHost?.trim() || getWorkerHost();

  const requestedHistoryPaths = options.maxHistoryFiles && options.maxHistoryFiles > 0
    ? options.historyPaths.slice(-options.maxHistoryFiles)
    : options.historyPaths;
  const existingHistoryPaths = requestedHistoryPaths.filter(historyPath => existsSync(historyPath));
  const orderedHistoryPaths = sortHistoryPathsByMtime(existingHistoryPaths);

  const selectedBatches: SelectedHistoryBatch[] = [];
  let remainingLimit = options.limit;

  for (const historyPath of orderedHistoryPaths) {
    if (remainingLimit !== undefined && remainingLimit <= 0) break;

    const historyContents = readFileSync(historyPath, 'utf-8');
    const rawRecords = parseHistoryFileContents(historyContents);
    const lastAssistantMessageBySession = parseLastAssistantMessagesFromTranscript(historyContents);
    const checkpointLineNumber = checkpointState.fileCheckpoints[historyPath] ?? 0;
    const legacyStateForFile: CodexIngestionState | null = checkpointLineNumber > 0
      ? {
        historyPath,
        lastProcessedLineNumber: checkpointLineNumber,
        updatedAt: checkpointState.updatedAt
      }
      : null;

    let selectedRecords = selectRecordsForIngestion(rawRecords, {
      historyPath,
      includeSystem: options.includeSystem,
      previousState: legacyStateForFile,
      sinceTs: options.sinceTs,
      limit: undefined
    });

    if (remainingLimit !== undefined && selectedRecords.length > remainingLimit) {
      selectedRecords = selectedRecords.slice(0, remainingLimit);
    }

    if (selectedRecords.length === 0) continue;

    selectedBatches.push({
      historyPath,
      selectedRecords,
      lastAssistantMessageBySession
    });

    if (remainingLimit !== undefined) {
      remainingLimit -= selectedRecords.length;
    }
  }

  const selectedRecordEntries: HistoryRecordWithSource[] = [];
  for (const batch of selectedBatches) {
    for (const record of batch.selectedRecords) {
      selectedRecordEntries.push({ historyPath: batch.historyPath, record });
    }
  }

  const firstSelectedRecord = selectedRecordEntries[0];
  const lastSelectedRecord = selectedRecordEntries[selectedRecordEntries.length - 1];
  const sessionCountInBatch = new Set(selectedRecordEntries.map(entry => entry.record.session_id)).size;

  if (selectedRecordEntries.length === 0) {
    return {
      historyPaths: orderedHistoryPaths,
      stateFilePath,
      filesScanned: orderedHistoryPaths.length,
      filesWithSelectedRecords: 0,
      selectedRecordCount: 0,
      ingestedRecordCount: 0,
      summaryReport: { attempted: 0, successful: 0, failedSessionIds: [] },
      sessionCountInBatch: 0,
      updatedCheckpoints: checkpointState.fileCheckpoints
    };
  }

  if (options.dryRun) {
    return {
      historyPaths: orderedHistoryPaths,
      stateFilePath,
      filesScanned: orderedHistoryPaths.length,
      filesWithSelectedRecords: selectedBatches.length,
      selectedRecordCount: selectedRecordEntries.length,
      ingestedRecordCount: 0,
      summaryReport: { attempted: 0, successful: 0, failedSessionIds: [] },
      sessionCountInBatch,
      firstSelected: firstSelectedRecord
        ? { historyPath: firstSelectedRecord.historyPath, lineNumber: firstSelectedRecord.record.lineNumber }
        : undefined,
      lastSelected: lastSelectedRecord
        ? { historyPath: lastSelectedRecord.historyPath, lineNumber: lastSelectedRecord.record.lineNumber }
        : undefined,
      updatedCheckpoints: checkpointState.fileCheckpoints
    };
  }

  await ensureWorker(workerPort, workerHost);

  const ingestedRecordEntries: HistoryRecordWithSource[] = [];
  let stoppedAt: CodexHistoryIngestionResult['stoppedAt'] | undefined;

  for (const historyRecordWithSource of selectedRecordEntries) {
    try {
      await ingestObservationRecord(
        historyRecordWithSource,
        options.workspacePath,
        workerPort,
        workerHost,
        options.retryPolicy,
        fetchFn,
        sleepFn
      );
      ingestedRecordEntries.push(historyRecordWithSource);
    } catch (error) {
      stoppedAt = {
        historyPath: historyRecordWithSource.historyPath,
        lineNumber: historyRecordWithSource.record.lineNumber,
        message: error instanceof Error ? error.message : String(error)
      };
      break;
    }
  }

  const mergedLastAssistantMessageBySession = new Map<string, string>();
  for (const batch of selectedBatches) {
    for (const [sessionId, lastAssistantMessage] of batch.lastAssistantMessageBySession.entries()) {
      mergedLastAssistantMessageBySession.set(sessionId, lastAssistantMessage);
    }
  }

  const summaryReport = options.skipSummaries || ingestedRecordEntries.length === 0
    ? { attempted: 0, successful: 0, failedSessionIds: [] as string[] }
    : await ingestSummaries(
      ingestedRecordEntries,
      mergedLastAssistantMessageBySession,
      workerPort,
      workerHost,
      options.retryPolicy,
      fetchFn,
      sleepFn
    );

  const updatedCheckpoints = { ...checkpointState.fileCheckpoints };
  for (const ingestedEntry of ingestedRecordEntries) {
    updatedCheckpoints[ingestedEntry.historyPath] = ingestedEntry.record.lineNumber;
  }

  if (ingestedRecordEntries.length > 0) {
    const lastIngestedEntry = ingestedRecordEntries[ingestedRecordEntries.length - 1];
    saveCodexIngestionCheckpointState(
      stateFilePath,
      {
        fileCheckpoints: updatedCheckpoints,
        updatedAt: new Date().toISOString()
      },
      {
        historyPath: lastIngestedEntry.historyPath,
        lastProcessedLineNumber: lastIngestedEntry.record.lineNumber
      }
    );
  }

  return {
    historyPaths: orderedHistoryPaths,
    stateFilePath,
    filesScanned: orderedHistoryPaths.length,
    filesWithSelectedRecords: selectedBatches.length,
    selectedRecordCount: selectedRecordEntries.length,
    ingestedRecordCount: ingestedRecordEntries.length,
    stoppedAt,
    summaryReport,
    sessionCountInBatch,
    firstSelected: firstSelectedRecord
      ? { historyPath: firstSelectedRecord.historyPath, lineNumber: firstSelectedRecord.record.lineNumber }
      : undefined,
    lastSelected: lastSelectedRecord
      ? { historyPath: lastSelectedRecord.historyPath, lineNumber: lastSelectedRecord.record.lineNumber }
      : undefined,
    updatedCheckpoints
  };
}

function parseIngestibleProjectsFromTranscript(historyContents: string): string[] {
  const projectNameBySessionId = new Map<string, string>();
  const sessionIdsWithIngestibleUserMessages = new Set<string>();
  const discoveredProjectNames = new Set<string>();
  let activeSessionId: string | null = null;
  const lines = historyContents.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        payload?: {
          id?: string;
          cwd?: string;
          type?: string;
          message?: string;
        };
      };

      if (parsed.type === 'session_meta') {
        if (!parsed.payload || typeof parsed.payload.id !== 'string') {
          activeSessionId = null;
          continue;
        }

        const nextSessionId = parsed.payload.id.trim();
        activeSessionId = nextSessionId.length > 0 ? nextSessionId : null;
        if (!activeSessionId) continue;
        if (!parsed.payload || typeof parsed.payload.cwd !== 'string') continue;

        const cwdPath = parsed.payload.cwd.trim();
        if (!cwdPath) continue;

        const projectName = basename(cwdPath);
        if (!projectName) continue;
        projectNameBySessionId.set(activeSessionId, projectName);
        continue;
      }

      if (
        parsed.type === 'event_msg' &&
        parsed.payload &&
        parsed.payload.type === 'user_message' &&
        typeof parsed.payload.message === 'string' &&
        parsed.payload.message.trim().length > 0 &&
        activeSessionId
      ) {
        sessionIdsWithIngestibleUserMessages.add(activeSessionId);
      }
    } catch {
      // Ignore malformed lines for resilient diagnostics.
    }
  }

  for (const sessionId of sessionIdsWithIngestibleUserMessages) {
    const projectName = projectNameBySessionId.get(sessionId);
    if (!projectName) continue;
    discoveredProjectNames.add(projectName);
  }

  return [...discoveredProjectNames];
}

export function discoverCodexSessionProjects(sessionsRootPath: string = resolveCodexSessionsRoot()): CodexSessionProjectDiscoveryResult {
  const sessionHistoryPaths = listJsonlFilesRecursive(sessionsRootPath);
  const discoveredProjects = new Set<string>();

  for (const historyPath of sessionHistoryPaths) {
    try {
      const historyContents = readFileSync(historyPath, 'utf-8');
      const projectsFromTranscript = parseIngestibleProjectsFromTranscript(historyContents);
      for (const projectName of projectsFromTranscript) {
        discoveredProjects.add(projectName);
      }
    } catch {
      // Ignore unreadable files for resilient diagnostics.
    }
  }

  return {
    discoveredSessionProjects: [...discoveredProjects].sort((leftProject, rightProject) => leftProject.localeCompare(rightProject)),
    scannedFiles: sessionHistoryPaths.length,
    lastScanEpochMs: Date.now()
  };
}

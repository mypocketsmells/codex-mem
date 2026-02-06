#!/usr/bin/env node

/**
 * Codex history ingestion CLI
 *
 * Reads ~/.codex/history.jsonl and ingests entries into codex-mem via worker HTTP API.
 * Uses session-init + observation endpoints, with checkpointing for idempotent re-runs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { getWorkerPort } from '../shared/worker-utils.js';
import {
  RetryPolicy,
  CodexIngestionState,
  ParsedCodexHistoryRecord,
  buildSummaryRequests,
  parseHistoryFileContents,
  postJsonWithRetry,
  selectRecordsForIngestion,
  toContentSessionId
} from '../services/ingestion/codex-history.js';

interface CliOptions {
  historyPath: string;
  workspacePath: string;
  sinceTs?: number;
  limit?: number;
  dryRun: boolean;
  includeSystem: boolean;
  skipSummaries: boolean;
  retryPolicy: RetryPolicy;
}

const DEFAULT_HISTORY_PATH = join(homedir(), '.codex', 'history.jsonl');
const STATE_FILE_NAME = 'codex-history-ingest-state.json';
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 300,
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    historyPath: DEFAULT_HISTORY_PATH,
    workspacePath: process.cwd(),
    dryRun: false,
    includeSystem: false,
    skipSummaries: false,
    retryPolicy: { ...DEFAULT_RETRY_POLICY },
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === '--history' && argv[index + 1]) {
      options.historyPath = resolve(argv[++index]);
      continue;
    }
    if (arg === '--workspace' && argv[index + 1]) {
      options.workspacePath = resolve(argv[++index]);
      continue;
    }
    if (arg === '--since' && argv[index + 1]) {
      const sinceTs = Number(argv[++index]);
      if (!Number.isFinite(sinceTs)) {
        throw new Error(`Invalid --since value: ${argv[index]}`);
      }
      options.sinceTs = sinceTs;
      continue;
    }
    if (arg === '--limit' && argv[index + 1]) {
      const limit = Number(argv[++index]);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`Invalid --limit value: ${argv[index]}`);
      }
      options.limit = limit;
      continue;
    }
    if (arg === '--retries' && argv[index + 1]) {
      const retries = Number(argv[++index]);
      if (!Number.isInteger(retries) || retries < 1 || retries > 10) {
        throw new Error(`Invalid --retries value: ${argv[index]} (expected integer 1..10)`);
      }
      options.retryPolicy.maxAttempts = retries;
      continue;
    }
    if (arg === '--retry-base-ms' && argv[index + 1]) {
      const retryBaseMs = Number(argv[++index]);
      if (!Number.isInteger(retryBaseMs) || retryBaseMs < 50 || retryBaseMs > 10_000) {
        throw new Error(`Invalid --retry-base-ms value: ${argv[index]} (expected integer 50..10000)`);
      }
      options.retryPolicy.baseDelayMs = retryBaseMs;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--include-system') {
      options.includeSystem = true;
      continue;
    }
    if (arg === '--skip-summaries') {
      options.skipSummaries = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage(): void {
  console.log(`Usage: codex-mem ingest [options]

Options:
  --history <path>        Path to Codex history.jsonl (default: ~/.codex/history.jsonl)
  --workspace <path>      Workspace path to attribute observations (default: current dir)
  --since <unix_ts>       Only ingest records with ts >= unix timestamp
  --limit <n>             Max records to ingest this run
  --retries <n>           Retry attempts for transient HTTP failures (default: 3)
  --retry-base-ms <ms>    Base retry delay in milliseconds (default: 300)
  --skip-summaries        Skip session summary requests after observation ingestion
  --dry-run               Parse/filter and report without sending to worker
  --include-system        Include system warning records (default: false)
  --help, -h              Show this help
`);
}

function getStateFilePath(): string {
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  return join(dataDir, STATE_FILE_NAME);
}

function loadState(stateFilePath: string): CodexIngestionState | null {
  if (!existsSync(stateFilePath)) return null;
  try {
    return JSON.parse(readFileSync(stateFilePath, 'utf-8')) as CodexIngestionState;
  } catch {
    return null;
  }
}

function saveState(stateFilePath: string, state: CodexIngestionState): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
}

async function isWorkerHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureWorkerAvailable(port: number): Promise<void> {
  if (await isWorkerHealthy(port)) return;

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
    if (await isWorkerHealthy(port)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error('Worker did not become healthy after startup attempt');
}

async function ingestObservationRecord(
  record: ParsedCodexHistoryRecord,
  workspacePath: string,
  port: number,
  retryPolicy: RetryPolicy
): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const contentSessionId = toContentSessionId(record.session_id);
  const project = basename(workspacePath);
  const promptText = record.text.trim();

  if (!promptText) return;

  await postJsonWithRetry(
    `${baseUrl}/api/sessions/init`,
    {
      contentSessionId,
      project,
      prompt: promptText,
    },
    retryPolicy
  );

  await postJsonWithRetry(
    `${baseUrl}/api/sessions/observations`,
    {
      contentSessionId,
      tool_name: 'CodexHistoryEntry',
      tool_input: {
        source: 'codex-history.jsonl',
        line_number: record.lineNumber,
        timestamp: record.ts
      },
      tool_response: {
        text: promptText
      },
      cwd: workspacePath
    },
    retryPolicy
  );
}

async function ingestSummaries(
  records: ParsedCodexHistoryRecord[],
  port: number,
  retryPolicy: RetryPolicy
): Promise<{ attempted: number; successful: number; failedSessionIds: string[] }> {
  const summaries = buildSummaryRequests(records);
  const baseUrl = `http://127.0.0.1:${port}`;

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
        retryPolicy
      );
      successful++;
    } catch (error) {
      failedSessionIds.push(summary.contentSessionId);
      console.warn(
        `[codex-mem] Summary ingestion failed for ${summary.contentSessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    attempted: summaries.length,
    successful,
    failedSessionIds,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.historyPath)) {
    throw new Error(`History file not found: ${options.historyPath}`);
  }

  const stateFilePath = getStateFilePath();
  const previousState = loadState(stateFilePath);
  const historyContents = readFileSync(options.historyPath, 'utf-8');
  const rawRecords = parseHistoryFileContents(historyContents);
  const selectedRecords = selectRecordsForIngestion(rawRecords, {
    historyPath: options.historyPath,
    includeSystem: options.includeSystem,
    previousState,
    sinceTs: options.sinceTs,
    limit: options.limit,
  });

  console.log(`[codex-mem] Parsed ${rawRecords.length} record(s), ${selectedRecords.length} selected for ingestion`);
  console.log(`[codex-mem] Workspace: ${options.workspacePath}`);
  console.log(`[codex-mem] History: ${options.historyPath}`);
  console.log(`[codex-mem] State file: ${stateFilePath}`);

  if (selectedRecords.length === 0) {
    console.log('[codex-mem] Nothing new to ingest');
    return;
  }

  if (options.dryRun) {
    console.log('[codex-mem] Dry run enabled, no records were sent');
    console.log(`[codex-mem] First selected line: ${selectedRecords[0].lineNumber}`);
    console.log(`[codex-mem] Last selected line: ${selectedRecords[selectedRecords.length - 1].lineNumber}`);
    console.log(`[codex-mem] Session count in batch: ${new Set(selectedRecords.map(r => r.session_id)).size}`);
    return;
  }

  const port = getWorkerPort();
  await ensureWorkerAvailable(port);

  const successfullyIngestedRecords: ParsedCodexHistoryRecord[] = [];
  let lastProcessedLineNumber = previousState?.lastProcessedLineNumber ?? 0;

  for (const record of selectedRecords) {
    try {
      await ingestObservationRecord(record, options.workspacePath, port, options.retryPolicy);
      successfullyIngestedRecords.push(record);
      lastProcessedLineNumber = record.lineNumber;
    } catch (error) {
      console.error(`[codex-mem] Failed at line ${record.lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }

  let summaryReport = { attempted: 0, successful: 0, failedSessionIds: [] as string[] };
  if (!options.skipSummaries && successfullyIngestedRecords.length > 0) {
    summaryReport = await ingestSummaries(successfullyIngestedRecords, port, options.retryPolicy);
  }

  if (successfullyIngestedRecords.length > 0) {
    saveState(stateFilePath, {
      historyPath: options.historyPath,
      lastProcessedLineNumber,
      updatedAt: new Date().toISOString()
    });
  }

  console.log(`[codex-mem] Ingested ${successfullyIngestedRecords.length}/${selectedRecords.length} record(s)`);
  if (!options.skipSummaries) {
    console.log(`[codex-mem] Summaries queued ${summaryReport.successful}/${summaryReport.attempted}`);
    if (summaryReport.failedSessionIds.length > 0) {
      console.log(`[codex-mem] Summary failures: ${summaryReport.failedSessionIds.join(', ')}`);
    }
  }
}

main().catch((error) => {
  console.error(`[codex-mem] Ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

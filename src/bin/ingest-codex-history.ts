#!/usr/bin/env node

/**
 * Codex history ingestion CLI
 *
 * Reads Codex transcript files and ingests entries into codex-mem via worker HTTP API.
 * Uses session-init + observation endpoints with per-file checkpoints for idempotent re-runs.
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { getWorkerPort } from '../shared/worker-utils.js';
import { RetryPolicy } from '../services/ingestion/codex-history.js';
import {
  ensureWorkerAvailable,
  getCodexIngestionStateFilePath,
  resolveDefaultCodexHistoryPaths,
  runCodexHistoryIngestion
} from '../services/ingestion/CodexHistoryIngestor.js';

interface CliOptions {
  historyPath?: string;
  workspacePath: string;
  sinceTs?: number;
  limit?: number;
  dryRun: boolean;
  includeSystem: boolean;
  skipSummaries: boolean;
  retryPolicy: RetryPolicy;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 300,
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
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
  --history <path>        Path to one Codex input JSONL (default: all ~/.codex/sessions/**/*.jsonl, fallback ~/.codex/history.jsonl)
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const historyPaths = options.historyPath
    ? [options.historyPath]
    : resolveDefaultCodexHistoryPaths();

  if (historyPaths.length === 0) {
    throw new Error('No Codex history files were found in ~/.codex/sessions or ~/.codex/history.jsonl');
  }

  if (options.historyPath && !existsSync(options.historyPath)) {
    throw new Error(`History file not found: ${options.historyPath}`);
  }

  const stateFilePath = getCodexIngestionStateFilePath();
  const ingestionResult = await runCodexHistoryIngestion({
    historyPaths,
    workspacePath: options.workspacePath,
    includeSystem: options.includeSystem,
    skipSummaries: options.skipSummaries,
    dryRun: options.dryRun,
    retryPolicy: options.retryPolicy,
    stateFilePath,
    port: getWorkerPort(),
    sinceTs: options.sinceTs,
    limit: options.limit,
    ensureWorkerAvailableFn: ensureWorkerAvailable
  });

  console.log(`[codex-mem] History files scanned: ${ingestionResult.filesScanned}`);
  console.log(`[codex-mem] History files with new records: ${ingestionResult.filesWithSelectedRecords}`);
  console.log(`[codex-mem] Selected records: ${ingestionResult.selectedRecordCount}`);
  console.log(`[codex-mem] State file: ${ingestionResult.stateFilePath}`);

  if (ingestionResult.firstSelected) {
    console.log(`[codex-mem] First selected: ${ingestionResult.firstSelected.historyPath}:${ingestionResult.firstSelected.lineNumber}`);
  }
  if (ingestionResult.lastSelected) {
    console.log(`[codex-mem] Last selected: ${ingestionResult.lastSelected.historyPath}:${ingestionResult.lastSelected.lineNumber}`);
  }
  if (ingestionResult.selectedRecordCount > 0) {
    console.log(`[codex-mem] Session count in batch: ${ingestionResult.sessionCountInBatch}`);
  }

  if (options.dryRun) {
    console.log('[codex-mem] Dry run enabled, no records were sent');
    return;
  }

  if (ingestionResult.stoppedAt) {
    console.error(
      `[codex-mem] Failed at ${ingestionResult.stoppedAt.historyPath}:${ingestionResult.stoppedAt.lineNumber}: ${ingestionResult.stoppedAt.message}`
    );
  }

  console.log(`[codex-mem] Ingested ${ingestionResult.ingestedRecordCount}/${ingestionResult.selectedRecordCount} record(s)`);
  if (!options.skipSummaries) {
    console.log(`[codex-mem] Summaries queued ${ingestionResult.summaryReport.successful}/${ingestionResult.summaryReport.attempted}`);
    if (ingestionResult.summaryReport.failedSessionIds.length > 0) {
      console.log(`[codex-mem] Summary failures: ${ingestionResult.summaryReport.failedSessionIds.join(', ')}`);
    }
  }
}

main().catch((error) => {
  console.error(`[codex-mem] Ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

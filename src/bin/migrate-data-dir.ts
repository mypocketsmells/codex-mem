#!/usr/bin/env node

import { resolve } from 'path';
import { runDataDirMigration } from '../services/migration/data-dir-migration.js';

interface CliOptions {
  legacyDirPath?: string;
  canonicalDirPath?: string;
  dryRun: boolean;
  overwrite: boolean;
  force: boolean;
}

function printUsage(): void {
  console.log(`Usage: codex-mem migrate-data-dir [options]

Safely migrates legacy ~/.claude-mem data into ~/.codex-mem (copy-based, non-destructive).

Options:
  --legacy <path>       Override legacy data directory (default: ~/.claude-mem)
  --canonical <path>    Override canonical data directory (default: ~/.codex-mem)
  --dry-run             Show migration plan without copying files
  --overwrite           Overwrite files that already exist in canonical directory
  --force               Ignore existing migration lock file
  --help, -h            Show this help
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    overwrite: false,
    force: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === '--legacy' && argv[index + 1]) {
      options.legacyDirPath = resolve(argv[++index]);
      continue;
    }
    if (arg === '--canonical' && argv[index + 1]) {
      options.canonicalDirPath = resolve(argv[++index]);
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--overwrite') {
      options.overwrite = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const result = runDataDirMigration(options);

  console.log(`[codex-mem] Migration status: ${result.status}`);
  console.log(`[codex-mem] Legacy dir: ${result.legacyDirPath}`);
  console.log(`[codex-mem] Canonical dir: ${result.canonicalDirPath}`);
  console.log(`[codex-mem] Lock file: ${result.lockFilePath}`);
  console.log(`[codex-mem] Copied files: ${result.copiedFiles}`);
  console.log(`[codex-mem] Skipped files: ${result.skippedFiles}`);

  if (result.skippedDueToExisting.length > 0) {
    console.log(`[codex-mem] Existing destination files skipped: ${result.skippedDueToExisting.join(', ')}`);
  }

  if (result.reason) {
    console.log(`[codex-mem] Reason: ${result.reason}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[codex-mem] Data migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

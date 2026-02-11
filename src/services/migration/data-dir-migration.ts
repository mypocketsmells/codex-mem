import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative } from 'path';
import { homedir } from 'os';
import { getCanonicalDataDirPath } from '../../shared/product-config.js';

export const DATA_MIGRATION_LOCK_FILENAME = '.legacy-data-dir-migration.lock.json';
export const DATA_MIGRATION_REPORT_FILENAME = 'legacy-data-dir-migration-report.json';
const LEGACY_DATA_DIR_PATH = join(homedir(), '.claude-mem');

export interface DataDirMigrationOptions {
  legacyDirPath?: string;
  canonicalDirPath?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  force?: boolean;
}

export interface DataDirMigrationResult {
  status: 'completed' | 'dry-run' | 'skipped';
  reason?: string;
  legacyDirPath: string;
  canonicalDirPath: string;
  lockFilePath: string;
  copiedFiles: number;
  skippedFiles: number;
  skippedDueToExisting: string[];
}

interface MigrationReport {
  legacyDirPath: string;
  canonicalDirPath: string;
  copiedFiles: number;
  skippedFiles: number;
  skippedDueToExisting: string[];
  timestamp: string;
}

function listFilesRecursively(baseDirPath: string): string[] {
  const relativeFilePaths: string[] = [];

  const walk = (currentPath: string): void => {
    const stats = lstatSync(currentPath);

    if (stats.isDirectory()) {
      for (const entryName of readdirSync(currentPath)) {
        walk(join(currentPath, entryName));
      }
      return;
    }

    if (stats.isFile()) {
      relativeFilePaths.push(relative(baseDirPath, currentPath));
    }
  };

  walk(baseDirPath);
  return relativeFilePaths.sort();
}

function writeMigrationMetadata(
  canonicalDirPath: string,
  report: MigrationReport
): void {
  const lockFilePath = join(canonicalDirPath, DATA_MIGRATION_LOCK_FILENAME);
  const reportFilePath = join(canonicalDirPath, DATA_MIGRATION_REPORT_FILENAME);

  writeFileSync(lockFilePath, JSON.stringify(report, null, 2), 'utf-8');
  writeFileSync(reportFilePath, JSON.stringify(report, null, 2), 'utf-8');
}

export function runDataDirMigration(options: DataDirMigrationOptions = {}): DataDirMigrationResult {
  const legacyDirPath = options.legacyDirPath ?? LEGACY_DATA_DIR_PATH;
  const canonicalDirPath = options.canonicalDirPath ?? getCanonicalDataDirPath();
  const dryRun = options.dryRun ?? false;
  const overwrite = options.overwrite ?? false;
  const force = options.force ?? false;
  const lockFilePath = join(canonicalDirPath, DATA_MIGRATION_LOCK_FILENAME);

  if (!existsSync(legacyDirPath)) {
    return {
      status: 'skipped',
      reason: `legacy data directory does not exist: ${legacyDirPath}`,
      legacyDirPath,
      canonicalDirPath,
      lockFilePath,
      copiedFiles: 0,
      skippedFiles: 0,
      skippedDueToExisting: [],
    };
  }

  if (existsSync(lockFilePath) && !force) {
    return {
      status: 'skipped',
      reason: `migration lock file already exists: ${lockFilePath}`,
      legacyDirPath,
      canonicalDirPath,
      lockFilePath,
      copiedFiles: 0,
      skippedFiles: 0,
      skippedDueToExisting: [],
    };
  }

  const relativeFilePaths = listFilesRecursively(legacyDirPath);
  const skippedDueToExisting: string[] = [];
  let copiedFiles = 0;
  let skippedFiles = 0;

  if (!dryRun) {
    mkdirSync(canonicalDirPath, { recursive: true });
  }

  for (const relativeFilePath of relativeFilePaths) {
    const sourceFilePath = join(legacyDirPath, relativeFilePath);
    const targetFilePath = join(canonicalDirPath, relativeFilePath);
    const targetExists = existsSync(targetFilePath);

    if (targetExists && !overwrite) {
      skippedFiles++;
      skippedDueToExisting.push(relativeFilePath);
      continue;
    }

    copiedFiles++;
    if (!dryRun) {
      mkdirSync(dirname(targetFilePath), { recursive: true });
      copyFileSync(sourceFilePath, targetFilePath);
    }
  }

  const report: MigrationReport = {
    legacyDirPath,
    canonicalDirPath,
    copiedFiles,
    skippedFiles,
    skippedDueToExisting,
    timestamp: new Date().toISOString(),
  };

  if (!dryRun) {
    writeMigrationMetadata(canonicalDirPath, report);
  }

  return {
    status: dryRun ? 'dry-run' : 'completed',
    legacyDirPath,
    canonicalDirPath,
    lockFilePath,
    copiedFiles,
    skippedFiles,
    skippedDueToExisting,
  };
}

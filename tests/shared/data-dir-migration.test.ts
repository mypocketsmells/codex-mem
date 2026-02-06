import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  DATA_MIGRATION_LOCK_FILENAME,
  DATA_MIGRATION_REPORT_FILENAME,
  runDataDirMigration
} from '../../src/services/migration/data-dir-migration.js';

describe('data directory migration', () => {
  let tempRoot: string;
  let legacyDirPath: string;
  let canonicalDirPath: string;

  const writeFixtureFile = (relativePath: string, content: string): void => {
    const absolutePath = join(legacyDirPath, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
  };

  beforeEach(() => {
    tempRoot = join(tmpdir(), `codex-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    legacyDirPath = join(tempRoot, '.claude-mem');
    canonicalDirPath = join(tempRoot, '.codex-mem');
    mkdirSync(legacyDirPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('supports dry-run without creating canonical directory', () => {
    writeFixtureFile('settings.json', '{"CLAUDE_MEM_MODEL":"x"}');
    writeFixtureFile('logs/worker.log', 'hello');

    const result = runDataDirMigration({
      legacyDirPath,
      canonicalDirPath,
      dryRun: true,
    });

    expect(result.status).toBe('dry-run');
    expect(result.copiedFiles).toBe(2);
    expect(existsSync(canonicalDirPath)).toBe(false);
  });

  it('copies files and writes lock/report metadata', () => {
    writeFixtureFile('settings.json', '{"CLAUDE_MEM_MODEL":"x"}');
    writeFixtureFile('vector-db/index.bin', 'vector data');

    const result = runDataDirMigration({
      legacyDirPath,
      canonicalDirPath,
    });

    expect(result.status).toBe('completed');
    expect(result.copiedFiles).toBe(2);
    expect(existsSync(join(canonicalDirPath, 'settings.json'))).toBe(true);
    expect(existsSync(join(canonicalDirPath, 'vector-db', 'index.bin'))).toBe(true);
    expect(existsSync(join(canonicalDirPath, DATA_MIGRATION_LOCK_FILENAME))).toBe(true);
    expect(existsSync(join(canonicalDirPath, DATA_MIGRATION_REPORT_FILENAME))).toBe(true);
  });

  it('skips migration when lock file exists unless force is used', () => {
    writeFixtureFile('settings.json', '{"CLAUDE_MEM_MODEL":"x"}');

    const firstRun = runDataDirMigration({
      legacyDirPath,
      canonicalDirPath,
    });
    expect(firstRun.status).toBe('completed');

    const secondRun = runDataDirMigration({
      legacyDirPath,
      canonicalDirPath,
    });
    expect(secondRun.status).toBe('skipped');
    expect(secondRun.reason).toContain('lock file already exists');

    const forcedRun = runDataDirMigration({
      legacyDirPath,
      canonicalDirPath,
      force: true,
    });
    expect(forcedRun.status).toBe('completed');
  });

  it('does not overwrite existing canonical files unless overwrite is set', () => {
    writeFixtureFile('settings.json', '{"CLAUDE_MEM_MODEL":"legacy"}');
    mkdirSync(canonicalDirPath, { recursive: true });
    writeFileSync(join(canonicalDirPath, 'settings.json'), '{"CLAUDE_MEM_MODEL":"canonical"}', 'utf-8');

    const noOverwriteResult = runDataDirMigration({
      legacyDirPath,
      canonicalDirPath,
      force: true,
      overwrite: false,
    });
    expect(noOverwriteResult.skippedFiles).toBe(1);
    expect(noOverwriteResult.skippedDueToExisting).toEqual(['settings.json']);

    const canonicalValueAfterNoOverwrite = readFileSync(join(canonicalDirPath, 'settings.json'), 'utf-8');
    expect(canonicalValueAfterNoOverwrite).toContain('"canonical"');

    const overwriteResult = runDataDirMigration({
      legacyDirPath,
      canonicalDirPath,
      force: true,
      overwrite: true,
    });
    expect(overwriteResult.copiedFiles).toBe(1);

    const canonicalValueAfterOverwrite = readFileSync(join(canonicalDirPath, 'settings.json'), 'utf-8');
    expect(canonicalValueAfterOverwrite).toContain('"legacy"');
  });
});

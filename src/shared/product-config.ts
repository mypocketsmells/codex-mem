import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const CANONICAL_PRODUCT_NAME = 'codex-mem';
export const LEGACY_PRODUCT_NAME = 'claude-mem';

export const CANONICAL_DATA_DIR_NAME = '.codex-mem';
export const LEGACY_DATA_DIR_NAME = '.claude-mem';

export function getCanonicalDataDirPath(): string {
  return join(homedir(), CANONICAL_DATA_DIR_NAME);
}

export function getLegacyDataDirPath(): string {
  return join(homedir(), LEGACY_DATA_DIR_NAME);
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean)));
}

export function getDataDirCandidates(): string[] {
  const envCodexDir = process.env.CODEX_MEM_DATA_DIR;
  const envLegacyDir = process.env.CLAUDE_MEM_DATA_DIR;

  return dedupePaths([
    envCodexDir || '',
    envLegacyDir || '',
    getCanonicalDataDirPath(),
    getLegacyDataDirPath(),
  ]);
}

/**
 * Resolve data directory with compatibility guards:
 * 1) CODEX_MEM_DATA_DIR env var
 * 2) CLAUDE_MEM_DATA_DIR env var
 * 3) Existing ~/.codex-mem
 * 4) Existing ~/.claude-mem
 * 5) Default ~/.codex-mem
 */
export function resolveDefaultDataDir(): string {
  if (process.env.CODEX_MEM_DATA_DIR) return process.env.CODEX_MEM_DATA_DIR;
  if (process.env.CLAUDE_MEM_DATA_DIR) return process.env.CLAUDE_MEM_DATA_DIR;

  const canonicalDir = getCanonicalDataDirPath();
  if (existsSync(canonicalDir)) return canonicalDir;

  const legacyDir = getLegacyDataDirPath();
  if (existsSync(legacyDir)) return legacyDir;

  return canonicalDir;
}

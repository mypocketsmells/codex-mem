import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

export const CANONICAL_PRODUCT_NAME = 'codex-mem';

export const CANONICAL_DATA_DIR_NAME = '.codex-mem';

export function getCanonicalDataDirPath(): string {
  return join(homedir(), CANONICAL_DATA_DIR_NAME);
}

/**
 * Resolve the current project root from git, with cwd fallback.
 * This keeps project-local defaults stable when hooks run from subdirectories.
 */
export function getProjectRoot(cwd: string = process.cwd()): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();

    if (gitRoot) {
      return gitRoot;
    }
  } catch {
    // Fall back to provided cwd when not inside a git repo.
  }

  return cwd;
}

export function getCanonicalProjectDataDirPath(cwd: string = process.cwd()): string {
  return join(getProjectRoot(cwd), CANONICAL_DATA_DIR_NAME);
}

/**
 * Resolve default data directory for codex-mem:
 * 1) CODEX_MEM_DATA_DIR env var
 * 2) CLAUDE_MEM_DATA_DIR env var
 * 3) Existing ~/.codex-mem
 * 4) Default ~/.codex-mem
 */
export function resolveDefaultDataDir(): string {
  if (process.env.CODEX_MEM_DATA_DIR) return process.env.CODEX_MEM_DATA_DIR;
  if (process.env.CLAUDE_MEM_DATA_DIR) return process.env.CLAUDE_MEM_DATA_DIR;

  const canonicalDir = getCanonicalDataDirPath();
  if (existsSync(canonicalDir)) return canonicalDir;

  return canonicalDir;
}

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  getProjectRoot,
  getCanonicalProjectDataDirPath,
} from '../../src/shared/product-config.js';

describe('product-config project paths', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `product-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to cwd when outside a git repository', () => {
    const nonRepoPath = join(tempRoot, 'plain-folder');
    mkdirSync(nonRepoPath, { recursive: true });

    const resolvedRoot = getProjectRoot(nonRepoPath);
    expect(resolvedRoot).toBe(nonRepoPath);
  });

  it('resolves git repository root when cwd is a subdirectory', () => {
    const repoPath = join(tempRoot, 'repo');
    const nestedPath = join(repoPath, 'src', 'nested');
    mkdirSync(nestedPath, { recursive: true });

    execSync('git init', {
      cwd: repoPath,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });

    const resolvedRoot = getProjectRoot(nestedPath);
    expect(resolvedRoot).toBe(realpathSync(repoPath));
  });

  it('derives canonical project data dir from project root', () => {
    const repoPath = join(tempRoot, 'repo-with-dirs');
    const nestedPath = join(repoPath, 'app');
    mkdirSync(nestedPath, { recursive: true });

    execSync('git init', {
      cwd: repoPath,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });

    const resolvedRepoPath = realpathSync(repoPath);
    expect(getCanonicalProjectDataDirPath(nestedPath)).toBe(join(resolvedRepoPath, '.codex-mem'));
  });
});

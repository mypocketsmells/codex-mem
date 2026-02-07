import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, '../../package.json');

describe('package scripts', () => {
  it('uses valid tail syntax for worker:tail', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    const workerTailScript = packageJson.scripts?.['worker:tail'];
    expect(workerTailScript).toBeDefined();

    // Guard against invalid syntax `tail -f 50` which treats `50` as a filename.
    expect(workerTailScript).not.toMatch(/\btail\s+-f\s+50\b/);
    expect(workerTailScript).toMatch(/\btail\s+-n\s+50\s+-f\b|\btail\s+-f\s+-n\s+50\b/);
  });

  it('uses actual logger filename conventions for worker log scripts', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    const workerLogsScript = packageJson.scripts?.['worker:logs'];
    const workerTailScript = packageJson.scripts?.['worker:tail'];

    expect(workerLogsScript).toBeDefined();
    expect(workerTailScript).toBeDefined();

    // Logger writes codex-mem-YYYY-MM-DD.log or (legacy) claude-mem-YYYY-MM-DD.log.
    expect(workerLogsScript).not.toContain('worker-$(date +%Y-%m-%d).log');
    expect(workerTailScript).not.toContain('worker-$(date +%Y-%m-%d).log');
    expect(workerLogsScript).toMatch(/codex-mem|claude-mem/);
    expect(workerTailScript).toMatch(/codex-mem|claude-mem/);
  });

  it('falls back to legacy log directory when codex log file is missing', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    const workerLogsScript = packageJson.scripts?.['worker:logs'];
    expect(workerLogsScript).toBeDefined();

    const temporaryHome = mkdtempSync(path.join(tmpdir(), 'codex-mem-worker-logs-'));
    try {
      const now = new Date();
      const logDate = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
      ].join('-');

      mkdirSync(path.join(temporaryHome, '.codex-mem', 'logs'), { recursive: true });

      const legacyLogPath = path.join(
        temporaryHome,
        '.claude-mem',
        'logs',
        `claude-mem-${logDate}.log`
      );
      mkdirSync(path.dirname(legacyLogPath), { recursive: true });
      const expectedLogLine = 'legacy-worker-log-line';
      writeFileSync(legacyLogPath, `${expectedLogLine}\n`, 'utf-8');

      const environment: NodeJS.ProcessEnv = { ...process.env, HOME: temporaryHome };
      delete environment.CODEX_MEM_DATA_DIR;
      delete environment.CLAUDE_MEM_DATA_DIR;

      const commandResult = spawnSync('sh', ['-c', workerLogsScript!], {
        env: environment,
        encoding: 'utf-8'
      });

      expect(commandResult.status).toBe(0);
      expect(commandResult.stdout).toContain(expectedLogLine);
    } finally {
      rmSync(temporaryHome, { recursive: true, force: true });
    }
  });

  it('returns a helpful error when no worker log file exists in either directory', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };

    const workerLogsScript = packageJson.scripts?.['worker:logs'];
    const workerTailScript = packageJson.scripts?.['worker:tail'];
    expect(workerLogsScript).toBeDefined();
    expect(workerTailScript).toBeDefined();

    const temporaryHome = mkdtempSync(path.join(tmpdir(), 'codex-mem-worker-logs-missing-'));
    try {
      mkdirSync(path.join(temporaryHome, '.codex-mem', 'logs'), { recursive: true });
      mkdirSync(path.join(temporaryHome, '.claude-mem', 'logs'), { recursive: true });

      const environment: NodeJS.ProcessEnv = { ...process.env, HOME: temporaryHome };
      delete environment.CODEX_MEM_DATA_DIR;
      delete environment.CLAUDE_MEM_DATA_DIR;

      const workerLogsResult = spawnSync('sh', ['-c', workerLogsScript!], {
        env: environment,
        encoding: 'utf-8'
      });
      const workerTailResult = spawnSync('sh', ['-c', workerTailScript!], {
        env: environment,
        encoding: 'utf-8'
      });

      expect(workerLogsResult.status).toBe(1);
      expect(workerTailResult.status).toBe(1);
      expect(workerLogsResult.stderr).toContain('No worker log file found');
      expect(workerTailResult.stderr).toContain('No worker log file found');
      expect(workerLogsResult.stderr).not.toContain('No such file or directory');
      expect(workerTailResult.stderr).not.toContain('No such file or directory');
    } finally {
      rmSync(temporaryHome, { recursive: true, force: true });
    }
  });
});

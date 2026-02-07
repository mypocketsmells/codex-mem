import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootPath = path.resolve(__dirname, '../..');
const workerServiceSourcePath = path.join(projectRootPath, 'src/services/worker-service.ts');

describe('codex-app install flow', () => {
  it('installs and uninstalls managed codex app config integration with backup', () => {
    const sandboxRootPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-codex-app-'));
    const sandboxHomePath = path.join(sandboxRootPath, 'home');
    const sandboxDataDirPath = path.join(sandboxRootPath, 'data');
    const codexConfigDirPath = path.join(sandboxHomePath, '.codex');
    const codexConfigPath = path.join(codexConfigDirPath, 'config.toml');

    mkdirSync(codexConfigDirPath, { recursive: true });
    mkdirSync(sandboxDataDirPath, { recursive: true });

    writeFileSync(
      codexConfigPath,
      [
        'model = "gpt-5"',
        'notifications = ["session-start"]',
        'notify = "echo old-notify"',
        '',
        '[projects."/tmp/example"]',
        'trust_level = "trusted"'
      ].join('\n'),
      'utf-8'
    );

    const commandEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: sandboxHomePath,
      CODEX_MEM_DATA_DIR: sandboxDataDirPath,
      CLAUDE_MEM_DATA_DIR: sandboxDataDirPath
    };

    try {
      const installResult = spawnSync(
        'bun',
        [workerServiceSourcePath, 'codex-app', 'install'],
        {
          cwd: projectRootPath,
          env: commandEnvironment,
          encoding: 'utf-8'
        }
      );
      expect(installResult.status).toBe(0);

      const installedConfig = readFileSync(codexConfigPath, 'utf-8');
      expect(installedConfig).toContain('# >>> codex-mem managed codex-app integration >>>');
      expect(installedConfig).toContain('# <<< codex-mem managed codex-app integration <<<');
      expect(installedConfig).toContain('agent-turn-complete');
      expect(installedConfig).toContain('codex-app notify-turn-complete');
      expect((installedConfig.match(/^notifications\s*=/gm) || []).length).toBe(1);
      expect((installedConfig.match(/^notify\s*=/gm) || []).length).toBe(1);
      expect(installedConfig).toContain('[projects."/tmp/example"]');

      const backupFiles = readdirSync(codexConfigDirPath).filter(name => name.startsWith('config.toml.backup.'));
      expect(backupFiles.length).toBeGreaterThan(0);

      const statusResult = spawnSync(
        'bun',
        [workerServiceSourcePath, 'codex-app', 'status'],
        {
          cwd: projectRootPath,
          env: commandEnvironment,
          encoding: 'utf-8'
        }
      );
      expect(statusResult.status).toBe(0);
      expect(statusResult.stdout).toContain('Installed: yes');

      const uninstallResult = spawnSync(
        'bun',
        [workerServiceSourcePath, 'codex-app', 'uninstall'],
        {
          cwd: projectRootPath,
          env: commandEnvironment,
          encoding: 'utf-8'
        }
      );
      expect(uninstallResult.status).toBe(0);

      const uninstalledConfig = readFileSync(codexConfigPath, 'utf-8');
      expect(uninstalledConfig).not.toContain('# >>> codex-mem managed codex-app integration >>>');
      expect(uninstalledConfig).toContain('notifications = ["session-start"]');
      expect(uninstalledConfig).toContain('notify = "echo old-notify"');
    } finally {
      rmSync(sandboxRootPath, { recursive: true, force: true });
    }
  });

  it('status returns non-zero when integration is not installed', () => {
    const sandboxRootPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-codex-app-status-'));
    const sandboxHomePath = path.join(sandboxRootPath, 'home');
    const sandboxDataDirPath = path.join(sandboxRootPath, 'data');
    const codexConfigDirPath = path.join(sandboxHomePath, '.codex');
    const codexConfigPath = path.join(codexConfigDirPath, 'config.toml');

    mkdirSync(codexConfigDirPath, { recursive: true });
    mkdirSync(sandboxDataDirPath, { recursive: true });
    writeFileSync(codexConfigPath, 'model = "gpt-5"\n', 'utf-8');

    const commandEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: sandboxHomePath,
      CODEX_MEM_DATA_DIR: sandboxDataDirPath,
      CLAUDE_MEM_DATA_DIR: sandboxDataDirPath
    };

    try {
      const statusResult = spawnSync(
        'bun',
        [workerServiceSourcePath, 'codex-app', 'status'],
        {
          cwd: projectRootPath,
          env: commandEnvironment,
          encoding: 'utf-8'
        }
      );
      expect(statusResult.status).toBe(1);
      expect(statusResult.stdout).toContain('Installed: no');
    } finally {
      rmSync(sandboxRootPath, { recursive: true, force: true });
    }
  });
});

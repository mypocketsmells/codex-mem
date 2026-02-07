import { describe, expect, it } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootPath = path.resolve(__dirname, '../..');
const workerServiceScriptPath = path.join(projectRootPath, 'plugin/scripts/worker-service.cjs');

describe('cursor hooks install flow', () => {
  it('installs and uninstalls project hooks using unified hooks.json cursor-hooks layout', () => {
    if (!existsSync(workerServiceScriptPath)) {
      console.log('Skipping cursor hooks install flow test - plugin/scripts/worker-service.cjs not found. Run npm run build first.');
      return;
    }

    const sandboxRootPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-cursor-install-'));
    const workspacePath = path.join(sandboxRootPath, 'workspace');
    const sandboxHomePath = path.join(sandboxRootPath, 'home');
    const sandboxDataDirPath = path.join(sandboxRootPath, 'data');
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(sandboxHomePath, { recursive: true });
    mkdirSync(sandboxDataDirPath, { recursive: true });
    writeFileSync(path.join(workspacePath, 'README.md'), '# sandbox\n');

    const commandEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: sandboxHomePath,
      CODEX_MEM_DATA_DIR: sandboxDataDirPath,
      CLAUDE_MEM_DATA_DIR: sandboxDataDirPath,
      CODEX_MEM_INSTALL_ROOT: projectRootPath
    };

    try {
      const installResult = spawnSync(
        'bun',
        [workerServiceScriptPath, 'cursor', 'install', 'project'],
        {
          cwd: workspacePath,
          env: commandEnvironment,
          encoding: 'utf-8'
        }
      );

      expect(installResult.status).toBe(0);

      const hooksJsonPath = path.join(workspacePath, '.cursor', 'hooks.json');
      const contextRulesPath = path.join(workspacePath, '.cursor', 'rules', 'codex-mem-context.mdc');
      const registryPath = path.join(sandboxDataDirPath, 'cursor-projects.json');

      expect(existsSync(hooksJsonPath)).toBe(true);
      expect(existsSync(contextRulesPath)).toBe(true);
      expect(existsSync(registryPath)).toBe(true);

      const hooksJsonText = readFileSync(hooksJsonPath, 'utf-8');
      expect(hooksJsonText).toContain('worker-service.cjs');
      expect(hooksJsonText).toContain('hook cursor session-init');

      const statusResult = spawnSync(
        'bun',
        [workerServiceScriptPath, 'cursor', 'status'],
        {
          cwd: workspacePath,
          env: commandEnvironment,
          encoding: 'utf-8'
        }
      );
      expect(statusResult.status).toBe(0);
      expect(statusResult.stdout).toContain('Project: Installed');
      expect(statusResult.stdout).toContain('Context: Active');

      const uninstallResult = spawnSync(
        'bun',
        [workerServiceScriptPath, 'cursor', 'uninstall', 'project'],
        {
          cwd: workspacePath,
          env: commandEnvironment,
          encoding: 'utf-8'
        }
      );
      expect(uninstallResult.status).toBe(0);
      expect(existsSync(hooksJsonPath)).toBe(false);
      expect(existsSync(contextRulesPath)).toBe(false);
    } finally {
      rmSync(sandboxRootPath, { recursive: true, force: true });
    }
  });

  it('supports legacy CLAUDE_MEM_INSTALL_ROOT fallback when CODEX_MEM_INSTALL_ROOT is unset', () => {
    if (!existsSync(workerServiceScriptPath)) {
      console.log('Skipping legacy install-root fallback test - plugin/scripts/worker-service.cjs not found. Run npm run build first.');
      return;
    }

    const sandboxRootPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-legacy-install-root-'));
    const workspacePath = path.join(sandboxRootPath, 'workspace');
    const sandboxHomePath = path.join(sandboxRootPath, 'home');
    const sandboxDataDirPath = path.join(sandboxRootPath, 'data');
    const isolatedInstallRootPath = path.join(sandboxRootPath, 'isolated-install');
    const isolatedWorkerScriptPath = path.join(isolatedInstallRootPath, 'plugin', 'scripts', 'worker-service.cjs');
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(sandboxHomePath, { recursive: true });
    mkdirSync(sandboxDataDirPath, { recursive: true });
    mkdirSync(path.dirname(isolatedWorkerScriptPath), { recursive: true });
    copyFileSync(workerServiceScriptPath, isolatedWorkerScriptPath);
    writeFileSync(path.join(workspacePath, 'README.md'), '# sandbox\n');

    const commandEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: sandboxHomePath,
      CODEX_MEM_DATA_DIR: sandboxDataDirPath,
      CLAUDE_MEM_DATA_DIR: sandboxDataDirPath,
      CLAUDE_MEM_INSTALL_ROOT: projectRootPath
    };
    delete commandEnvironment.CODEX_MEM_INSTALL_ROOT;

    try {
      const installResult = spawnSync(
        'bun',
        [isolatedWorkerScriptPath, 'cursor', 'install', 'project'],
        {
          cwd: workspacePath,
          env: commandEnvironment,
          encoding: 'utf-8'
        }
      );

      expect(installResult.status).toBe(0);
      expect(existsSync(path.join(workspacePath, '.cursor', 'hooks.json'))).toBe(true);
      expect(existsSync(path.join(workspacePath, '.cursor', 'rules', 'codex-mem-context.mdc'))).toBe(true);
    } finally {
      rmSync(sandboxRootPath, { recursive: true, force: true });
    }
  });
});

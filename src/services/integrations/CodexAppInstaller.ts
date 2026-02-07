import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, closeSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import {
  ensureWorkerAvailable,
  getCodexIngestionStateFilePath,
  resolveDefaultCodexHistoryPaths,
  runCodexHistoryIngestion
} from '../ingestion/CodexHistoryIngestor.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

const CODEX_APP_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const MANAGED_BLOCK_START = '# >>> codex-mem managed codex-app integration >>>';
const MANAGED_BLOCK_END = '# <<< codex-mem managed codex-app integration <<<';
const CODEX_NOTIFY_EVENT = 'agent-turn-complete';
const DEFAULT_NOTIFY_DEBOUNCE_MS = 5000;
const DEFAULT_NOTIFY_LOCK_STALE_MS = 60000;
const DEFAULT_NOTIFY_LIMIT = 150;
const DEFAULT_NOTIFY_MAX_HISTORY_FILES = 100;

interface TopLevelCodexConfigValues {
  hasNotifications: boolean;
  hasNotify: boolean;
  notifications: string[];
  notifyCommand: string | null;
}

interface CodexAppInstallState {
  configPath: string;
  backupPath?: string;
  hadNotifications: boolean;
  hadNotify: boolean;
  previousNotifications: string[];
  previousNotifyCommand: string | null;
  installedAt: string;
}

function getCodexAppDataDirectory(): string {
  return SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
}

function getCodexAppInstallStatePath(): string {
  return join(getCodexAppDataDirectory(), 'codex-app-install-state.json');
}

function getCodexNotifyLockPath(): string {
  return join(getCodexAppDataDirectory(), 'codex-app-notify.lock');
}

function getCodexNotifyLastRunPath(): string {
  return join(getCodexAppDataDirectory(), 'codex-app-notify-last-run.txt');
}

function createBackupPath(configPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${configPath}.backup.${timestamp}`;
}

function escapeTomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseTopLevelToml(content: string): { topLevelLines: string[]; nonTopLevelLines: string[] } {
  const lines = content.split('\n');
  const firstTableIndex = lines.findIndex(line => /^\s*\[[^\]]+\]\s*$/.test(line));
  if (firstTableIndex === -1) {
    return { topLevelLines: lines, nonTopLevelLines: [] };
  }
  return {
    topLevelLines: lines.slice(0, firstTableIndex),
    nonTopLevelLines: lines.slice(firstTableIndex)
  };
}

function parseTomlStringArray(value: string): string[] {
  const values: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value)) !== null) {
    try {
      values.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      values.push(match[1]);
    }
  }

  return values;
}

function extractTopLevelConfigValues(topLevelLines: string[]): TopLevelCodexConfigValues {
  let hasNotifications = false;
  let hasNotify = false;
  let notifications: string[] = [];
  let notifyCommand: string | null = null;

  for (const rawLine of topLevelLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const notificationsMatch = line.match(/^notifications\s*=\s*\[(.*)\]\s*(?:#.*)?$/);
    if (notificationsMatch) {
      hasNotifications = true;
      notifications = parseTomlStringArray(notificationsMatch[1]);
      continue;
    }

    const notifyMatch = line.match(/^notify\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/);
    if (notifyMatch) {
      hasNotify = true;
      try {
        notifyCommand = JSON.parse(`"${notifyMatch[1]}"`) as string;
      } catch {
        notifyCommand = notifyMatch[1];
      }
    }
  }

  return {
    hasNotifications,
    hasNotify,
    notifications,
    notifyCommand
  };
}

function formatTomlStringArray(values: string[]): string {
  const normalizedValues = Array.from(new Set(values.filter(value => value.trim().length > 0)));
  const serializedValues = normalizedValues.map(value => escapeTomlString(value));
  return `[${serializedValues.join(', ')}]`;
}

function removeManagedBlock(content: string): string {
  const escapedStart = MANAGED_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = MANAGED_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const managedBlockRegex = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  return content.replace(managedBlockRegex, '');
}

function removeTopLevelKeys(topLevelLines: string[], keys: string[]): string[] {
  const keySet = new Set(keys);
  return topLevelLines.filter(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return true;

    for (const key of keySet) {
      const regex = new RegExp(`^${key}\\s*=`);
      if (regex.test(line)) return false;
    }
    return true;
  });
}

function insertManagedBlock(content: string, managedBlockLines: string[]): string {
  const { topLevelLines, nonTopLevelLines } = parseTopLevelToml(content);
  const cleanedTopLevelLines = removeTopLevelKeys(topLevelLines, ['notifications', 'notify']);
  const outputLines: string[] = [];

  const trimmedTopLevelLines = [...cleanedTopLevelLines];
  while (trimmedTopLevelLines.length > 0 && trimmedTopLevelLines[trimmedTopLevelLines.length - 1].trim() === '') {
    trimmedTopLevelLines.pop();
  }

  if (trimmedTopLevelLines.length > 0) {
    outputLines.push(...trimmedTopLevelLines);
    outputLines.push('');
  }

  outputLines.push(...managedBlockLines);

  if (nonTopLevelLines.length > 0) {
    outputLines.push('');
    outputLines.push(...nonTopLevelLines);
  }

  return `${outputLines.join('\n').replace(/\n+$/g, '')}\n`;
}

function restoreTopLevelKeys(content: string, installState: CodexAppInstallState | null): string {
  if (!installState) {
    return `${content.replace(/\n+$/g, '')}\n`;
  }

  const { topLevelLines, nonTopLevelLines } = parseTopLevelToml(content);
  const existingValues = extractTopLevelConfigValues(topLevelLines);
  const outputLines: string[] = [...topLevelLines];

  if (installState.hadNotifications && !existingValues.hasNotifications) {
    outputLines.push(`notifications = ${formatTomlStringArray(installState.previousNotifications)}`);
  }
  if (installState.hadNotify && !existingValues.hasNotify && installState.previousNotifyCommand) {
    outputLines.push(`notify = ${escapeTomlString(installState.previousNotifyCommand)}`);
  }

  const normalizedTopLevelLines = [...outputLines];
  while (normalizedTopLevelLines.length > 0 && normalizedTopLevelLines[normalizedTopLevelLines.length - 1].trim() === '') {
    normalizedTopLevelLines.pop();
  }

  const rebuiltLines = [...normalizedTopLevelLines];
  if (nonTopLevelLines.length > 0) {
    rebuiltLines.push('');
    rebuiltLines.push(...nonTopLevelLines);
  }

  return `${rebuiltLines.join('\n').replace(/\n+$/g, '')}\n`;
}

function readInstallState(): CodexAppInstallState | null {
  const installStatePath = getCodexAppInstallStatePath();
  if (!existsSync(installStatePath)) return null;

  try {
    return JSON.parse(readFileSync(installStatePath, 'utf-8')) as CodexAppInstallState;
  } catch {
    return null;
  }
}

function writeInstallState(installState: CodexAppInstallState): void {
  const installStatePath = getCodexAppInstallStatePath();
  mkdirSync(dirname(installStatePath), { recursive: true });
  writeFileSync(installStatePath, JSON.stringify(installState, null, 2), 'utf-8');
}

function clearInstallState(): void {
  const installStatePath = getCodexAppInstallStatePath();
  if (existsSync(installStatePath)) {
    unlinkSync(installStatePath);
  }
}

function buildNotifyCommand(workerServiceScriptPath: string): string {
  const resolvedWorkerScriptPath = resolve(workerServiceScriptPath);
  const escapedWorkerScriptPath = resolvedWorkerScriptPath.replace(/'/g, `'\\''`);
  return `bun '${escapedWorkerScriptPath}' codex-app notify-turn-complete`;
}

function readCodexConfig(): string {
  if (!existsSync(CODEX_APP_CONFIG_PATH)) return '';
  return readFileSync(CODEX_APP_CONFIG_PATH, 'utf-8');
}

function writeCodexConfig(content: string): void {
  mkdirSync(dirname(CODEX_APP_CONFIG_PATH), { recursive: true });
  writeFileSync(CODEX_APP_CONFIG_PATH, content, 'utf-8');
}

function getManagedBlockValues(configContent: string): TopLevelCodexConfigValues {
  const withoutManaged = removeManagedBlock(configContent);
  const { topLevelLines } = parseTopLevelToml(configContent);
  const { topLevelLines: topLevelWithoutManaged } = parseTopLevelToml(withoutManaged);
  const fullValues = extractTopLevelConfigValues(topLevelLines);
  const nonManagedValues = extractTopLevelConfigValues(topLevelWithoutManaged);

  // If managed block exists, values that exist in full but not in non-managed are from managed.
  if (configContent.includes(MANAGED_BLOCK_START)) {
    return {
      hasNotifications: fullValues.hasNotifications,
      hasNotify: fullValues.hasNotify,
      notifications: fullValues.notifications.length > 0 ? fullValues.notifications : nonManagedValues.notifications,
      notifyCommand: fullValues.notifyCommand || nonManagedValues.notifyCommand
    };
  }

  return fullValues;
}

function isCodexAppIntegrationInstalled(configContent: string): boolean {
  if (!configContent.includes(MANAGED_BLOCK_START) || !configContent.includes(MANAGED_BLOCK_END)) {
    return false;
  }

  const managedValues = getManagedBlockValues(configContent);
  const hasNotifyEvent = managedValues.notifications.includes(CODEX_NOTIFY_EVENT);
  const hasNotifyCommand = typeof managedValues.notifyCommand === 'string'
    && managedValues.notifyCommand.includes('codex-app notify-turn-complete');

  return hasNotifyEvent && hasNotifyCommand;
}

function readLastNotifyRunEpochMs(): number {
  const lastRunPath = getCodexNotifyLastRunPath();
  if (!existsSync(lastRunPath)) return 0;

  try {
    const value = Number(readFileSync(lastRunPath, 'utf-8').trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeLastNotifyRunEpochMs(epochMs: number): void {
  const lastRunPath = getCodexNotifyLastRunPath();
  mkdirSync(dirname(lastRunPath), { recursive: true });
  writeFileSync(lastRunPath, String(epochMs), 'utf-8');
}

function acquireNotifyLock(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs < DEFAULT_NOTIFY_LOCK_STALE_MS) {
      return false;
    }
    rmSync(lockPath, { force: true });
  }

  const lockFileDescriptor = openSync(lockPath, 'wx');
  closeSync(lockFileDescriptor);
  return true;
}

function releaseNotifyLock(lockPath: string): void {
  if (existsSync(lockPath)) {
    rmSync(lockPath, { force: true });
  }
}

export async function installCodexAppIntegration(workerServiceScriptPath: string): Promise<number> {
  const existingConfigContent = readCodexConfig();
  const cleanConfigContent = removeManagedBlock(existingConfigContent);
  const { topLevelLines } = parseTopLevelToml(cleanConfigContent);
  const previousValues = extractTopLevelConfigValues(topLevelLines);
  const notifyCommand = buildNotifyCommand(workerServiceScriptPath);
  const notifications = Array.from(new Set([...previousValues.notifications, CODEX_NOTIFY_EVENT]));

  let backupPath: string | undefined;
  if (existingConfigContent.trim().length > 0) {
    backupPath = createBackupPath(CODEX_APP_CONFIG_PATH);
    writeFileSync(backupPath, existingConfigContent, 'utf-8');
  }

  const managedBlockLines = [
    MANAGED_BLOCK_START,
    `notifications = ${formatTomlStringArray(notifications)}`,
    `notify = ${escapeTomlString(notifyCommand)}`,
    MANAGED_BLOCK_END
  ];

  const nextConfigContent = insertManagedBlock(cleanConfigContent, managedBlockLines);
  writeCodexConfig(nextConfigContent);

  writeInstallState({
    configPath: CODEX_APP_CONFIG_PATH,
    backupPath,
    hadNotifications: previousValues.hasNotifications,
    hadNotify: previousValues.hasNotify,
    previousNotifications: previousValues.notifications,
    previousNotifyCommand: previousValues.notifyCommand,
    installedAt: new Date().toISOString()
  });

  console.log(`Installed codex-app integration in ${CODEX_APP_CONFIG_PATH}`);
  if (backupPath) {
    console.log(`Backup written to ${backupPath}`);
  }
  return 0;
}

export function codexAppIntegrationStatus(): number {
  if (!existsSync(CODEX_APP_CONFIG_PATH)) {
    console.log(`Codex config not found at ${CODEX_APP_CONFIG_PATH}`);
    return 1;
  }

  const configContent = readCodexConfig();
  const managedValues = getManagedBlockValues(configContent);
  const installed = isCodexAppIntegrationInstalled(configContent);

  console.log(`Config: ${CODEX_APP_CONFIG_PATH}`);
  console.log(`Installed: ${installed ? 'yes' : 'no'}`);
  console.log(`Notify event configured: ${managedValues.notifications.includes(CODEX_NOTIFY_EVENT) ? 'yes' : 'no'}`);
  console.log(`Notify command: ${managedValues.notifyCommand || '(not set)'}`);
  return installed ? 0 : 1;
}

export function uninstallCodexAppIntegration(): number {
  if (!existsSync(CODEX_APP_CONFIG_PATH)) {
    console.log(`Codex config not found at ${CODEX_APP_CONFIG_PATH}`);
    clearInstallState();
    return 0;
  }

  const existingContent = readCodexConfig();
  const withoutManagedBlock = removeManagedBlock(existingContent);
  const installState = readInstallState();
  const restoredContent = restoreTopLevelKeys(withoutManagedBlock, installState);
  writeCodexConfig(restoredContent);
  clearInstallState();

  console.log(`Removed codex-app integration from ${CODEX_APP_CONFIG_PATH}`);
  return 0;
}

export async function runCodexNotifyCatchupIngestion(): Promise<number> {
  const nowEpochMs = Date.now();
  const lastRunEpochMs = readLastNotifyRunEpochMs();
  if (nowEpochMs - lastRunEpochMs < DEFAULT_NOTIFY_DEBOUNCE_MS) {
    console.log('Skipping codex notify ingestion (debounced)');
    return 0;
  }

  const lockPath = getCodexNotifyLockPath();
  if (!acquireNotifyLock(lockPath)) {
    console.log('Skipping codex notify ingestion (already running)');
    return 0;
  }

  try {
    const historyPaths = resolveDefaultCodexHistoryPaths();
    if (historyPaths.length === 0) {
      console.log('No Codex transcript files found for notify ingestion');
      writeLastNotifyRunEpochMs(nowEpochMs);
      return 0;
    }

    const ingestionResult = await runCodexHistoryIngestion({
      historyPaths,
      workspacePath: process.cwd(),
      includeSystem: false,
      skipSummaries: true,
      dryRun: false,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 300 },
      stateFilePath: getCodexIngestionStateFilePath(),
      port: getWorkerPort(),
      ensureWorkerAvailableFn: ensureWorkerAvailable,
      limit: DEFAULT_NOTIFY_LIMIT,
      maxHistoryFiles: DEFAULT_NOTIFY_MAX_HISTORY_FILES
    });

    writeLastNotifyRunEpochMs(nowEpochMs);
    console.log(
      `Codex notify ingestion complete: selected=${ingestionResult.selectedRecordCount}, ingested=${ingestionResult.ingestedRecordCount}`
    );
    return 0;
  } catch (error) {
    console.error(`Codex notify ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    releaseNotifyLock(lockPath);
  }
}

export async function handleCodexAppCommand(
  subcommand: string | undefined,
  workerServiceScriptPath: string
): Promise<number> {
  switch (subcommand) {
    case 'install':
      return await installCodexAppIntegration(workerServiceScriptPath);
    case 'status':
      return codexAppIntegrationStatus();
    case 'uninstall':
      return uninstallCodexAppIntegration();
    case 'notify-turn-complete':
      return await runCodexNotifyCatchupIngestion();
    default:
      console.log(`
Codex-Mem Codex App Integration

Usage: codex-mem codex-app <command>

Commands:
  install               Configure ~/.codex/config.toml notify integration
  status                Show current integration status
  uninstall             Remove codex-mem managed codex app integration
  notify-turn-complete  Internal handler invoked by Codex notify
      `);
      return 0;
  }
}

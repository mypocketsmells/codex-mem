import { spawnSync } from 'child_process';
import { logger } from '../../utils/logger.js';

export type OllamaModelDiscoverySource = 'api' | 'cli' | 'none';

export interface OllamaModelDiscoveryResult {
  models: string[];
  source: OllamaModelDiscoverySource;
  error?: string;
}

interface OllamaModelTagResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

interface OllamaCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface OllamaModelDiscoveryOptions {
  fetchFn?: typeof fetch;
  cliListRunner?: (timeoutMs: number) => OllamaCliResult;
  timeoutMs?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;

function normalizeBaseUrl(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim();
  return trimmedBaseUrl.replace(/\/+$/, '');
}

function normalizeModelNames(modelNames: string[]): string[] {
  const uniqueModels = new Set<string>();
  for (const modelName of modelNames) {
    const trimmedName = modelName.trim();
    if (trimmedName) uniqueModels.add(trimmedName);
  }
  return Array.from(uniqueModels).sort((left, right) => left.localeCompare(right));
}

function parseApiModelNames(responseBody: OllamaModelTagResponse): string[] {
  if (!responseBody.models || !Array.isArray(responseBody.models)) {
    return [];
  }

  const names: string[] = [];
  for (const modelEntry of responseBody.models) {
    if (typeof modelEntry.name === 'string' && modelEntry.name.trim()) {
      names.push(modelEntry.name);
      continue;
    }
    if (typeof modelEntry.model === 'string' && modelEntry.model.trim()) {
      names.push(modelEntry.model);
    }
  }

  return normalizeModelNames(names);
}

export function parseOllamaListOutput(stdout: string): string[] {
  const modelNames: string[] = [];
  const lines = stdout.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (/^name\s+/i.test(trimmedLine)) continue;

    const firstColumn = trimmedLine.split(/\s+/)[0];
    if (firstColumn && firstColumn !== 'NAME') {
      modelNames.push(firstColumn);
    }
  }

  return normalizeModelNames(modelNames);
}

function runOllamaList(timeoutMs: number): OllamaCliResult {
  const result = spawnSync('ollama', ['list'], {
    encoding: 'utf-8',
    timeout: timeoutMs
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  };
}

async function listViaApi(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<string[]> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Ollama API /api/tags returned ${response.status}`);
    }

    const responseBody = await response.json() as OllamaModelTagResponse;
    return parseApiModelNames(responseBody);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function listViaCli(timeoutMs: number, cliListRunner: (timeoutMs: number) => OllamaCliResult): OllamaModelDiscoveryResult {
  const cliResult = cliListRunner(timeoutMs);
  if (cliResult.error) {
    return {
      models: [],
      source: 'none',
      error: cliResult.error.message
    };
  }

  if (cliResult.status !== 0) {
    const errorMessage = (cliResult.stderr || '').trim() || `ollama list exited with status ${cliResult.status}`;
    return {
      models: [],
      source: 'none',
      error: errorMessage
    };
  }

  const parsedModels = parseOllamaListOutput(cliResult.stdout);
  return {
    models: parsedModels,
    source: 'cli'
  };
}

export async function listInstalledOllamaModels(
  baseUrl: string,
  options: OllamaModelDiscoveryOptions = {}
): Promise<OllamaModelDiscoveryResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const cliListRunner = options.cliListRunner ?? runOllamaList;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  try {
    const apiModels = await listViaApi(normalizedBaseUrl, fetchFn, timeoutMs);
    return {
      models: apiModels,
      source: 'api'
    };
  } catch (apiError) {
    const apiErrorMessage = apiError instanceof Error ? apiError.message : String(apiError);
    logger.debug('SDK', 'Ollama model API discovery failed; attempting CLI fallback', {
      baseUrl: normalizedBaseUrl,
      timeoutMs,
      error: apiErrorMessage
    });

    const cliResult = listViaCli(timeoutMs, cliListRunner);
    if (cliResult.source === 'cli') {
      return cliResult;
    }

    const cliErrorMessage = cliResult.error ? `; CLI fallback failed: ${cliResult.error}` : '';
    return {
      models: [],
      source: 'none',
      error: `API discovery failed: ${apiErrorMessage}${cliErrorMessage}`
    };
  }
}

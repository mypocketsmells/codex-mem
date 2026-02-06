/**
 * Codex-mem MCP Search Server - Thin HTTP Wrapper
 *
 * Refactored from 2,718 lines to ~600-800 lines
 * Delegates all business logic to Worker HTTP API at localhost:37777
 * Maintains MCP protocol handling and tool schemas
 */

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

// Import logger first
import { logger } from '../utils/logger.js';

// CRITICAL: Redirect console to stderr BEFORE other imports
// MCP uses stdio transport where stdout is reserved for JSON-RPC protocol messages.
// Any logs to stdout break the protocol (Claude Desktop parses "[2025..." as JSON array).
const _originalLog = console['log'];
console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';

/**
 * Worker HTTP API configuration
 */
const WORKER_PORT = getWorkerPort();
const WORKER_HOST = getWorkerHost();
const WORKER_BASE_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;
const WORKER_HEALTH_URL = `${WORKER_BASE_URL}/api/health`;

const WORKER_HEALTH_CHECK_TIMEOUT_MS = 1500;
const WORKER_STARTUP_WAIT_TIMEOUT_MS = 35000;
const WORKER_STARTUP_POLL_INTERVAL_MS = 500;

let workerStartupPromise: Promise<boolean> | null = null;

interface WorkerStartResult {
  success: boolean;
  message: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function getCurrentDirectory(): string {
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    return __dirname;
  }

  return process.cwd();
}

function resolveWorkerServiceScriptPath(): string | null {
  const scriptDirectory = getCurrentDirectory();
  const candidatePaths = [
    process.env.CLAUDE_PLUGIN_ROOT
      ? path.join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'worker-service.cjs')
      : null,
    process.env.CODEX_MEM_INSTALL_ROOT
      ? path.join(process.env.CODEX_MEM_INSTALL_ROOT, 'plugin', 'scripts', 'worker-service.cjs')
      : null,
    process.env.CLAUDE_MEM_INSTALL_ROOT
      ? path.join(process.env.CLAUDE_MEM_INSTALL_ROOT, 'plugin', 'scripts', 'worker-service.cjs')
      : null,
    path.join(scriptDirectory, 'worker-service.cjs'),
    path.join(scriptDirectory, '../services/worker-service.js'),
    path.join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function parseWorkerStartOutput(stdout: string): WorkerStartResult {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as { status?: string; message?: string };
      if (parsed.status === 'ready') {
        return { success: true, message: 'Worker reported ready' };
      }
      if (parsed.status === 'error') {
        return {
          success: false,
          message: parsed.message || 'Worker reported startup error'
        };
      }
    } catch {
      // Ignore parse failures and continue scanning previous lines.
    }
  }

  return {
    success: false,
    message: 'Worker start command did not return JSON status'
  };
}

function startWorkerViaCli(): WorkerStartResult {
  const workerServiceScriptPath = resolveWorkerServiceScriptPath();
  if (!workerServiceScriptPath) {
    return {
      success: false,
      message: 'Could not locate worker-service.cjs'
    };
  }

  const bunExecutable = process.env.BUN_PATH || 'bun';
  const startCommand = spawnSync(
    bunExecutable,
    [workerServiceScriptPath, 'start'],
    {
      env: {
        ...process.env,
        CLAUDE_MEM_WORKER_HOST: WORKER_HOST,
        CLAUDE_MEM_WORKER_PORT: String(WORKER_PORT),
        CODEX_MEM_WORKER_HOST: WORKER_HOST,
        CODEX_MEM_WORKER_PORT: String(WORKER_PORT),
      },
      encoding: 'utf-8',
      timeout: WORKER_STARTUP_WAIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  if (startCommand.error) {
    return {
      success: false,
      message: `Failed to run worker start command: ${startCommand.error.message}`
    };
  }

  const parsedStatus = parseWorkerStartOutput(startCommand.stdout || '');
  if (!parsedStatus.success) {
    const stderr = (startCommand.stderr || '').trim();
    return {
      success: false,
      message: stderr ? `${parsedStatus.message} (${stderr})` : parsedStatus.message
    };
  }

  return parsedStatus;
}

/**
 * Map tool names to Worker HTTP endpoints
 */
const TOOL_ENDPOINT_MAP: Record<string, string> = {
  'search': '/api/search',
  'timeline': '/api/timeline'
};

/**
 * Call Worker HTTP API endpoint
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('SYSTEM', '→ Worker API', undefined, { endpoint, params });

  try {
    const workerReady = await ensureWorkerAvailable(`GET ${endpoint}`);
    if (!workerReady) {
      return {
        content: [{
          type: 'text' as const,
          text: `Worker API unavailable at ${WORKER_BASE_URL}. Start it manually with: npm run worker:restart`
        }],
        isError: true
      };
    }

    const searchParams = new URLSearchParams();

    // Convert params to query string
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }

    const url = `${WORKER_BASE_URL}${endpoint}?${searchParams}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (firstRequestError) {
      logger.warn('SYSTEM', 'Worker API request failed; retrying after health check', { endpoint });
      const recovered = await ensureWorkerAvailable(`retry GET ${endpoint}`);
      if (!recovered) throw firstRequestError;
      response = await fetch(url);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

    logger.debug('SYSTEM', '← Worker API success', undefined, { endpoint });

    // Worker returns { content: [...] } format directly
    return data;
  } catch (error) {
    logger.error('SYSTEM', '← Worker API error', { endpoint }, error as Error);
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Call Worker HTTP API with POST body
 */
async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('HTTP', 'Worker API request (POST)', undefined, { endpoint });

  try {
    const workerReady = await ensureWorkerAvailable(`POST ${endpoint}`);
    if (!workerReady) {
      return {
        content: [{
          type: 'text' as const,
          text: `Worker API unavailable at ${WORKER_BASE_URL}. Start it manually with: npm run worker:restart`
        }],
        isError: true
      };
    }

    const url = `${WORKER_BASE_URL}${endpoint}`;
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    let response: Response;
    try {
      response = await fetch(url, requestInit);
    } catch (firstRequestError) {
      logger.warn('HTTP', 'Worker API POST failed; retrying after health check', { endpoint });
      const recovered = await ensureWorkerAvailable(`retry POST ${endpoint}`);
      if (!recovered) throw firstRequestError;
      response = await fetch(url, requestInit);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    logger.debug('HTTP', 'Worker API success (POST)', undefined, { endpoint });

    // Wrap raw data in MCP format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error) {
    logger.error('HTTP', 'Worker API error (POST)', { endpoint }, error as Error);
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Verify Worker is accessible
 */
async function verifyWorkerConnection(): Promise<boolean> {
  try {
    const response = await fetch(WORKER_HEALTH_URL, {
      signal: AbortSignal.timeout(WORKER_HEALTH_CHECK_TIMEOUT_MS)
    });
    return response.ok;
  } catch (error) {
    // Expected during worker startup or if worker is down
    logger.debug('SYSTEM', 'Worker health check failed', {}, error as Error);
    return false;
  }
}

async function waitForWorkerConnection(timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    if (await verifyWorkerConnection()) {
      return true;
    }
    await sleep(WORKER_STARTUP_POLL_INTERVAL_MS);
  }

  return false;
}

async function ensureWorkerAvailable(reason: string): Promise<boolean> {
  if (await verifyWorkerConnection()) {
    return true;
  }

  if (!workerStartupPromise) {
    workerStartupPromise = (async (): Promise<boolean> => {
      logger.warn('SYSTEM', 'Worker unavailable; attempting auto-start', {
        reason,
        workerUrl: WORKER_BASE_URL
      });

      const startResult = startWorkerViaCli();
      if (!startResult.success) {
        logger.error('SYSTEM', 'Worker auto-start failed', undefined, {
          reason,
          workerUrl: WORKER_BASE_URL,
          message: startResult.message
        });
        return false;
      }

      const becameHealthy = await waitForWorkerConnection(WORKER_STARTUP_WAIT_TIMEOUT_MS);
      if (!becameHealthy) {
        logger.error('SYSTEM', 'Worker failed health check after auto-start', undefined, {
          reason,
          workerUrl: WORKER_BASE_URL,
          timeoutMs: WORKER_STARTUP_WAIT_TIMEOUT_MS
        });
        return false;
      }

      logger.info('SYSTEM', 'Worker auto-started successfully', {
        reason,
        workerUrl: WORKER_BASE_URL
      });

      return true;
    })().finally(() => {
      workerStartupPromise = null;
    });
  } else {
    logger.info('SYSTEM', 'Worker startup already in progress', { reason });
  }

  return workerStartupPromise;
}

/**
 * Tool definitions with HTTP-based handlers
 * Minimal descriptions - use help() tool with operation parameter for detailed docs
 */
const tools = [
  {
    name: '__IMPORTANT',
    description: `3-LAYER WORKFLOW (ALWAYS FOLLOW):
1. search(query) → Get index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID) → Get context around interesting results
3. get_observations([IDs]) → Fetch full details ONLY for filtered IDs
NEVER fetch full details without filtering first. 10x token savings.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# Memory Search Workflow

**3-Layer Pattern (ALWAYS follow this):**

1. **Search** - Get index of results with IDs
   \`search(query="...", limit=20, project="...")\`
   Returns: Table with IDs, titles, dates (~50-100 tokens/result)

2. **Timeline** - Get context around interesting results
   \`timeline(anchor=<ID>, depth_before=3, depth_after=3)\`
   Returns: Chronological context showing what was happening

3. **Fetch** - Get full details ONLY for relevant IDs
   \`get_observations(ids=[...])\`  # ALWAYS batch for 2+ items
   Returns: Complete details (~500-1000 tokens/result)

**Why:** 10x token savings. Never fetch full details without filtering first.`
      }]
    })
  },
  {
    name: 'search',
    description: 'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, type, obs_type, dateStart, dateEnd, offset, orderBy',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'timeline',
    description: 'Step 2: Get context around results. Params: anchor (observation ID) OR query (finds anchor automatically), depth_before, depth_after, project',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_observations',
    description: 'Step 3: Fetch full details for filtered IDs. Params: ids (array of observation IDs, required), orderBy, limit, project',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of observation IDs to fetch (required)'
        }
      },
      required: ['ids'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPIPost('/api/observations/batch', args);
    }
  }
];

// Create the MCP server
const server = new Server(
  {
    name: 'mcp-search-server',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},  // Exposes tools capability (handled by ListToolsRequestSchema and CallToolRequestSchema)
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error) {
    logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error as Error);
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

// Cleanup function
async function cleanup() {
  logger.info('SYSTEM', 'MCP server shutting down');
  process.exit(0);
}

// Register cleanup handlers for graceful shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Start the server
async function main() {
  // Start the MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('SYSTEM', 'Codex-mem search server started');

  // Check Worker availability in background
  setTimeout(async () => {
    const workerAvailable = await ensureWorkerAvailable('mcp startup');
    if (!workerAvailable) {
      logger.error('SYSTEM', 'Worker not available after auto-start attempt', undefined, { workerUrl: WORKER_BASE_URL });
      logger.error('SYSTEM', 'Tools may fail until Worker is started');
      logger.error('SYSTEM', 'Start Worker with: npm run worker:restart');
    } else {
      logger.info('SYSTEM', 'Worker available', undefined, { workerUrl: WORKER_BASE_URL });
    }
  }, 0);
}

main().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  // Exit gracefully: Windows Terminal won't keep tab open on exit 0
  // The wrapper/plugin will handle restart logic if needed
  process.exit(0);
});

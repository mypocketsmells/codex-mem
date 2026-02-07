import { describe, it, expect } from 'bun:test';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootPath = path.resolve(__dirname, '../..');
const mcpServerScriptPath = path.join(projectRootPath, 'plugin/scripts/mcp-server.cjs');

function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMilliseconds}ms`)), timeoutMilliseconds);
    })
  ]);
}

describe('mcp-stdio-smoke', () => {
  it('supports tools/list and tools/call for search, timeline, and get_observations over stdio transport', async () => {
    if (!existsSync(mcpServerScriptPath)) {
      console.log('Skipping MCP stdio smoke test - plugin/scripts/mcp-server.cjs not found. Run npm run build first.');
      return;
    }

    const mcpClient = new Client(
      { name: 'codex-mem-mcp-smoke-test', version: '1.0.0' },
      { capabilities: {} }
    );

    const stdioTransport = new StdioClientTransport({
      command: 'node',
      args: [mcpServerScriptPath],
      cwd: projectRootPath,
      stderr: 'pipe'
    });

    try {
      await withTimeout(mcpClient.connect(stdioTransport), 15_000, 'MCP client connect');

      const listToolsResult = await withTimeout(mcpClient.listTools(), 10_000, 'MCP tools/list');
      const toolNames = listToolsResult.tools.map(tool => tool.name);

      expect(toolNames).toContain('search');
      expect(toolNames).toContain('timeline');
      expect(toolNames).toContain('get_observations');

      const searchToolResult = await withTimeout(
        mcpClient.callTool({
          name: 'search',
          arguments: { query: 'codex-mem', limit: 1 }
        }),
        20_000,
        'MCP tools/call(search)'
      );

      expect(searchToolResult.content.length).toBeGreaterThan(0);
      expect(searchToolResult.isError).not.toBe(true);

      const firstSearchContentBlock = searchToolResult.content[0];
      expect(firstSearchContentBlock.type).toBe('text');
      let searchText = '';
      if (firstSearchContentBlock.type === 'text') {
        searchText = firstSearchContentBlock.text;
        expect(searchText.length).toBeGreaterThan(0);
      }

      const timelineToolResult = await withTimeout(
        mcpClient.callTool({
          name: 'timeline',
          arguments: { query: 'codex-mem', depth_before: 1, depth_after: 1 }
        }),
        20_000,
        'MCP tools/call(timeline)'
      );

      expect(timelineToolResult.content.length).toBeGreaterThan(0);
      expect(timelineToolResult.isError).not.toBe(true);
      const firstTimelineContentBlock = timelineToolResult.content[0];
      expect(firstTimelineContentBlock.type).toBe('text');
      if (firstTimelineContentBlock.type === 'text') {
        expect(firstTimelineContentBlock.text.length).toBeGreaterThan(0);
      }

      const firstObservationIdMatch = searchText.match(/#(\d+)/);
      const firstObservationId = firstObservationIdMatch ? Number.parseInt(firstObservationIdMatch[1], 10) : 1;

      const getObservationsToolResult = await withTimeout(
        mcpClient.callTool({
          name: 'get_observations',
          arguments: { ids: [firstObservationId], limit: 1 }
        }),
        20_000,
        'MCP tools/call(get_observations)'
      );

      expect(getObservationsToolResult.content.length).toBeGreaterThan(0);
      expect(getObservationsToolResult.isError).not.toBe(true);
      const firstGetObservationsContentBlock = getObservationsToolResult.content[0];
      expect(firstGetObservationsContentBlock.type).toBe('text');
      if (firstGetObservationsContentBlock.type === 'text') {
        expect(firstGetObservationsContentBlock.text.length).toBeGreaterThan(0);
      }
    } finally {
      await withTimeout(stdioTransport.close(), 5_000, 'MCP transport close');
    }
  }, 60_000);
});

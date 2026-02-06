import { describe, it, expect } from 'bun:test';
import { codexAdapter } from '../../src/cli/adapters/codex.js';

describe('codexAdapter', () => {
  it('normalizes prompt/text history records', () => {
    const normalized = codexAdapter.normalizeInput({
      session_id: 'abc123',
      workspace: '/tmp/repo',
      text: 'Refactor auth middleware'
    });

    expect(normalized.sessionId).toBe('abc123');
    expect(normalized.cwd).toBe('/tmp/repo');
    expect(normalized.prompt).toBe('Refactor auth middleware');
  });

  it('maps shell command/output records to Bash observations', () => {
    const normalized = codexAdapter.normalizeInput({
      sessionId: 's-1',
      cwd: '/workspace/project',
      command: 'npm test',
      output: 'PASS tests/shared/settings-defaults-manager.test.ts'
    });

    expect(normalized.sessionId).toBe('s-1');
    expect(normalized.toolName).toBe('Bash');
    expect(normalized.toolInput).toEqual({ command: 'npm test' });
    expect(normalized.toolResponse).toEqual({ output: 'PASS tests/shared/settings-defaults-manager.test.ts' });
  });

  it('preserves explicit tool fields when provided', () => {
    const normalized = codexAdapter.normalizeInput({
      codex_session_id: 'session-77',
      workspace_root: '/repo',
      prompt: 'Track this event',
      tool_name: 'ReadFile',
      tool_input: { path: 'README.md' },
      tool_response: { content: 'hello' }
    });

    expect(normalized.sessionId).toBe('session-77');
    expect(normalized.cwd).toBe('/repo');
    expect(normalized.toolName).toBe('ReadFile');
    expect(normalized.toolInput).toEqual({ path: 'README.md' });
    expect(normalized.toolResponse).toEqual({ content: 'hello' });
  });
});

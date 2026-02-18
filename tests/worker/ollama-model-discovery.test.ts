import { describe, expect, it, mock } from 'bun:test';
import { listInstalledOllamaModels, parseOllamaListOutput } from '../../src/services/worker/OllamaModelDiscovery.js';

describe('OllamaModelDiscovery', () => {
  it('returns API models when /api/tags succeeds', async () => {
    const fetchFn = mock(async () => {
      return new Response(
        JSON.stringify({
          models: [
            { name: 'gemma3:12b' },
            { name: 'gemma3:4b' },
            { name: 'gemma3:4b' }
          ]
        }),
        { status: 200 }
      );
    });

    const cliRunner = mock(() => ({
      status: 0,
      stdout: 'NAME ID SIZE MODIFIED\nphi4:latest abc 1gb now\n',
      stderr: ''
    }));

    const result = await listInstalledOllamaModels('http://localhost:11434', {
      fetchFn: fetchFn as unknown as typeof fetch,
      cliListRunner: cliRunner
    });

    expect(result.source).toBe('api');
    expect(result.models).toEqual(['gemma3:12b', 'gemma3:4b']);
    expect(cliRunner).not.toHaveBeenCalled();
  });

  it('falls back to ollama list when API discovery fails', async () => {
    const fetchFn = mock(async () => {
      throw new Error('network unreachable');
    });

    const cliRunner = mock(() => ({
      status: 0,
      stdout: 'NAME          ID              SIZE      MODIFIED\ngemma3:4b     a2af6cc3eb7f    3.3 GB    11 minutes ago\ngemma3:12b    f4031aab637d    8.1 GB    13 minutes ago\n',
      stderr: ''
    }));

    const result = await listInstalledOllamaModels('http://localhost:11434', {
      fetchFn: fetchFn as unknown as typeof fetch,
      cliListRunner: cliRunner
    });

    expect(result.source).toBe('cli');
    expect(result.models).toEqual(['gemma3:12b', 'gemma3:4b']);
  });

  it('returns source none when API and CLI discovery both fail', async () => {
    const fetchFn = mock(async () => {
      throw new Error('api unavailable');
    });

    const cliRunner = mock(() => ({
      status: 1,
      stdout: '',
      stderr: 'ollama not found'
    }));

    const result = await listInstalledOllamaModels('http://localhost:11434', {
      fetchFn: fetchFn as unknown as typeof fetch,
      cliListRunner: cliRunner
    });

    expect(result.source).toBe('none');
    expect(result.models).toEqual([]);
    expect(result.error).toContain('API discovery failed');
  });

  it('parses ollama list output into model names', () => {
    const parsed = parseOllamaListOutput(
      'NAME          ID              SIZE      MODIFIED\n' +
      'gemma3:4b     a2af6cc3eb7f    3.3 GB    11 minutes ago\n' +
      'gemma3:12b    f4031aab637d    8.1 GB    13 minutes ago\n'
    );

    expect(parsed).toEqual(['gemma3:12b', 'gemma3:4b']);
  });
});

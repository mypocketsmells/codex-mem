import { describe, expect, it } from 'bun:test';
import { SettingsRoutes } from '../../../src/services/worker/http/routes/SettingsRoutes.js';

describe('SettingsRoutes codex model validation', () => {
  it('rejects gpt-4 when codex provider is selected', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'codex',
      CLAUDE_MEM_CODEX_MODEL: 'gpt-4'
    });

    expect(validationResult.valid).toBe(false);
    expect(validationResult.error).toContain('gpt-4');
  });

  it('accepts gpt-5 when codex provider is selected', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'codex',
      CLAUDE_MEM_CODEX_MODEL: 'gpt-5'
    });

    expect(validationResult.valid).toBe(true);
  });

  it('accepts ollama provider with valid ollama settings', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_MODE: 'native',
      CLAUDE_MEM_OLLAMA_BASE_URL: 'http://localhost:11434',
      CLAUDE_MEM_OLLAMA_MODEL: 'gemma3:4b',
      CLAUDE_MEM_OLLAMA_TIMEOUT_MS: '120000',
      CLAUDE_MEM_OLLAMA_TEMPERATURE: '0.2',
      CLAUDE_MEM_OLLAMA_NUM_CTX: '8192',
      CLAUDE_MEM_OLLAMA_OPTIONS_JSON: '{"top_p":0.9}'
    });

    expect(validationResult.valid).toBe(true);
  });

  it('rejects invalid ollama mode', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_MODE: 'invalid-mode'
    });

    expect(validationResult.valid).toBe(false);
    expect(validationResult.error).toContain('CLAUDE_MEM_OLLAMA_MODE');
  });

  it('rejects invalid ollama base URL', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_BASE_URL: 'not-a-url'
    });

    expect(validationResult.valid).toBe(false);
    expect(validationResult.error).toContain('CLAUDE_MEM_OLLAMA_BASE_URL');
  });

  it('rejects empty ollama model', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_MODEL: '   '
    });

    expect(validationResult.valid).toBe(false);
    expect(validationResult.error).toContain('CLAUDE_MEM_OLLAMA_MODEL');
  });

  it('rejects out-of-range ollama timeout', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_TIMEOUT_MS: '999'
    });

    expect(validationResult.valid).toBe(false);
    expect(validationResult.error).toContain('CLAUDE_MEM_OLLAMA_TIMEOUT_MS');
  });

  it('rejects out-of-range ollama temperature', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_TEMPERATURE: '2.5'
    });

    expect(validationResult.valid).toBe(false);
    expect(validationResult.error).toContain('CLAUDE_MEM_OLLAMA_TEMPERATURE');
  });

  it('rejects out-of-range ollama num_ctx', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_NUM_CTX: '128'
    });

    expect(validationResult.valid).toBe(false);
    expect(validationResult.error).toContain('CLAUDE_MEM_OLLAMA_NUM_CTX');
  });

  it('rejects non-object ollama options json', () => {
    const routes = new SettingsRoutes({} as any);

    const validationResult = (routes as any).validateSettings({
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_OPTIONS_JSON: '[]'
    });

    expect(validationResult.valid).toBe(false);
    expect(validationResult.error).toContain('CLAUDE_MEM_OLLAMA_OPTIONS_JSON');
  });

  it('masks API key settings for client responses', () => {
    const routes = new SettingsRoutes({} as any);

    const safeSettings = (routes as any).getSafeSettingsForClient({
      CLAUDE_MEM_GEMINI_API_KEY: 'AIzaSyExampleGeminiKey1234567890',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'openrouter-example-key',
      CLAUDE_MEM_PROVIDER: 'gemini'
    });

    expect(safeSettings.CLAUDE_MEM_GEMINI_API_KEY).toBe('__MASKED_SECRET__:7890');
    expect(safeSettings.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('__MASKED_SECRET__:-key');
    expect(safeSettings.CLAUDE_MEM_PROVIDER).toBe('gemini');
  });

  it('detects masked setting sentinel values', () => {
    const routes = new SettingsRoutes({} as any);

    expect((routes as any).isMaskedSettingValue('__MASKED_SECRET__:abcd')).toBe(true);
    expect((routes as any).isMaskedSettingValue('AIzaSyRealKeyValue')).toBe(false);
    expect((routes as any).isMaskedSettingValue('')).toBe(false);
  });
});

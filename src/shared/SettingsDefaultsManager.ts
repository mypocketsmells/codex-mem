/**
 * SettingsDefaultsManager
 *
 * Single source of truth for all default configuration values.
 * Provides methods to get defaults with optional environment variable overrides.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { DEFAULT_OBSERVATION_TYPES_STRING, DEFAULT_OBSERVATION_CONCEPTS_STRING } from '../constants/observation-metadata.js';
import { CANONICAL_PRODUCT_NAME, resolveDefaultDataDir } from './product-config.js';
// NOTE: Do NOT import logger here - it creates a circular dependency
// logger.ts depends on SettingsDefaultsManager for its initialization

export interface SettingsDefaults {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;
  CLAUDE_MEM_SKIP_TOOLS: string;
  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER: string;  // 'codex' | 'claude' | 'gemini' | 'openrouter' | 'ollama'
  CLAUDE_MEM_PROVIDER_FALLBACK_POLICY: string; // 'auto' | 'off' | 'codex' | 'sdk'
  CLAUDE_MEM_CODEX_MODEL: string;
  CLAUDE_MEM_CODEX_REASONING_EFFORT: string;  // 'minimal' | 'low' | 'medium' | 'high'
  CLAUDE_MEM_CLAUDE_AUTH_METHOD: string;  // 'cli' | 'api' - how Claude provider authenticates
  CLAUDE_MEM_GEMINI_API_KEY: string;
  CLAUDE_MEM_GEMINI_MODEL: string;  // 'gemini-2.5-flash-lite' | 'gemini-2.5-flash' | 'gemini-3-flash'
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: string;  // 'true' | 'false' - enable rate limiting for free tier
  CLAUDE_MEM_OPENROUTER_API_KEY: string;
  CLAUDE_MEM_OPENROUTER_MODEL: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME: string;
  CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: string;
  CLAUDE_MEM_OPENROUTER_MAX_TOKENS: string;
  CLAUDE_MEM_OLLAMA_MODE: string; // 'native' | 'codex_bridge'
  CLAUDE_MEM_OLLAMA_BASE_URL: string;
  CLAUDE_MEM_OLLAMA_MODEL: string;
  CLAUDE_MEM_OLLAMA_TIMEOUT_MS: string;
  CLAUDE_MEM_OLLAMA_TEMPERATURE: string;
  CLAUDE_MEM_OLLAMA_NUM_CTX: string;
  CLAUDE_MEM_OLLAMA_OPTIONS_JSON: string;
  // System Configuration
  CLAUDE_MEM_DATA_DIR: string;
  CLAUDE_MEM_LOG_LEVEL: string;
  CLAUDE_MEM_PYTHON_VERSION: string;
  CLAUDE_CODE_PATH: string;
  CLAUDE_MEM_MODE: string;
  // Token Economics
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  // Observation Filtering
  CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: string;
  CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: string;
  // Display Configuration
  CLAUDE_MEM_CONTEXT_FULL_COUNT: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: string;
  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
}

export class SettingsDefaultsManager {
  private static readonly warnedDeprecationKeys = new Set<string>();

  /**
   * Default values for all settings
   */
  private static readonly DEFAULTS: SettingsDefaults = {
    CLAUDE_MEM_MODEL: 'claude-sonnet-4-5',
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
    CLAUDE_MEM_WORKER_PORT: '37777',
    CLAUDE_MEM_WORKER_HOST: 'localhost',
    CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    // AI Provider Configuration
    CLAUDE_MEM_PROVIDER: 'codex',  // Default to Codex
    CLAUDE_MEM_PROVIDER_FALLBACK_POLICY: 'auto', // Prefer Codex fallback; SDK if Codex unavailable
    CLAUDE_MEM_CODEX_MODEL: 'gpt-5',
    CLAUDE_MEM_CODEX_REASONING_EFFORT: 'high',
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'cli',  // Default to CLI subscription billing (not API key)
    CLAUDE_MEM_GEMINI_API_KEY: '',  // Empty by default, can be set via UI or env
    CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',  // Default Gemini model (highest free tier RPM)
    CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',  // Rate limiting ON by default for free tier users
    CLAUDE_MEM_OPENROUTER_API_KEY: '',  // Empty by default, can be set via UI or env
    CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',  // Default OpenRouter model (free tier)
    CLAUDE_MEM_OPENROUTER_SITE_URL: '',  // Optional: for OpenRouter analytics
    CLAUDE_MEM_OPENROUTER_APP_NAME: CANONICAL_PRODUCT_NAME,  // App name for OpenRouter analytics
    CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',  // Max messages in context window
    CLAUDE_MEM_OPENROUTER_MAX_TOKENS: '100000',  // Max estimated tokens (~100k safety limit)
    CLAUDE_MEM_OLLAMA_MODE: 'native',
    CLAUDE_MEM_OLLAMA_BASE_URL: 'http://localhost:11434',
    CLAUDE_MEM_OLLAMA_MODEL: 'gemma3:4b',
    CLAUDE_MEM_OLLAMA_TIMEOUT_MS: '120000',
    CLAUDE_MEM_OLLAMA_TEMPERATURE: '0.2',
    CLAUDE_MEM_OLLAMA_NUM_CTX: '8192',
    CLAUDE_MEM_OLLAMA_OPTIONS_JSON: '{}',
    // System Configuration
    CLAUDE_MEM_DATA_DIR: resolveDefaultDataDir(),
    CLAUDE_MEM_LOG_LEVEL: 'INFO',
    CLAUDE_MEM_PYTHON_VERSION: '3.13',
    CLAUDE_CODE_PATH: '', // Empty means auto-detect via 'which claude'
    CLAUDE_MEM_MODE: 'code', // Default mode profile
    // Token Economics
    CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
    CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    // Observation Filtering
    CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: DEFAULT_OBSERVATION_TYPES_STRING,
    CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: DEFAULT_OBSERVATION_CONCEPTS_STRING,
    // Display Configuration
    CLAUDE_MEM_CONTEXT_FULL_COUNT: '5',
    CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
    CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',
    // Feature Toggles
    CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
  };

  /**
   * Get all defaults as an object
   */
  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  /**
   * Get a default value from defaults (no environment variable override)
   */
  static get(key: keyof SettingsDefaults): string {
    return this.DEFAULTS[key];
  }

  /**
   * Get an integer default value
   */
  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  /**
   * Get a boolean default value
   */
  static getBool(key: keyof SettingsDefaults): boolean {
    const value = this.get(key);
    return value === 'true';
  }

  /**
   * Test helper to reset deprecation warning state between test cases.
   */
  static resetDeprecationWarningsForTests(): void {
    this.warnedDeprecationKeys.clear();
  }

  /**
   * Load settings from file with fallback to defaults
   * Returns merged settings with defaults as fallback
   * Handles all errors (missing file, corrupted JSON, permissions) by returning defaults
   */
  static loadFromFile(settingsPath: string): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          // Use console instead of logger to avoid circular dependency
          console.log('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error);
        }
        return this.applyEnvironmentOverrides(defaults);
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);

      // MIGRATION: Handle old nested schema { env: {...} }
      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        // Migrate from nested to flat schema
        flatSettings = settings.env;

        // Auto-migrate the file to flat schema
        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), 'utf-8');
          console.log('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error);
          // Continue with in-memory migration even if write fails
        }
      }

      // Merge file settings with defaults (flat schema)
      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      return this.applyEnvironmentOverrides(result);
    } catch (error) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error);
      return this.applyEnvironmentOverrides(this.getAllDefaults());
    }
  }

  /**
   * Apply environment variable overrides with compatibility guards.
   * Supports both legacy CLAUDE_MEM_* and canonical CODEX_MEM_* keys.
   */
  private static applyEnvironmentOverrides(settings: SettingsDefaults): SettingsDefaults {
    const merged = { ...settings };

    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      const legacyValue = process.env[key];
      if (legacyValue !== undefined) {
        merged[key] = legacyValue;

        if (key.startsWith('CLAUDE_MEM_')) {
          const codexKey = `CODEX_MEM_${key.slice('CLAUDE_MEM_'.length)}`;
          this.warnLegacyEnvKeyOnce(key, codexKey);
        }
      }

      if (key.startsWith('CLAUDE_MEM_')) {
        const codexKey = (`CODEX_MEM_${key.slice('CLAUDE_MEM_'.length)}`) as keyof NodeJS.ProcessEnv;
        const codexValue = process.env[codexKey];
        if (codexValue !== undefined) {
          merged[key] = codexValue;
        }
      }
    }

    if (process.env.CLAUDE_CODE_PATH !== undefined) {
      this.warnLegacyEnvKeyOnce('CLAUDE_CODE_PATH', 'CODEX_CODE_PATH');
    }

    // Optional compatibility alias for CLI path naming.
    // Canonical CODEX_CODE_PATH takes precedence when present.
    if (process.env.CODEX_CODE_PATH !== undefined) {
      merged.CLAUDE_CODE_PATH = process.env.CODEX_CODE_PATH;
    }

    return merged;
  }

  private static warnLegacyEnvKeyOnce(legacyKey: string, canonicalKey: string): void {
    if (this.warnedDeprecationKeys.has(legacyKey)) {
      return;
    }

    this.warnedDeprecationKeys.add(legacyKey);
    console.warn(
      `[SETTINGS] Deprecated environment key ${legacyKey} detected. ` +
      `Use ${canonicalKey} instead. Legacy keys remain supported for now.`
    );
  }
}

/**
 * Default settings values for Codex Memory
 * Shared across UI components and hooks
 */
export const DEFAULT_SETTINGS = {
  CLAUDE_MEM_MODEL: 'claude-sonnet-4-5',
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
  CLAUDE_MEM_WORKER_PORT: '37777',
  CLAUDE_MEM_WORKER_HOST: 'localhost',

  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER: 'codex',
  CLAUDE_MEM_PROVIDER_FALLBACK_POLICY: 'auto',
  CLAUDE_MEM_CODEX_MODEL: 'gpt-5',
  CLAUDE_MEM_CODEX_REASONING_EFFORT: 'high',
  CLAUDE_MEM_GEMINI_API_KEY: '',
  CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
  CLAUDE_MEM_OPENROUTER_API_KEY: '',
  CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
  CLAUDE_MEM_OPENROUTER_SITE_URL: '',
  CLAUDE_MEM_OPENROUTER_APP_NAME: 'codex-mem',
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',
  CLAUDE_MEM_OLLAMA_MODE: 'native',
  CLAUDE_MEM_OLLAMA_BASE_URL: 'http://localhost:11434',
  CLAUDE_MEM_OLLAMA_MODEL: 'gemma3:4b',
  CLAUDE_MEM_OLLAMA_TIMEOUT_MS: '120000',
  CLAUDE_MEM_OLLAMA_TEMPERATURE: '0.2',
  CLAUDE_MEM_OLLAMA_NUM_CTX: '8192',
  CLAUDE_MEM_OLLAMA_OPTIONS_JSON: '{}',

  // Token Economics (all true for backwards compatibility)
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',

  // Observation Filtering (all types and concepts)
  CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: 'bugfix,feature,refactor,discovery,decision,change',
  CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: 'how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off',

  // Display Configuration
  CLAUDE_MEM_CONTEXT_FULL_COUNT: '5',
  CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',

  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
} as const;

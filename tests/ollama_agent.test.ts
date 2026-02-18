import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { OllamaAgent, isOllamaSelected } from '../src/services/worker/OllamaAgent.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import type { ActiveSession } from '../src/services/worker-types.js';

const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'observation prompt',
    summary: 'summary prompt',
  },
  observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
  observation_concepts: []
};

describe('OllamaAgent', () => {
  let modeSpy: ReturnType<typeof spyOn>;
  let settingsSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    modeSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {}
    } as any));

    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_MODE: 'native',
      CLAUDE_MEM_OLLAMA_BASE_URL: 'http://localhost:11434',
      CLAUDE_MEM_OLLAMA_MODEL: 'gemma3:4b',
      CLAUDE_MEM_OLLAMA_TIMEOUT_MS: '120000',
      CLAUDE_MEM_OLLAMA_TEMPERATURE: '0.2',
      CLAUDE_MEM_OLLAMA_NUM_CTX: '8192',
      CLAUDE_MEM_OLLAMA_OPTIONS_JSON: '{"top_p":0.9}'
    }));

    originalFetch = global.fetch;
  });

  afterEach(() => {
    modeSpy.mockRestore();
    settingsSpy.mockRestore();
    global.fetch = originalFetch;
    mock.restore();
  });

  it('reports ollama provider selection from settings', () => {
    expect(isOllamaSelected()).toBe(true);
  });

  it('uses ollama responses to persist observations with synthetic memory session id', async () => {
    const updateMemorySessionId = mock(() => {});
    const storeObservations = mock(() => ({
      observationIds: [42],
      summaryId: null,
      createdAtEpoch: Date.now()
    }));
    const syncObservation = mock(() => Promise.resolve());
    const syncSummary = mock(() => Promise.resolve());

    const mockDbManager = {
      getSessionStore: () => ({
        updateMemorySessionId,
        storeObservations
      }),
      getChromaSync: () => ({
        syncObservation,
        syncSummary
      })
    } as any;

    const mockSessionManager = {
      getMessageIterator: async function* () {
        yield* [];
      }
    } as any;

    const observationXml = `
      <observation>
        <type>discovery</type>
        <title>Ollama model detected</title>
        <subtitle>from native endpoint</subtitle>
        <narrative>Used Ollama API</narrative>
        <facts><fact>model=gemma3:4b</fact></facts>
        <concepts><concept>what-changed</concept></concepts>
        <files_read></files_read>
        <files_modified></files_modified>
      </observation>
    `;

    global.fetch = mock(async () => new Response(JSON.stringify({
      model: 'gemma3:4b',
      message: {
        role: 'assistant',
        content: observationXml
      },
      prompt_eval_count: 30,
      eval_count: 20
    }), {
      status: 200
    }));

    const session: ActiveSession = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: null,
      project: 'codex-mem',
      userPrompt: 'test prompt',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 1,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: null
    };

    const agent = new OllamaAgent(mockDbManager, mockSessionManager);
    await agent.startSession(session);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');

    const requestBody = JSON.parse(request.body);
    expect(requestBody.model).toBe('gemma3:4b');
    expect(requestBody.options.num_ctx).toBe(8192);
    expect(requestBody.options.temperature).toBe(0.2);
    expect(requestBody.options.top_p).toBe(0.9);

    expect(updateMemorySessionId).toHaveBeenCalledWith(1, 'ollama-worker-test-session');
    expect(storeObservations).toHaveBeenCalled();
    expect(syncObservation).toHaveBeenCalled();
  });
});

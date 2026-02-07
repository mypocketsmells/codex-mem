import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { CodexAgent, isCodexSelected } from '../src/services/worker/CodexAgent.js';
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

describe('CodexAgent', () => {
  let modeSpy: ReturnType<typeof spyOn>;
  let settingsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    modeSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {}
    } as any));

    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'codex',
      CLAUDE_MEM_CODEX_MODEL: 'gpt-5',
      CLAUDE_MEM_CODEX_REASONING_EFFORT: 'high'
    }));
  });

  afterEach(() => {
    modeSpy.mockRestore();
    settingsSpy.mockRestore();
    mock.restore();
  });

  it('reports codex provider selection from settings', () => {
    expect(isCodexSelected()).toBe(true);
  });

  it('uses codex responses to persist session summaries', async () => {
    const updateMemorySessionId = mock(() => {});
    const storeObservations = mock(() => ({
      observationIds: [],
      summaryId: 99,
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
        yield {
          type: 'summarize',
          last_assistant_message: 'assistant output from codex transcript'
        };
      }
    } as any;

    const codexRunner = mock(async () => {
      if (codexRunner.mock.calls.length === 1) {
        return { content: '', rawOutput: '' };
      }

      return {
        content: `<summary>
  <request>Backfill request</request>
  <investigated>Investigated codex pipeline</investigated>
  <learned>Learned provider was claude-only</learned>
  <completed>Added codex provider</completed>
  <next_steps>Run codex ingestion</next_steps>
  <notes>none</notes>
</summary>`,
        tokensUsed: 120,
        rawOutput: 'tokens used\n120'
      };
    });

    const session: ActiveSession = {
      sessionDbId: 1,
      contentSessionId: 'codex-session-1',
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

    const agent = new CodexAgent(mockDbManager, mockSessionManager, codexRunner);
    await agent.startSession(session);

    expect(codexRunner).toHaveBeenCalledTimes(2);
    expect(updateMemorySessionId).toHaveBeenCalledWith(1, 'codex-worker-codex-session-1');
    expect(storeObservations).toHaveBeenCalled();

    const lastCall = storeObservations.mock.calls[storeObservations.mock.calls.length - 1];
    const persistedMemorySessionId = lastCall[0];
    const persistedProject = lastCall[1];
    const persistedSummary = lastCall[3];

    expect(persistedMemorySessionId).toBe('codex-worker-codex-session-1');
    expect(persistedProject).toBe('codex-mem');
    expect(persistedSummary.request).toBe('Backfill request');
    expect(syncSummary).toHaveBeenCalled();
  });

  it('builds a fallback summary when codex summarize response is unstructured text', async () => {
    const updateMemorySessionId = mock(() => {});
    const storeObservations = mock(() => ({
      observationIds: [],
      summaryId: 101,
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
        yield {
          type: 'summarize',
          last_assistant_message: 'assistant output from codex transcript'
        };
      }
    } as any;

    const codexRunner = mock(async () => {
      if (codexRunner.mock.calls.length === 1) {
        return { content: '', rawOutput: '' };
      }

      return {
        content: 'This is a plain text summary from Codex without XML tags.',
        tokensUsed: 42,
        rawOutput: 'tokens used\n42'
      };
    });

    const session: ActiveSession = {
      sessionDbId: 2,
      contentSessionId: 'codex-session-2',
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

    const agent = new CodexAgent(mockDbManager, mockSessionManager, codexRunner);
    await agent.startSession(session);

    const lastCall = storeObservations.mock.calls[storeObservations.mock.calls.length - 1];
    const persistedSummary = lastCall[3];

    expect(persistedSummary).not.toBeNull();
    expect(persistedSummary.request).toBe('test prompt');
    expect(persistedSummary.learned).toContain('assistant output from codex transcript');
    expect(syncSummary).toHaveBeenCalled();
  });

  it('uses codex OSS bridge flags when ollama codex_bridge mode is selected', async () => {
    settingsSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'ollama',
      CLAUDE_MEM_OLLAMA_MODE: 'codex_bridge',
      CLAUDE_MEM_OLLAMA_MODEL: 'gemma3:4b',
      CLAUDE_MEM_OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      CLAUDE_MEM_CODEX_REASONING_EFFORT: 'high'
    }));

    const updateMemorySessionId = mock(() => {});
    const storeObservations = mock(() => ({
      observationIds: [],
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

    const codexRunner = mock(async () => ({
      content: '',
      tokensUsed: 10,
      rawOutput: 'tokens used\n10'
    }));

    const session: ActiveSession = {
      sessionDbId: 3,
      contentSessionId: 'ollama-bridge-session',
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

    const agent = new CodexAgent(mockDbManager, mockSessionManager, codexRunner);
    await agent.startSession(session);

    expect(codexRunner).toHaveBeenCalledTimes(1);
    const request = codexRunner.mock.calls[0][0];
    expect(request.model).toBe('gemma3:4b');
    expect(request.useOpenSourceProvider).toBe(true);
    expect(request.localProvider).toBe('ollama');
    expect(request.extraEnvironment).toEqual({ OLLAMA_HOST: 'http://127.0.0.1:11434' });
  });
});

import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

const listInstalledOllamaModels = mock(async () => ({
  models: ['gemma3:4b', 'gemma3:12b'],
  source: 'api' as const
}));

mock.module('../../../src/services/worker/OllamaModelDiscovery.js', () => ({
  listInstalledOllamaModels
}));

import { DataRoutes } from '../../../src/services/worker/http/routes/DataRoutes.js';

describe('DataRoutes /api/ollama/models', () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: SessionStore;
  let loadSettingsSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    listInstalledOllamaModels.mockClear();
    store = new SessionStore(':memory:');

    loadSettingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OLLAMA_BASE_URL: 'http://127.0.0.1:11434'
    }));

    const app = express();
    app.use(express.json());

    const routeHandler = new DataRoutes(
      {
        getObservations: mock(() => ({ items: [], hasMore: false, offset: 0, limit: 20 })),
        getSummaries: mock(() => ({ items: [], hasMore: false, offset: 0, limit: 20 })),
        getPrompts: mock(() => ({ items: [], hasMore: false, offset: 0, limit: 20 }))
      } as any,
      {
        getSessionStore: () => store
      } as any,
      {
        isAnySessionProcessing: () => false,
        getTotalActiveWork: () => 0,
        getTotalQueueDepth: () => 0,
        getActiveSessionCount: () => 0,
        getOldestActiveWorkAgeMs: () => null,
        getActiveProviders: () => []
      } as any,
      {
        getClientCount: () => 0
      } as any,
      {
        processPendingQueues: async () => ({ totalPendingSessions: 0, sessionsStarted: 0, sessionsSkipped: 0, startedSessionIds: [] }),
        broadcastProcessingStatus: () => {}
      } as any,
      Date.now()
    );

    routeHandler.setupRoutes(app);
    server = app.listen(0, '127.0.0.1');

    await new Promise<void>((resolve) => {
      server!.once('listening', resolve);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an inet server address');
    }
    port = address.port;
  });

  afterEach(async () => {
    loadSettingsSpy.mockRestore();
    store.close();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
      server = null;
    }
  });

  it('returns discovered ollama models for a valid baseUrl', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ollama/models?baseUrl=${encodeURIComponent('http://127.0.0.1:11434')}`);
    expect(response.status).toBe(200);

    const body = await response.json() as { models: string[]; source: string };
    expect(body.models).toEqual(['gemma3:4b', 'gemma3:12b']);
    expect(body.source).toBe('api');
    expect(listInstalledOllamaModels).toHaveBeenCalledWith('http://127.0.0.1:11434');
  });

  it('uses configured baseUrl when baseUrl query is omitted', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ollama/models`);
    expect(response.status).toBe(200);
    expect(listInstalledOllamaModels).toHaveBeenCalledWith('http://127.0.0.1:11434');
  });

  it('returns 400 for invalid baseUrl', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ollama/models?baseUrl=${encodeURIComponent('ftp://example.com')}`);
    expect(response.status).toBe(400);

    const body = await response.json() as { error: string };
    expect(body.error).toContain('baseUrl');
  });
});

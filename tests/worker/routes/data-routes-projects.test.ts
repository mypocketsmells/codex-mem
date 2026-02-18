import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { DataRoutes } from '../../../src/services/worker/http/routes/DataRoutes.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('DataRoutes /api/projects', () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: SessionStore;

  beforeEach(async () => {
    store = new SessionStore(':memory:');

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
    server = app.listen(0, 'localhost');

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
    store.close();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
      server = null;
    }
  });

  it('includes projects from sdk_sessions even without observations', async () => {
    store.createSDKSession('session-no-output', 'project-no-output-yet', 'prompt only');

    const response = await fetch(`http://localhost:${port}/api/projects`);
    expect(response.status).toBe(200);

    const body = await response.json() as { projects: string[] };
    expect(body.projects).toContain('project-no-output-yet');
  });
});

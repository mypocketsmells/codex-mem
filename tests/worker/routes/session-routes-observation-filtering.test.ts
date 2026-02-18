import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('SessionRoutes /api/sessions/observations filtering', () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: SessionStore;
  const queueObservation = mock(() => {});
  const broadcastObservationQueued = mock(() => {});

  beforeEach(async () => {
    store = new SessionStore(':memory:');
    queueObservation.mockClear();
    broadcastObservationQueued.mockClear();

    const app = express();
    app.use(express.json());

    const routeHandler = new SessionRoutes(
      {
        getSession: () => null,
        initializeSession: () => null,
        queueObservation,
        queueSummarize: () => {},
        deleteSession: async () => {}
      } as any,
      {
        getSessionStore: () => store
      } as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      {
        broadcastNewPrompt: () => {},
        broadcastSessionStarted: () => {},
        broadcastObservationQueued,
        broadcastSessionCompleted: () => {},
        broadcastSummarizeQueued: () => {}
      } as any,
      {
        broadcastProcessingStatus: () => {}
      } as any
    );

    routeHandler.setupRoutes(app);
    server = app.listen(0, 'localhost');

    await new Promise<void>((resolve) => {
      server!.once('listening', resolve);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected inet server address');
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

  async function initializeSession(contentSessionId: string): Promise<void> {
    const response = await fetch(`http://localhost:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        project: 'observer-sessions',
        prompt: 'capture prompt'
      })
    });

    expect(response.status).toBe(200);
  }

  it('skips CodexHistoryEntry observer bootstrap payloads', async () => {
    const contentSessionId = 'observer-bootstrap-session';
    await initializeSession(contentSessionId);

    const bootstrapPayload = {
      text: '# Message 1 (user)\nYou are a Codex-Mem, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS.\n<observed_from_primary_session>\n  <user_request>Reply exactly with: CODEx_OK</user_request>\n</observed_from_primary_session>\nMEMORY PROCESSING START\n======================='
    };

    const response = await fetch(`http://localhost:${port}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        tool_name: 'CodexHistoryEntry',
        tool_input: { source: 'history' },
        tool_response: bootstrapPayload,
        cwd: '/Users/example/project'
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; reason?: string };
    expect(body.status).toBe('skipped');
    expect(body.reason).toBe('observer_bootstrap');
    expect(queueObservation).not.toHaveBeenCalled();
    expect(broadcastObservationQueued).not.toHaveBeenCalled();
  });

  it('queues non-bootstrap CodexHistoryEntry payloads', async () => {
    const contentSessionId = 'observer-normal-session';
    await initializeSession(contentSessionId);

    const response = await fetch(`http://localhost:${port}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        tool_name: 'CodexHistoryEntry',
        tool_input: { source: 'history' },
        tool_response: { text: 'Real coding update: fixed queue ordering and added targeted tests.' },
        cwd: '/Users/example/project'
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; reason?: string };
    expect(body.status).toBe('queued');
    expect(body.reason).toBeUndefined();
    expect(queueObservation).toHaveBeenCalledTimes(1);
    expect(broadcastObservationQueued).toHaveBeenCalledTimes(1);
  });
});

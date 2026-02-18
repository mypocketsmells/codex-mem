import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('SessionRoutes /api/sessions/init SSE prompt broadcast', () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: SessionStore;
  const broadcastNewPrompt = mock(() => {});

  beforeEach(async () => {
    store = new SessionStore(':memory:');
    broadcastNewPrompt.mockClear();

    const app = express();
    app.use(express.json());

    const routeHandler = new SessionRoutes(
      {
        getSession: () => null,
        initializeSession: () => null,
        queueObservation: () => {},
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
        broadcastNewPrompt,
        broadcastSessionStarted: () => {},
        broadcastObservationQueued: () => {},
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

  it('broadcasts new_prompt after successful prompt save', async () => {
    const response = await fetch(`http://localhost:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: 'session-live-sse',
        project: 'project-live-sse',
        prompt: 'capture this prompt'
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { skipped: boolean };
    expect(body.skipped).toBe(false);
    expect(broadcastNewPrompt).toHaveBeenCalledTimes(1);

    const eventPayload = broadcastNewPrompt.mock.calls[0][0] as {
      content_session_id: string;
      project: string;
      prompt_text: string;
      prompt_number: number;
    };

    expect(eventPayload.content_session_id).toBe('session-live-sse');
    expect(eventPayload.project).toBe('project-live-sse');
    expect(eventPayload.prompt_text).toBe('capture this prompt');
    expect(eventPayload.prompt_number).toBe(1);
  });

  it('does not broadcast from /api/sessions/init for claude platform (handled by /sessions/:id/init)', async () => {
    const response = await fetch(`http://localhost:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: 'session-claude-path',
        project: 'project-claude-path',
        prompt: 'prompt from claude',
        platform: 'claude-code'
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { skipped: boolean };
    expect(body.skipped).toBe(false);
    expect(broadcastNewPrompt).not.toHaveBeenCalled();
  });

  it('does not broadcast when prompt is fully private and skipped', async () => {
    const response = await fetch(`http://localhost:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: 'session-private',
        project: 'project-private',
        prompt: '<private>secret text</private>'
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { skipped: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('private');
    expect(broadcastNewPrompt).not.toHaveBeenCalled();
  });
});

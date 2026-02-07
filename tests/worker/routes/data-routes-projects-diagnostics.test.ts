import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { DataRoutes } from '../../../src/services/worker/http/routes/DataRoutes.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('DataRoutes /api/projects/diagnostics', () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: SessionStore;
  let sessionsRootPath: string;
  let previousSessionsRootEnv: string | undefined;

  beforeEach(async () => {
    previousSessionsRootEnv = process.env.CODEX_MEM_CODEX_SESSIONS_DIR;
    sessionsRootPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-project-diagnostics-'));
    process.env.CODEX_MEM_CODEX_SESSIONS_DIR = sessionsRootPath;

    const transcriptDirPath = path.join(sessionsRootPath, '2026', '02', '06');
    mkdirSync(transcriptDirPath, { recursive: true });
    const transcriptPath = path.join(transcriptDirPath, 'rollout.jsonl');
    writeFileSync(
      transcriptPath,
      [
        '{"type":"session_meta","payload":{"id":"session-a","cwd":"/Users/test/project-uningested"}}',
        '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}'
      ].join('\n'),
      'utf-8'
    );
    const metadataOnlyTranscriptPath = path.join(transcriptDirPath, 'metadata-only.jsonl');
    writeFileSync(
      metadataOnlyTranscriptPath,
      [
        '{"type":"session_meta","payload":{"id":"session-b","cwd":"/Users/test/project-metadata-only"}}'
      ].join('\n'),
      'utf-8'
    );

    store = new SessionStore(':memory:');
    store.createSDKSession('session-ingested', 'project-ingested', 'prompt');

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
    if (previousSessionsRootEnv === undefined) {
      delete process.env.CODEX_MEM_CODEX_SESSIONS_DIR;
    } else {
      process.env.CODEX_MEM_CODEX_SESSIONS_DIR = previousSessionsRootEnv;
    }

    if (sessionsRootPath) {
      rmSync(sessionsRootPath, { recursive: true, force: true });
    }

    store.close();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
      server = null;
    }
  });

  it('returns missing discovered projects that are not ingested yet', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/diagnostics`);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ingestedProjects: string[];
      discoveredSessionProjects: string[];
      missingProjects: string[];
      missingCount: number;
      scannedFiles: number;
      lastScanEpochMs: number;
    };

    expect(body.ingestedProjects).toContain('project-ingested');
    expect(body.discoveredSessionProjects).toContain('project-uningested');
    expect(body.discoveredSessionProjects).not.toContain('project-metadata-only');
    expect(body.missingProjects).toContain('project-uningested');
    expect(body.missingProjects).not.toContain('project-metadata-only');
    expect(body.missingCount).toBe(1);
    expect(body.scannedFiles).toBe(2);
    expect(body.lastScanEpochMs).toBeGreaterThan(0);
  });
});

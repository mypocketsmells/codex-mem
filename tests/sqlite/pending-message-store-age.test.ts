import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import type { Database } from 'bun:sqlite';

describe('PendingMessageStore.getOldestActiveMessageAgeMs', () => {
  let database: Database;
  let pendingMessageStore: PendingMessageStore;
  let sessionDatabaseId: number;
  const contentSessionId = 'pending-age-session';

  beforeEach(() => {
    database = new ClaudeMemDatabase(':memory:').db;
    pendingMessageStore = new PendingMessageStore(database, 3);
    sessionDatabaseId = createSDKSession(database, contentSessionId, 'codex-mem', 'age test prompt');
  });

  afterEach(() => {
    database.close();
  });

  it('returns null when there is no active work', () => {
    expect(pendingMessageStore.getOldestActiveMessageAgeMs()).toBeNull();
  });

  it('returns age from oldest pending message', () => {
    pendingMessageStore.enqueue(sessionDatabaseId, contentSessionId, {
      type: 'observation',
      tool_name: 'CodexHistoryEntry',
      tool_input: { line: 1 },
      tool_response: { text: 'observation payload' }
    });

    expect(pendingMessageStore.getTotalActiveCount()).toBe(1);

    const queueRows = pendingMessageStore.getQueueMessages();
    const oldestCreatedAtEpoch = queueRows[0].created_at_epoch;
    const simulatedNowEpoch = oldestCreatedAtEpoch + 7000;

    const oldestAgeMs = pendingMessageStore.getOldestActiveMessageAgeMs(simulatedNowEpoch);
    expect(oldestAgeMs).toBe(7000);
  });
});

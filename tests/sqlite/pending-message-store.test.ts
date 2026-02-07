import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import type { Database } from 'bun:sqlite';

describe('PendingMessageStore', () => {
  let database: Database;
  let pendingMessageStore: PendingMessageStore;
  let sessionDatabaseId: number;
  const contentSessionId = 'content-priority-session';

  beforeEach(() => {
    database = new ClaudeMemDatabase(':memory:').db;
    pendingMessageStore = new PendingMessageStore(database, 3);
    sessionDatabaseId = createSDKSession(database, contentSessionId, 'priority-project', 'priority prompt');
  });

  afterEach(() => {
    database.close();
  });

  it('claims summarize messages before observation messages', () => {
    const firstObservationMessageId = pendingMessageStore.enqueue(sessionDatabaseId, contentSessionId, {
      type: 'observation',
      tool_name: 'CodexHistoryEntry',
      tool_input: { line: 1 },
      tool_response: { text: 'first observation' }
    });

    const firstSummaryMessageId = pendingMessageStore.enqueue(sessionDatabaseId, contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'first summary'
    });

    const secondObservationMessageId = pendingMessageStore.enqueue(sessionDatabaseId, contentSessionId, {
      type: 'observation',
      tool_name: 'CodexHistoryEntry',
      tool_input: { line: 2 },
      tool_response: { text: 'second observation' }
    });

    const secondSummaryMessageId = pendingMessageStore.enqueue(sessionDatabaseId, contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'second summary'
    });

    const firstClaimedMessage = pendingMessageStore.claimAndDelete(sessionDatabaseId);
    const secondClaimedMessage = pendingMessageStore.claimAndDelete(sessionDatabaseId);
    const thirdClaimedMessage = pendingMessageStore.claimAndDelete(sessionDatabaseId);
    const fourthClaimedMessage = pendingMessageStore.claimAndDelete(sessionDatabaseId);

    expect(firstClaimedMessage?.id).toBe(firstSummaryMessageId);
    expect(firstClaimedMessage?.message_type).toBe('summarize');

    expect(secondClaimedMessage?.id).toBe(secondSummaryMessageId);
    expect(secondClaimedMessage?.message_type).toBe('summarize');

    expect(thirdClaimedMessage?.id).toBe(firstObservationMessageId);
    expect(thirdClaimedMessage?.message_type).toBe('observation');

    expect(fourthClaimedMessage?.id).toBe(secondObservationMessageId);
    expect(fourthClaimedMessage?.message_type).toBe('observation');
  });
});

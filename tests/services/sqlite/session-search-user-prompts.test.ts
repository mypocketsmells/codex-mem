import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';

describe('SessionSearch.searchUserPrompts', () => {
  let tempDirectoryPath: string;
  let databasePath: string;
  let database: ClaudeMemDatabase;
  let sessionSearch: SessionSearch;
  const contentSessionId = 'prompt-search-session';

  beforeEach(() => {
    tempDirectoryPath = mkdtempSync(path.join(tmpdir(), 'codex-mem-session-search-'));
    databasePath = path.join(tempDirectoryPath, 'memory.sqlite');

    database = new ClaudeMemDatabase(databasePath);
    sessionSearch = new SessionSearch(databasePath);

    const sessionDatabaseId = createSDKSession(
      database.db,
      contentSessionId,
      'codex-mem',
      'initial prompt'
    );

    expect(sessionDatabaseId).toBeGreaterThan(0);

    const nowEpoch = Date.now();
    const insertUserPrompt = database.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id,
        prompt_number,
        prompt_text,
        created_at,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `);

    insertUserPrompt.run(
      contentSessionId,
      1,
      'PLAYWRIGHT_AUDIT_FULL run from viewer validation',
      new Date(nowEpoch).toISOString(),
      nowEpoch
    );

    insertUserPrompt.run(
      contentSessionId,
      2,
      'Gemini runtime FK validation',
      new Date(nowEpoch + 1).toISOString(),
      nowEpoch + 1
    );
  });

  afterEach(() => {
    sessionSearch.close();
    database.close();
    rmSync(tempDirectoryPath, { recursive: true, force: true });
  });

  it('returns prompts for text query with project filter', () => {
    const searchResults = sessionSearch.searchUserPrompts('PLAYWRIGHT', {
      project: 'codex-mem',
      limit: 10
    });

    expect(searchResults.length).toBe(1);
    expect(searchResults[0].prompt_text).toContain('PLAYWRIGHT_AUDIT_FULL');
  });
});

import { describe, it, expect, mock } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';

describe('SearchManager.searchUserPrompts', () => {
  it('falls back to SQLite prompt search when Chroma returns no prompt vectors', async () => {
    const promptResult = {
      id: 101,
      content_session_id: 'prompt-session',
      prompt_number: 1,
      prompt_text: 'PLAYWRIGHT_AUDIT_FULL prompt entry',
      created_at: '2026-02-06T10:36:15.506Z',
      created_at_epoch: 1770374175506
    };

    const mockSessionSearch = {
      searchUserPrompts: mock(() => [promptResult])
    };

    const mockSessionStore = {
      getUserPromptsByIds: mock(() => [])
    };

    const mockChromaSync = {
      queryChroma: mock(async () => ({
        ids: [],
        distances: [],
        metadatas: []
      }))
    };

    const mockFormatter = {
      formatTableHeader: mock(() => '| ID | Prompt |'),
      formatUserPromptIndex: mock((result: typeof promptResult, index: number) => `| #${result.id} | ${index} |`)
    };

    const searchManager = new SearchManager(
      mockSessionSearch as any,
      mockSessionStore as any,
      mockChromaSync as any,
      mockFormatter as any,
      {} as any
    );

    const searchResult = await searchManager.searchUserPrompts({
      query: 'PLAYWRIGHT',
      project: 'codex-mem',
      limit: 5
    });

    expect(mockChromaSync.queryChroma).toHaveBeenCalled();
    expect(mockSessionSearch.searchUserPrompts).toHaveBeenCalledWith(
      'PLAYWRIGHT',
      expect.objectContaining({ project: 'codex-mem', limit: 5 })
    );
    expect(searchResult.content[0].text).toContain('Found 1 user prompt(s) matching "PLAYWRIGHT"');
  });
});

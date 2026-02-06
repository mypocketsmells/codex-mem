# Codex-Mem Migration TODO

Last updated: 2026-02-06

## Goal

Rename the project from `claude-mem` to `codex-mem` and complete the platform migration so it works cleanly with Codex as a first-class target (not only Claude Code plugin workflows).

## Current Status

- [x] Initial repo identity rename applied in core metadata (`package.json`, plugin metadata, docs config, README links/name updates).
- [x] Added compatibility guards for data/config lookup (`~/.codex-mem` + fallback `~/.claude-mem`, `CODEX_MEM_*` + fallback `CLAUDE_MEM_*`).
- [x] Added Codex adapter scaffold and wired platform routing (`src/cli/adapters/codex.ts` + adapter registration).
- [x] Added Codex history ingestion MVP (`src/bin/ingest-codex-history.ts`) with checkpointing and worker API ingestion.
- [x] Completed major runtime/UI rename pass (Cursor integration, viewer branding, codex naming defaults, command/help text updates).
- [x] Completed docs/public + README canonical naming sweep to `codex-mem` paths/commands.
- [ ] Full release pass is still pending (manual validation matrix, compatibility notes, release pipeline).

## Rename Scope (Required)

### 1) Repository + Package Identity

- [x] Rename npm package name in `package.json` to `codex-mem`.
- [x] Update repository/homepage/issues URLs in `package.json` to `/codex-mem`.
- [x] Rename plugin package identity in `plugin/.claude-plugin/plugin.json`.
- [x] Rename marketplace plugin identity in `.claude-plugin/marketplace.json`.
- [x] Add command/script compatibility for local log access and ingestion entrypoints in `package.json`.
- [ ] Rename any remaining `"claude-mem"` binary, service, and process labels in source/runtime logs where user-visible.
- [ ] Decide whether to keep compatibility aliases (`claude-mem`) for one release cycle.

### 2) Branding and Docs

- [x] Rename main README branding and repository links to `codex-mem`.
- [x] Rename Mintlify docs site identity and GitHub links in `docs/public/docs.json`.
- [x] Rename remaining docs references in `docs/public/**/*.mdx`.
- [x] Rename remaining docs references to `claude-mem` across:
  - `docs/context/**/*.md`
  - `cursor-hooks/**/*.md`
  - `docs/i18n/**/*.md`
  - Note: retained `claude-mem-logo-*.webp` asset filenames intentionally until logo asset rename is finalized.
- [ ] Decide docs domain strategy:
  - Keep `docs.claude-mem.ai` short-term, or
  - Migrate to `docs.codex-mem.ai` and add redirects.
- [ ] Update badges, social links, and any external references in README/docs.

### 3) Built Artifacts + Generated Files

- [x] Regenerate built plugin scripts after source rename updates:
  - `npm run build`
  - verify `plugin/scripts/*.cjs` reflects renamed identifiers.
- [ ] Avoid editing `CHANGELOG.md` manually (auto-generated policy).

## Codex Platform Port Scope (Required)

### 4) Platform Adapter Layer

- [x] Add `codex` adapter in `src/cli/adapters/`:
  - parse Codex session identifiers
  - normalize working directory/project
  - normalize command/tool events if available.
- [x] Register adapter in `src/cli/adapters/index.ts`.
- [x] Update session-init handling to avoid Claude SDK startup for Codex-ingested sessions.
- [x] Add/update handler tests for Codex payload normalization.

### 5) Ingestion Pipeline for Codex Sessions

- [x] Define initial Codex event collection path:
  - Option A: hook/event integration if Codex exposes lifecycle hooks.
  - [x] Option B (MVP): ingestion bridge using Codex `history.jsonl`.
  - [x] Option C (MVP): explicit command-based ingestion (`npm run ingest:codex`).
- [x] Implement session init ingestion mapping for Codex via `/api/sessions/init`.
- [x] Implement observation ingestion mapping for Codex records via `/api/sessions/observations`.
- [x] Implement summary ingestion strategy for Codex session completion.
- [x] Add basic idempotency guard using line-number checkpoint state file.
- [x] Add robust retry/backoff strategy for partial ingestion failures.

### 6) MCP Search + Worker Compatibility

- [ ] Keep MCP server stdio interface stable for Codex MCP clients.
- [x] Rename primary server identity strings where needed:
  - e.g. server names/log labels in `src/servers/mcp-server.ts`.
- [ ] Verify `codex mcp add` flow against local built server.
- [x] Ensure worker health/version checks tolerate non-Claude install roots for compatibility.

### 7) Claude-Specific Coupling to Remove/Abstract

- [x] Abstract marketplace-root assumptions in `src/shared/worker-utils.ts`:
  - install root can now come from `CODEX_MEM_INSTALL_ROOT` / `CLAUDE_MEM_INSTALL_ROOT`.
- [x] Introduce generic install root/env overrides for version checks.
- [x] Audit `src/shared/paths.ts` + process managers for fixed Claude paths (core runtime paths updated to shared path helpers).
- [ ] Ensure worker start/stop/status work without Claude plugin directories.

## Data and Config Migration Scope (Required)

### 8) Data Directory Migration

- [x] Add one-time migration strategy for `~/.claude-mem` to `~/.codex-mem`:
  - copy or move strategy with rollback
  - lock file to avoid repeated migrations
  - preserve db/logs/settings/vector db.
- [x] Add fallback behavior to read legacy path if new path absent.
- [x] Add explicit user-facing migration logs and recovery guidance.

### 9) Settings and Environment Keys

- [x] Decide env var policy:
  - keep `CLAUDE_MEM_*` for compatibility, or
  - add `CODEX_MEM_*` canonical keys with fallback.
- [x] Add dual-key support:
  - update `SettingsDefaultsManager`
  - support both key families for 1-2 releases
  - write migration docs.
- [x] Update defaults referencing old project name (`CLAUDE_MEM_OPENROUTER_APP_NAME` -> `codex-mem` default).

### 10) Tag and File Naming Strategy

- [x] Keep `<claude-mem-context>` tag support for backward compatibility.
- [x] Support both `<codex-mem-context>` and legacy `<claude-mem-context>` during transition.
- [x] Rename/migrate context rule files with compatibility support:
  - `.cursor/rules/claude-mem-context.mdc` -> `.cursor/rules/codex-mem-context.mdc`
  - include migration of existing files.

## CLI and UX Scope (Required)

### 11) Command Surface

- [x] Define canonical command examples and naming:
  - `codex-mem ...` preferred
  - optional `claude-mem` alias (deprecated).
- [x] Add ingestion command entrypoints (`ingest:codex`, `ingest:codex:dry-run`).
- [x] Update command references in docs/scripts/help text.
- [x] Ensure worker help/usage text reflects new name.

### 12) UI/Viewer Surface

- [x] Rename viewer labels/headings from Claude-Mem to Codex-Mem.
- [ ] Verify logos/assets naming strategy:
  - keep existing file names initially or rename assets and references.
- [ ] Validate SSE/event UI still functions after rename.

## Testing Scope (Required)

### 13) Automated Tests

- [ ] Add/adjust unit tests for remaining compatibility items:
  - [x] Codex adapter normalization
  - [x] legacy/new config key fallback
  - [x] legacy/new data path migration
  - [x] legacy/new context tag stripping
  - [x] Codex ingestion filtering/checkpoint/retry behavior.
- [ ] Update integration tests for renamed command/identity strings.
- [ ] Add MCP smoke test for `tools/list` + `search` via stdio in CI.

### 14) Manual Validation Matrix

- [ ] Codex MCP only (search/timeline/get_observations).
- [ ] Codex with ingestion enabled (session/observation/summary capture).
- [ ] Existing Claude plugin install upgrade path.
- [ ] Cursor integration path + context file updates.
- [ ] Windows/macOS/Linux worker lifecycle and startup.

## Release and Backward Compatibility Scope (Required)

### 15) Compatibility Plan

- [ ] Support old repo/package references for transition period.
- [ ] Preserve existing user data without forced destructive migration.
- [ ] Ship clear deprecation warnings for old names/keys.
- [ ] Provide rollback instructions.

### 16) Release Tasks

- [ ] Update release scripts/automation references if they assume `claude-mem`.
- [ ] Regenerate changelog via normal workflow after migration PR(s).
- [ ] Publish migration notes:
  - old -> new command mappings
  - data path changes
  - config key changes.

## Immediate Next Steps

1. Verify `codex mcp add` flow against local built server and add a smoke test.
2. Run manual validation matrix (Codex/Cursor/upgrade path + cross-platform worker lifecycle).
3. Decide docs domain + redirects (`docs.codex-mem.ai` strategy).
4. Decide logo asset rename strategy (`claude-mem-logo-*.webp` -> `codex-mem-logo-*.webp`) and update references atomically.
5. Publish migration notes and compatibility/deprecation timeline.

import type { PlatformAdapter } from '../types.js';

// Maps Codex ingestion/event payloads to normalized hook input.
// Supports raw Codex history entries plus explicit tool-style events.
export const codexAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    // If ingestion supplies only free-form text, map it as prompt text.
    const inferredPrompt = r.prompt ?? r.text;
    const inferredToolName = r.tool_name ?? r.toolName ?? r.event_name;

    // Map command/output style records to Bash-like observation events.
    const isShellEvent = !!r.command && !inferredToolName;

    return {
      sessionId: r.session_id || r.sessionId || r.codex_session_id || `codex-${Date.now()}`,
      cwd: r.cwd || r.workspace_root || r.workspace || process.cwd(),
      prompt: inferredPrompt,
      toolName: isShellEvent ? 'Bash' : inferredToolName,
      toolInput: isShellEvent ? { command: r.command } : (r.tool_input ?? r.toolInput),
      toolResponse: isShellEvent ? { output: r.output } : (r.tool_response ?? r.toolResponse),
      transcriptPath: r.transcript_path || r.transcriptPath,
      filePath: r.file_path || r.filePath,
      edits: r.edits,
    };
  },

  formatOutput(result) {
    return {
      continue: result.continue ?? true,
      suppressOutput: result.suppressOutput ?? true,
      ...(result.hookSpecificOutput && { hookSpecificOutput: result.hookSpecificOutput })
    };
  }
};

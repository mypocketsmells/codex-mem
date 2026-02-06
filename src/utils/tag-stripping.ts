/**
 * Tag Stripping Utilities
 *
 * Implements the dual-tag system for meta-observation control:
 * 1. <codex-mem-context> / <claude-mem-context> - System-level tags for auto-injected observations
 *    (prevents recursive storage when context injection is active)
 * 2. <private> - User-level tag for manual privacy control
 *    (allows users to mark content they don't want persisted)
 *
 * EDGE PROCESSING PATTERN: Filter at hook layer before sending to worker/storage.
 * This keeps the worker service simple and follows one-way data stream.
 */

import { logger } from './logger.js';

const LEGACY_CONTEXT_TAG_OPEN = '<claude-mem-context>';
const CANONICAL_CONTEXT_TAG_OPEN = '<codex-mem-context>';

/**
 * Maximum number of tags allowed in a single content block
 * This protects against ReDoS (Regular Expression Denial of Service) attacks
 * where malicious input with many nested/unclosed tags could cause catastrophic backtracking
 */
const MAX_TAG_COUNT = 100;

/**
 * Count total number of opening tags in content
 * Used for ReDoS protection before regex processing
 */
function countTags(content: string): number {
  const privateCount = (content.match(/<private>/g) || []).length;
  const legacyContextCount = (content.match(new RegExp(LEGACY_CONTEXT_TAG_OPEN, 'g')) || []).length;
  const canonicalContextCount = (content.match(new RegExp(CANONICAL_CONTEXT_TAG_OPEN, 'g')) || []).length;
  const contextCount = legacyContextCount + canonicalContextCount;
  return privateCount + contextCount;
}

/**
 * Internal function to strip memory tags from content
 * Shared logic extracted from both JSON and prompt stripping functions
 */
function stripTagsInternal(content: string): string {
  // ReDoS protection: limit tag count before regex processing
  const tagCount = countTags(content);
  if (tagCount > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
      tagCount,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: content.length
    });
    // Still process but log the anomaly
  }

  return content
    .replace(/<codex-mem-context>[\s\S]*?<\/codex-mem-context>/g, '')
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .trim();
}

/**
 * Strip memory tags from JSON-serialized content (tool inputs/responses)
 *
 * @param content - Stringified JSON content from tool_input or tool_response
 * @returns Cleaned content with tags removed, or '{}' if invalid
 */
export function stripMemoryTagsFromJson(content: string): string {
  return stripTagsInternal(content);
}

/**
 * Strip memory tags from user prompt content
 *
 * @param content - Raw user prompt text
 * @returns Cleaned content with tags removed
 */
export function stripMemoryTagsFromPrompt(content: string): string {
  return stripTagsInternal(content);
}

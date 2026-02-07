import { describe, expect, it } from 'bun:test';
import {
  isProviderFallbackPolicy,
  normalizeProviderFallbackPolicy,
  PROVIDER_FALLBACK_POLICIES
} from '../../src/shared/provider-fallback-policy.js';

describe('provider-fallback-policy', () => {
  it('exports supported fallback policy values', () => {
    expect(PROVIDER_FALLBACK_POLICIES).toEqual(['auto', 'off', 'codex', 'sdk']);
  });

  it('validates supported fallback policy values', () => {
    expect(isProviderFallbackPolicy('auto')).toBe(true);
    expect(isProviderFallbackPolicy('off')).toBe(true);
    expect(isProviderFallbackPolicy('codex')).toBe(true);
    expect(isProviderFallbackPolicy('sdk')).toBe(true);
    expect(isProviderFallbackPolicy('invalid')).toBe(false);
  });

  it('normalizes fallback policy values and defaults to auto', () => {
    expect(normalizeProviderFallbackPolicy('auto')).toBe('auto');
    expect(normalizeProviderFallbackPolicy(' off ')).toBe('off');
    expect(normalizeProviderFallbackPolicy('CODEX')).toBe('codex');
    expect(normalizeProviderFallbackPolicy('sdk')).toBe('sdk');
    expect(normalizeProviderFallbackPolicy('')).toBe('auto');
    expect(normalizeProviderFallbackPolicy('unexpected')).toBe('auto');
    expect(normalizeProviderFallbackPolicy(undefined)).toBe('auto');
    expect(normalizeProviderFallbackPolicy(null)).toBe('auto');
  });
});

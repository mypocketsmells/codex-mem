/**
 * Provider fallback policy controls how non-Codex providers recover from
 * transient API failures (rate limits, 5xx, network errors).
 */

export const PROVIDER_FALLBACK_POLICIES = ['auto', 'off', 'codex', 'sdk'] as const;

export type ProviderFallbackPolicy = (typeof PROVIDER_FALLBACK_POLICIES)[number];

export function isProviderFallbackPolicy(value: string): value is ProviderFallbackPolicy {
  return PROVIDER_FALLBACK_POLICIES.includes(value as ProviderFallbackPolicy);
}

export function normalizeProviderFallbackPolicy(value: unknown): ProviderFallbackPolicy {
  if (typeof value !== 'string') {
    return 'auto';
  }

  const normalizedValue = value.trim().toLowerCase();
  return isProviderFallbackPolicy(normalizedValue) ? normalizedValue : 'auto';
}

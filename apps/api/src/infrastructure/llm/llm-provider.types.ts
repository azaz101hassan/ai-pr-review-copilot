/**
 * Single source of truth for the set of LLM provider identifiers.
 * Used by ConfigService, LlmProviderModule, and the env-parse helpers
 * to keep the switch values consistent across the codebase.
 */
export const LLM_PROVIDERS = ['anthropic', 'openrouter'] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const DEFAULT_LLM_PROVIDER: LlmProvider = 'anthropic';

export function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    typeof value === 'string' && (LLM_PROVIDERS as readonly string[]).includes(value)
  );
}

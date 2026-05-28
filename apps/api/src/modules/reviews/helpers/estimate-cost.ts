import { UsageStats } from '../types/llm-reviewer';

// Per-1M-token published rates for the three Claude tiers this project
// uses. Hard-coded here so the CLI surfaces a running spend estimate
// without a network round-trip. Source: Anthropic pricing page as of
// 2026-05. If Anthropic changes pricing, update these constants and
// note the date.
//
// `cache_read_input_tokens` is charged at 0.1× the standard input rate
// across all tiers; `cache_creation_input_tokens` (write) is charged at
// 1.25× the standard input rate (5-min ephemeral). Output rate is
// unaffected by caching.
interface ModelRates {
  // USD per 1M tokens
  inputPer1M: number;
  outputPer1M: number;
  // Multipliers relative to inputPer1M.
  cacheReadMultiplier: number;
  cacheWriteMultiplier: number;
}

const MODEL_RATES: Record<string, ModelRates> = {
  'claude-haiku-4-5-20251001': {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
  },
  'claude-sonnet-4-6': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
  },
  'claude-opus-4-7': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
  },
};

// State for the once-per-session unknown-model warning. Module-scope
// so successive calls don't spam stderr.
const warnedUnknownModels = new Set<string>();

export interface EstimateCostResult {
  totalUsd: number;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  rateModel: string;
}

// Returns total estimated cost in USD plus a per-bucket breakdown for
// the line we log at the end of every dry-run. Returning the buckets
// (rather than a number alone) means downstream callers — Day-8
// dashboards in particular — can attribute spend without re-computing.
export function estimateCost(usage: UsageStats, model: string): EstimateCostResult {
  const rates = MODEL_RATES[model] ?? fallbackRates(model);

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  // The cache columns are NOT subtracted from `input_tokens` — they
  // double-count, but each is billed at its own rate. Anthropic's
  // `usage` is the source of truth; their billing reflects:
  //   total_charge_input ≈ input_tokens * 1× + cache_read * 0.1× + cache_write * 1.25×
  // where input_tokens already excludes cached tokens (Anthropic does
  // not bill input_tokens for the cached prefix; the prefix shows up
  // under cache_read instead). The math here mirrors that contract.
  const inputUsd = perMillion(inputTokens, rates.inputPer1M);
  const outputUsd = perMillion(outputTokens, rates.outputPer1M);
  const cacheReadUsd = perMillion(cacheRead, rates.inputPer1M * rates.cacheReadMultiplier);
  const cacheWriteUsd = perMillion(cacheWrite, rates.inputPer1M * rates.cacheWriteMultiplier);

  return {
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    rateModel: model in MODEL_RATES ? model : 'claude-sonnet-4-6',
  };
}

function fallbackRates(model: string): ModelRates {
  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    // eslint-disable-next-line no-console
    console.warn(
      `[estimateCost] unknown model "${model}" — falling back to Sonnet rates for spend estimation. ` +
        `Add the rate to MODEL_RATES in apps/api/src/modules/reviews/helpers/estimate-cost.ts.`,
    );
  }
  return MODEL_RATES['claude-sonnet-4-6'];
}

function perMillion(tokens: number, ratePer1M: number): number {
  return (tokens / 1_000_000) * ratePer1M;
}

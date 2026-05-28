// LLM reviewer contract. The `ReviewsService` injects this token; the
// Anthropic adapter under `infrastructure/anthropic/` binds to it. A
// future swap to a different LLM provider is a one-line wiring change
// in the adapter module — no service code touches the SDK.
export const LLM_REVIEWER = Symbol('LlmReviewer');

// Per-finding shape returned by the adapter. Note: `severity` is
// DELIBERATELY absent. Severity is sourced from the matched rule's
// metadata in `ReviewsService` at persistence time (see Key Technical
// Decisions → Severity sourcing in docs/plans/04-day3-claude-integration.md).
// Letting Claude emit severity would let it contradict the rule's
// declared severity silently; rule metadata wins.
export interface Finding {
  rule_id: string;
  title: string;
  message: string;
  location_hint?: string | null;
  citation?: string | null;
}

// Token usage echoed from Anthropic's response. Cache fields are nullable
// because they're only populated when the request had a cacheable prefix
// AND the prefix cleared Sonnet's 1024-token caching threshold. Day-3
// integration spec asserts > 0 on first real call to catch the
// "silent zero" failure mode.
export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

// Input shape for the adapter. Lighter than `SearchHit` — the adapter
// doesn't need `score` (shouldn't influence Claude's judgement) or
// `metadata` (severity is consumed in the service, not the adapter).
// The service maps from `SearchHit` to this shape before invoking.
export interface AnalyzeDiffInput {
  diff: string;
  rules: Array<{
    rule_id: string;
    source: string;
    document: string;
    title?: string;
  }>;
}

export interface AnalyzeDiffResult {
  findings: Finding[];
  usage: UsageStats;
  model: string;
  promptVersion: string;
}

// Day-3 contract: single-turn forced tool-call. Day 4's agentic loop
// will need either widening this interface (variadic options arg) or
// adding a sibling method (e.g. `analyzeWithTools`). The Day-4 plan
// picks which — do not preemptively change Day 3.
export interface ILlmReviewer {
  analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult>;
}

// Snapshot-test-guarded version of the prompt + tool schema written to
// every `reviews.prompt_version` column. The U4 snapshot spec hashes
// `SYSTEM_PROMPT + JSON.stringify(REPORT_FINDINGS_TOOL)` and fails CI on
// drift — bumping the snapshot requires bumping this constant in the
// same commit so Day-6 reproducibility holds. Renamed from
// `PROMPT_VERSION` to make explicit that the tool schema is in scope.
export const PROMPT_AND_TOOL_VERSION = 'v2' as const;

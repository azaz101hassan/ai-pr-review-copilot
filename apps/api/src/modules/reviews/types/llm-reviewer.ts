import type { IRepoContextProvider } from './repo-context-provider';
import type { ToolCallRecord } from './review.types';

// LLM reviewer contract. The `ReviewsService` injects this token; the
// Anthropic adapter under `infrastructure/anthropic/` binds to it. A
// future swap to a different LLM provider is a one-line wiring change
// in the adapter module — no service code touches the SDK.
export const LLM_REVIEWER = Symbol('LlmReviewer');

// Per-finding shape returned by the adapter. Note: `severity` is
// DELIBERATELY absent. Severity is sourced from the matched rule's
// metadata in `ReviewsService` at persistence time. Letting Claude
// emit severity would let it silently contradict the rule's declared
// severity; rule metadata wins.
export interface Finding {
  rule_id: string;
  title: string;
  message: string;
  location_hint?: string | null;
  citation?: string | null;
}

// Token usage echoed from Anthropic's response. Cache fields are nullable
// because they're only populated when the request had a cacheable prefix
// AND the prefix cleared Sonnet's 1024-token caching threshold. The
// integration spec asserts > 0 on the first real call to catch the
// "silent zero" failure mode. The adapter accumulates these values
// across turns into a single total.
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
//
// `repoContext` is the per-review seam through which the agent loop
// fetches additional context (file content, function definitions,
// prior reviews). When omitted, every non-terminal tool call returns
// an `is_error` tool_result, so the loop still runs but degenerates
// to a single `emit_finding` turn.
export interface AnalyzeDiffInput {
  diff: string;
  rules: Array<{
    rule_id: string;
    source: string;
    document: string;
    title?: string;
  }>;
  repoContext?: IRepoContextProvider;
}

// `turnCount` reports how many `messages.create` calls the loop made
// before it reached `emit_finding`; `toolCalls` records one entry per
// turn (including the terminal turn). Eval slices on these to measure
// loop behavior over the corpus.
//
// Two observability counters are reported only on the terminal
// `emit_finding` path (failure paths throw, so the contract never sees
// those branches):
//   - hallucinatedFindingCount: how many findings the model emitted
//     that the post-emit filter dropped (unknown rule_id or wrong
//     `source:rule_id` composite). Sum of both filter paths into one
//     number — the dashboard chip is visibility-only, not alert-
//     scoped, so a finer split waits until baseline data motivates it.
//   - cacheHitCount: how many tool_use invocations the per-review
//     dedup cache short-circuited during the loop (the
//     `toolResultCache` short-circuit branch). Always 0 for reviews
//     that terminate on turn 1 with no non-terminal tool calls.
export interface AnalyzeDiffResult {
  findings: Finding[];
  usage: UsageStats;
  model: string;
  promptVersion: string;
  turnCount: number;
  toolCalls: ToolCallRecord[];
  hallucinatedFindingCount: number;
  cacheHitCount: number;
}

// Multi-turn agent loop contract. The adapter calls `messages.create`
// repeatedly (`tool_choice: 'any'`) until Claude invokes the terminal
// `emit_finding` tool or the configured turn cap is reached. A clean
// diff that requires no context fetches degenerates to a single
// `emit_finding` turn.
export interface ILlmReviewer {
  analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult>;
}

// Snapshot-test-guarded version of the prompt + tool schemas written
// to every `reviews.prompt_version` column. The snapshot spec hashes
// `SYSTEM_PROMPT + JSON.stringify(tools)` and looks up the expected
// hash in `PROMPT_AND_TOOL_VERSION_HASH_MAP` — bumping the constant
// requires landing the new hash entry in the SAME COMMIT so eval
// reproducibility holds. Includes "tool" in the name to make explicit
// that the tool schema is in scope, not just the prompt text.
//
// History:
//   'v2' — single-turn forced report_findings tool
//   'v3' — multi-turn agentic loop; 4 tools; same Finding shape
//   'v4' — clarifies multi-rule emission on the same line so orthogonal
//          violations (e.g. wrong-mechanism + sensitive-content) both
//          surface instead of collapsing into one finding
export const PROMPT_AND_TOOL_VERSION = 'v4' as const;

// Hash enforcement map. The snapshot spec asserts
// `sha256(SYSTEM_PROMPT + JSON.stringify(tools)) === HASH_MAP[VERSION]`.
// Changing the prompt or any tool schema without bumping the version
// fails the assertion (hash drift); bumping the version without
// adding the new hash entry also fails (no map entry). Both edits
// must land in the same commit. The v3 entry is populated below
// after the prompt + tools are defined; we re-export the constant
// here for callers that don't need the hash itself.
export const PROMPT_AND_TOOL_VERSION_HASH_MAP: Record<
  typeof PROMPT_AND_TOOL_VERSION,
  string
> = {
  // sha256(SYSTEM_PROMPT + JSON.stringify([FETCH_FILE_TOOL, FETCH_FUNCTION_TOOL,
  // FETCH_PRIOR_REVIEW_TOOL, EMIT_FINDING_TOOL])). The snapshot spec re-computes
  // this on every test run; editing the prompt or any tool schema without
  // updating both this hash AND PROMPT_AND_TOOL_VERSION in the same commit
  // fails the spec.
  v4: '8249f8d296164663b9987eca060296d855071107677f6ce4de89c3e9e1373130',
};

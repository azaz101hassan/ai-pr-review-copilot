import type { IRepoContextProvider } from './repo-context-provider';
import type { ToolCallRecord } from './review.types';

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
// "silent zero" failure mode. Day-4: this shape is unchanged, but the
// adapter accumulates these values across turns into a single total.
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
// Day-4: `repoContext` is the per-review seam through which the
// agent loop fetches additional context (file content, function
// definitions, prior reviews). When omitted, every non-terminal
// tool call returns an `is_error` tool_result, so the loop still
// runs but degenerates to a single `emit_finding` turn — preserving
// the Day-3 behavior on callers that haven't been updated.
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

// Day-4 return shape. `turnCount` reports how many `messages.create`
// calls the loop made before it reached `emit_finding`; `toolCalls`
// records one entry per turn (including the terminal turn). Day-6
// eval slices on these to measure loop behavior over the corpus.
export interface AnalyzeDiffResult {
  findings: Finding[];
  usage: UsageStats;
  model: string;
  promptVersion: string;
  turnCount: number;
  toolCalls: ToolCallRecord[];
}

// Day-4 contract: multi-turn agent loop. The adapter calls
// `messages.create` repeatedly (`tool_choice: 'any'`) until Claude
// invokes the terminal `emit_finding` tool or the 6-turn cap is
// reached. Day-3's single-turn behavior survives as the degenerate
// case where `emit_finding` arrives on turn 1.
export interface ILlmReviewer {
  analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult>;
}

// Snapshot-test-guarded version of the prompt + tool schemas written
// to every `reviews.prompt_version` column. The U4 snapshot spec
// hashes `SYSTEM_PROMPT + JSON.stringify(tools)` and looks up the
// expected hash in `PROMPT_AND_TOOL_VERSION_HASH_MAP` — bumping the
// constant requires landing the new hash entry in the SAME COMMIT so
// Day-6 reproducibility holds. Renamed from `PROMPT_VERSION` to make
// explicit that the tool schema is in scope.
//
// Day-3: 'v2' (single-turn forced report_findings tool)
// Day-4: 'v3' (multi-turn agentic loop; 4 tools; same Finding shape)
export const PROMPT_AND_TOOL_VERSION = 'v3' as const;

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
  v3: '9bcd7ad43f5686aaf9b6e6f3b57be2eecaffa277bbfaea93aa14d44137790133',
};

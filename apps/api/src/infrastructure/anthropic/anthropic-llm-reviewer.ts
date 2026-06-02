import { Injectable, Logger } from '@nestjs/common';
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { ConfigService } from '@/config';
import {
  AnalyzeDiffInput,
  AnalyzeDiffResult,
  Finding,
  ILlmReviewer,
  PROMPT_AND_TOOL_VERSION,
  UsageStats,
} from '@/modules/reviews/types/llm-reviewer';
import {
  IRepoContextProvider,
  PriorReviewEntry,
  RepoContextErrorReason,
} from '@/modules/reviews/types/repo-context-provider';
import { ToolCallRecord } from '@/modules/reviews/types/review.types';
import { AnthropicRequestError } from './anthropic-request.error';

// Loose alias for the subset of the Anthropic client surface this
// adapter uses. Mirrors the `ChromaClientLike` pattern in
// `infrastructure/chroma/` — keeping it narrow lets test stubs
// implement only `messages.create` without satisfying every signature
// on the real `Anthropic` class.
type AnthropicClientLike = {
  messages: {
    create: (args: unknown, options?: unknown) => Promise<{
      id?: string;
      content: unknown[];
      model: string;
      stop_reason: string | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
    }>;
  };
};

// Per-turn ceiling on completion tokens. Generous enough for a
// `emit_finding` payload with the full 10 findings (~2k tokens) and
// modest enough that a runaway turn can't bloat. Day-3 used 4096 for
// the single-turn forced call; Day-4 dials this to 2048 per the plan
// since most turns either invoke a context fetcher (small input) or
// emit_finding (capped at 10 findings).
const MAX_TOKENS_PER_TURN = 2048;

// Default hard cap on agent-loop turns. Reaching the cap without
// `emit_finding` throws `AnthropicRequestError({ errorCode:
// 'turn_cap_exceeded' })` which `ReviewsService` maps to
// `reviews.status='failed'`. 6 is the brainstorm-chosen ceiling —
// enough headroom for a real reviewer-like pattern (file → function →
// prior-review → emit) plus recovery, not enough for runaway
// oscillation. Operators can override via `ANTHROPIC_AGENT_TURN_CAP`
// (1–20) when a large dogfood diff genuinely needs more exploration
// turns. The canonical `SYSTEM_PROMPT` (and the hash the snapshot spec
// guards) is always built with this default; non-default caps yield a
// runtime-only prompt with the same shape but a different stated cap.
export const DEFAULT_TURN_CAP = 6;

// SDK auto-retry behavior. Set explicitly so the troubleshooting doc
// and runtime agree: a 429 or 529 is retried twice with exponential
// backoff before throwing. Set to 0 to disable.
const SDK_MAX_RETRIES = 2;

// Per-request timeout (ms) for messages.create. The SDK default is 10
// minutes — combined with 2 retries and 6 turns that's a 3-hour
// worst case for a single review. 60s per turn × 6 turns × (1 + 2
// retries) caps the worst case at ~18 minutes, which is the
// rate-limit cool-off window anyway. Day-4 reviews complete in
// 5-30s typically; 60s is generous.
const PER_REQUEST_TIMEOUT_MS = 60_000;

// Tool name constants — referenced both by the schemas below and by
// the loop's switch / extraction logic. Keeping them as exported
// string constants lets test stubs reference the same identifiers
// without stringly-typed drift.
export const FETCH_FILE_TOOL_NAME = 'fetch_related_file';
export const FETCH_FUNCTION_TOOL_NAME = 'fetch_function_definition';
export const FETCH_PRIOR_REVIEW_TOOL_NAME = 'fetch_prior_review';
export const EMIT_FINDING_TOOL_NAME = 'emit_finding';

// SYSTEM PROMPT — Day 4 agentic protocol.
//
// Editing this requires bumping `PROMPT_AND_TOOL_VERSION` AND adding
// the new sha256 to `PROMPT_AND_TOOL_VERSION_HASH_MAP` in the same
// commit (the snapshot spec enforces this). The exported
// `SYSTEM_PROMPT` is the canonical form built at `DEFAULT_TURN_CAP`;
// non-default caps build a runtime-only variant via
// `buildSystemPrompt(cap)` and the hash is unaffected.
export function buildSystemPrompt(turnCap: number = DEFAULT_TURN_CAP): string {
  return [
  'You are an automated code reviewer for a software team. You operate as an agent: you can call tools to fetch additional context from the repository before deciding what to flag.',
  '',
  'You will be given a unified diff plus a list of retrieved rules from the team knowledge base. Your job is to identify which of the retrieved rules — and ONLY those rules — the diff violates.',
  '',
  'You have four tools:',
  `  - ${FETCH_FILE_TOOL_NAME}: read the full content of a file in the repo (give a repo-relative path).`,
  `  - ${FETCH_FUNCTION_TOOL_NAME}: locate a function or method by name (optionally narrowed to one file).`,
  `  - ${FETCH_PRIOR_REVIEW_TOOL_NAME}: look up prior findings on this PR / file / rule. A finding with a non-null \`dismissed_at\` was rejected by a human reviewer — do NOT re-emit it.`,
  `  - ${EMIT_FINDING_TOOL_NAME}: the TERMINAL tool. Call this exactly once when you are ready to report your findings. The loop ends as soon as you invoke it.`,
  '',
  'Protocol:',
  `  - Call any combination of the three context tools to gather information. When you are ready, call \`${EMIT_FINDING_TOOL_NAME}\` with your final findings.`,
  '  - If a context tool returns `is_error: true`, that capability is unavailable for this review — do not retry the same input. Either try a different input (e.g., a different path) or proceed to emit your findings with the context you have.',
  `  - You have a maximum of ${turnCap} turns. Reaching the cap without calling \`${EMIT_FINDING_TOOL_NAME}\` is treated as a failed review.`,
  '',
  'Strict constraints (carried forward from the single-turn protocol):',
  '- You MUST only cite rules whose `rule_id` appears in the retrieved rule set. Never invent rule_ids and never quote rules from memory.',
  `- If the diff does not violate any retrieved rule, call \`${EMIT_FINDING_TOOL_NAME}\` with \`findings: []\`. An empty findings array is a valid and expected outcome on clean diffs and on diffs whose only candidate violation has been previously dismissed (per \`${FETCH_PRIOR_REVIEW_TOOL_NAME}\`).`,
  '- One finding per distinct violation. Do not duplicate findings for the same rule on the same line.',
  '- Keep `message` actionable: state what was violated and how to fix it in 1–3 sentences. When you used a context tool to detect the violation, mention the supporting evidence (e.g., the unchanged caller file path).',
  '- Populate `location_hint` with a file path + line range when you can identify one from the diff hunk headers (e.g., "src/totals.js:3-5"). Leave it absent if unsure rather than guessing.',
  '- Populate `citation` with the shortest snippet from the diff or fetched context that demonstrates the violation. Omit it when no concise snippet captures the issue.',
  '',
  'Precision discipline (false positives erode reviewer trust faster than missed violations):',
  '- When uncertain whether a fragment violates a retrieved rule, err toward NOT flagging it. A clean review on an actually-violating diff is recoverable; a noisy review on a clean diff trains the team to ignore the reviewer.',
  '- Do not flag the same logical issue under multiple rule_ids. Pick the rule that most specifically describes the violation.',
  '- Do not flag style preferences that are not explicitly stated in the retrieved rules.',
  '- Do not infer "what the team probably wants" beyond what the retrieved rule text says.',
  `- Before re-flagging anything that looks like it could be a recurrence of a known issue, call \`${FETCH_PRIOR_REVIEW_TOOL_NAME}\`. If the prior finding has a non-null \`dismissed_at\`, the team has already decided — do not re-emit.`,
  '',
  'Examples of correct outputs (rule_ids are illustrative — only flag rules actually present in <retrieved_rules>):',
  '',
  `Example 1 — diff replaces \`let\`/\`const\` with \`var\` and \`no-var\` is in the retrieved rules. Call \`${EMIT_FINDING_TOOL_NAME}\` directly (no context fetch needed; the violation is fully visible in the diff).`,
  '    rule_id: no-var',
  '    title: Use let or const, never var',
  '    message: Replace `var` with `let` or `const`. `var` is function-scoped and hoisted, which leads to subtle re-declaration and closure bugs.',
  '    location_hint: src/totals.js:3',
  '    citation: var sum = 0;',
  '',
  `Example 2 — diff updates ONE call site of a function to pass a new argument shape, but other call sites might still use the old shape. Call \`${FETCH_FUNCTION_TOOL_NAME}\` to find the function definition; call \`${FETCH_FILE_TOOL_NAME}\` on the surrounding files to find unchanged call sites; then \`${EMIT_FINDING_TOOL_NAME}\` with a finding that names the inconsistent caller files in the message.`,
  '',
  `Example 3 — diff re-applies a style violation. Before emitting, call \`${FETCH_PRIOR_REVIEW_TOOL_NAME}\`. If a prior finding at the same location has \`dismissed_at\` set, emit zero findings — the team already decided this code is intentional.`,
  '',
  `Example 4 — diff is a doc-only change (README.md, CHANGELOG.md, a comment-only edit). No code rules apply. Call \`${EMIT_FINDING_TOOL_NAME}\` with \`findings: []\` directly.`,
  '',
  `Example 5 — diff includes a fragment that looks suspicious but no retrieved rule explicitly covers it (e.g., a magic number when \`no-magic-numbers\` is NOT in the retrieved set). Do not emit a finding for that fragment. Only the retrieved rule set is authoritative.`,
  ].join('\n');
}

// Canonical system prompt, frozen at `DEFAULT_TURN_CAP`. This is what
// `computePromptToolHash()` hashes and what the snapshot drift guard
// pins. Runtime callers that need a different cap rebuild via
// `buildSystemPrompt(cap)`.
export const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_TURN_CAP);

// === Tool schemas ===

export const FETCH_FILE_TOOL = {
  name: FETCH_FILE_TOOL_NAME,
  description:
    'Read the full content of a file in the repository. Use this when the violation requires context outside the diff hunk (e.g., to inspect callers of a function whose signature changed).',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string' as const,
        minLength: 1,
        maxLength: 500,
        description: 'Repo-relative path (e.g. "src/checkout.js"). No leading slash, no `..` traversal.',
      },
    },
    required: ['path'] as const,
    additionalProperties: false,
  },
};

export const FETCH_FUNCTION_TOOL = {
  name: FETCH_FUNCTION_TOOL_NAME,
  description:
    'Locate a function or method by name. Use this to inspect the canonical signature or implementation of a function referenced in the diff. Optionally narrow the search to a specific file.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string' as const,
        minLength: 1,
        maxLength: 200,
        description: 'Function or method name (e.g. "chargeCard"). Matched case-sensitively.',
      },
      file: {
        type: 'string' as const,
        maxLength: 500,
        description: 'Optional repo-relative path to restrict the search to one file.',
      },
    },
    required: ['name'] as const,
    additionalProperties: false,
  },
};

export const FETCH_PRIOR_REVIEW_TOOL = {
  name: FETCH_PRIOR_REVIEW_TOOL_NAME,
  description:
    'Look up prior findings on this PR / file / rule. A finding with a non-null `dismissed_at` was previously rejected by a human reviewer — do not re-emit it. Returns an empty array when no prior reviews exist.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pr_node_id: {
        type: 'string' as const,
        maxLength: 200,
        description: 'Optional GitHub PR node id to scope the lookup.',
      },
      file_path: {
        type: 'string' as const,
        maxLength: 500,
        description: 'Optional file path to filter prior findings.',
      },
      rule_id: {
        type: 'string' as const,
        maxLength: 200,
        description: 'Optional rule_id to filter prior findings.',
      },
    },
    additionalProperties: false,
  },
};

// TERMINAL tool. The loop exits as soon as Claude invokes this. `severity`
// is DELIBERATELY absent — sourced from rule metadata in `ReviewsService`
// at persistence (D1 invariant carried forward from Day-3).
export const EMIT_FINDING_TOOL = {
  name: EMIT_FINDING_TOOL_NAME,
  description:
    'Terminal tool. Report which retrieved rules the PR diff violates and end the review. Call with an empty `findings` array when the diff is clean or when prior-review dismissals suppress the only candidate.',
  input_schema: {
    type: 'object' as const,
    properties: {
      findings: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            rule_id: { type: 'string' as const, minLength: 1, maxLength: 200 },
            title: { type: 'string' as const, minLength: 1, maxLength: 200 },
            message: { type: 'string' as const, minLength: 1, maxLength: 2000 },
            location_hint: { type: 'string' as const, maxLength: 500 },
            citation: { type: 'string' as const, maxLength: 1000 },
          },
          required: ['rule_id', 'title', 'message'] as const,
          additionalProperties: false,
        },
        maxItems: 10,
      },
    },
    required: ['findings'] as const,
    additionalProperties: false,
  },
};

export const REGISTERED_TOOLS = [
  FETCH_FILE_TOOL,
  FETCH_FUNCTION_TOOL,
  FETCH_PRIOR_REVIEW_TOOL,
  EMIT_FINDING_TOOL,
];

// Compute the hash of the current prompt + tools at module load. The
// `PROMPT_AND_TOOL_VERSION_HASH_MAP` is set from this so the snapshot
// spec can assert hash drift triggers a version bump. (See the spec
// in test/infrastructure/anthropic/anthropic-llm-reviewer.snapshot.spec.ts.)
export function computePromptToolHash(): string {
  return createHash('sha256')
    .update(SYSTEM_PROMPT)
    .update(JSON.stringify(REGISTERED_TOOLS))
    .digest('hex');
}

// === Adapter ===

@Injectable()
export class AnthropicLlmReviewer implements ILlmReviewer {
  private readonly logger = new Logger(AnthropicLlmReviewer.name);

  // Lazy. Constructor only reads config — no network.
  private client: AnthropicClientLike | undefined;

  constructor(private readonly config: ConfigService) {}

  async analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    const client = this.resolveClient();
    const model = this.config.anthropicModel;
    const turnCap = this.config.anthropicAgentTurnCap;
    // Reuse the canonical `SYSTEM_PROMPT` at default cap so the
    // Anthropic prompt-cache hits the same content across the common
    // path. Only rebuild when an operator has overridden the cap.
    const systemPrompt =
      turnCap === DEFAULT_TURN_CAP ? SYSTEM_PROMPT : buildSystemPrompt(turnCap);

    // Composite id = `${source}:${rule_id}`. Two corpora can share a
    // rule_id slug, so the composite is the de-duplicated identity.
    const inputRuleKeys = new Set(
      input.rules.map((r) => `${r.source}:${r.rule_id}`),
    );

    const userMessage = buildUserMessage(input);

    // The initial user turn carries the diff + retrieved rules. We
    // attach BP3 (the 3rd cache breakpoint) here — the largest static
    // prefix that survives across all turns. BP1 (end of tools) and
    // BP2 (end of system) are attached at request-construction time.
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: userMessage,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ];

    const cumulativeUsage: UsageStats = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const toolCalls: ToolCallRecord[] = [];
    let lastModel = model;
    let emittedFindings: Finding[] | null = null;
    // Day-8 observability counters. Both are reported on the terminal
    // emit_finding path (the only path that returns an AnalyzeDiffResult);
    // failure paths throw and the column defaults to 0.
    let cacheHitCount = 0;
    let hallucinatedFindingCount = 0;

    // Per-review dedup cache for non-terminal tool calls. The model
    // sometimes asks for the same (tool, input) pair across turns —
    // observed empirically: a 15-turn PR-#17 run re-fetched the same
    // file twice. Each redundant call burns one turn against the cap
    // without adding context. The cache returns the prior content with
    // a steering note instructing the model to emit instead of fetch.
    // Successful results only — error results stay uncached so the
    // model can legitimately retry a transient failure.
    const toolResultCache = new Map<
      string,
      {
        turn: number;
        content: Array<{ type: 'text'; text: string }>;
      }
    >();

    for (let turn = 1; turn <= turnCap; turn++) {
      const turnStartedAt = Date.now();
      let response: Awaited<
        ReturnType<AnthropicClientLike['messages']['create']>
      >;
      try {
        response = await client.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS_PER_TURN,
            system: [
              {
                type: 'text',
                text: systemPrompt,
                cache_control: { type: 'ephemeral' },
              },
            ],
            // BP1 — attach cache_control to the LAST registered tool.
            // The Anthropic API treats this as "cache everything up to
            // and including this block".
            tools: REGISTERED_TOOLS.map((tool, idx) =>
              idx === REGISTERED_TOOLS.length - 1
                ? { ...tool, cache_control: { type: 'ephemeral' } }
                : tool,
            ),
            tool_choice: { type: 'any' },
            messages,
          },
          // Per-request timeout. The SDK default (10 min) plus 2
          // retries plus 6 turns would let a stalled call hold the
          // review row for hours. Capping per-turn keeps the worst
          // case bounded to ~18 minutes total. Belongs in RequestOptions
          // (the 2nd arg), not the body — Anthropic rejects unknown body
          // keys with HTTP 400.
          { timeout: PER_REQUEST_TIMEOUT_MS },
        );
      } catch (err) {
        throw this.wrapSdkError(err);
      }

      lastModel = response.model;
      accumulateUsage(cumulativeUsage, response.usage);

      // Find the terminal block first (a same-turn mix of
      // `[fetch_*, emit_finding]` exits via emit_finding without
      // invoking the non-terminal tool — otherwise we'd orphan
      // tool_result blocks Claude never sees).
      const emitBlock = findToolUseBlock(
        response.content,
        EMIT_FINDING_TOOL_NAME,
      );
      const nonTerminalCalls = collectToolUseBlocks(response.content).filter(
        (b) => b.name !== EMIT_FINDING_TOOL_NAME,
      );

      if (emitBlock) {
        // Validate emit_finding payload. The terminal tool's payload
        // failing validation is fatal: throw `malformed_emit_finding`.
        // Carry the partial turnCount + toolCalls so the persisted
        // failure row reflects how far the loop got (matches the
        // turn_cap_exceeded throw below).
        const findings = parseEmitFindings(emitBlock.input);
        if (!findings) {
          throw new AnthropicRequestError(
            'emit_finding payload failed schema validation',
            {
              status: 200,
              errorCode: 'malformed_emit_finding',
              turnCount: turn,
              toolCalls,
            },
          );
        }
        emittedFindings = this.filterHallucinatedFindings(
          findings,
          input.rules,
          inputRuleKeys,
        );
        // Day-8: the filter drops findings silently; surface the count
        // so the aggregator and dashboard can show hallucination volume
        // across the time-window slice.
        hallucinatedFindingCount = findings.length - emittedFindings.length;
        const toolInputHash = hashToolInput(emitBlock.input);
        const resultBytes = approximateBytes(emitBlock.input);
        toolCalls.push({
          turn_idx: turn,
          tool_name: EMIT_FINDING_TOOL_NAME,
          input_hash: toolInputHash,
          result_bytes: resultBytes,
          latency_ms: Date.now() - turnStartedAt,
          stop_reason: response.stop_reason ?? 'unknown',
        });
        this.logTurn({
          turn,
          stop_reason: response.stop_reason,
          tool_name: EMIT_FINDING_TOOL_NAME,
          tool_input: emitBlock.input,
          tool_result_excerpt: undefined,
          usage: response.usage,
          is_terminal: true,
        });
        return {
          findings: emittedFindings,
          usage: cumulativeUsage,
          model: lastModel,
          promptVersion: PROMPT_AND_TOOL_VERSION,
          turnCount: turn,
          toolCalls,
          hallucinatedFindingCount,
          cacheHitCount,
        };
      }

      // No emit_finding. We expect at least one non-terminal tool_use
      // block (because `tool_choice: 'any'`). If there is none, treat
      // it as a protocol-level shape error.
      if (nonTerminalCalls.length === 0) {
        throw new AnthropicRequestError(
          'Anthropic response did not contain any tool_use block (tool_choice="any" requires one)',
          { status: 200, errorCode: 'unexpected_response_shape' },
        );
      }

      // Push the assistant content verbatim. Then build one
      // `tool_result` per `tool_use` block and group them in a single
      // user message — Anthropic requires every tool_use_id from the
      // previous turn to have a matching tool_result in the next.
      messages.push({ role: 'assistant', content: response.content });

      const toolResultBlocks: unknown[] = [];
      for (const block of nonTerminalCalls) {
        const blockInputHash = hashToolInput(block.input);
        const cacheKey = `${block.name}:${blockInputHash}`;
        const cached = toolResultCache.get(cacheKey);

        let result: { content: Array<{ type: 'text'; text: string }>; is_error?: boolean };
        let isCacheHit = false;
        if (cached) {
          result = { content: replayWithDedupHint(cached.content, cached.turn) };
          isCacheHit = true;
          cacheHitCount += 1;
        } else {
          result = await this.runToolCall(block, input.repoContext);
          if (result.is_error !== true) {
            toolResultCache.set(cacheKey, { turn, content: result.content });
          }
        }

        const resultExcerpt = excerpt(result.content);
        const isError = result.is_error === true;
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: isError,
          content: result.content,
        });
        toolCalls.push({
          turn_idx: turn,
          tool_name: block.name,
          input_hash: blockInputHash,
          result_bytes: approximateBytes(result.content),
          latency_ms: Date.now() - turnStartedAt,
          stop_reason: response.stop_reason ?? 'unknown',
          ...(isError ? { is_error: true } : {}),
          ...(isCacheHit ? { cache_hit: true } : {}),
        });
        this.logTurn({
          turn,
          stop_reason: response.stop_reason,
          tool_name: block.name,
          tool_input: block.input,
          tool_result_excerpt: resultExcerpt,
          usage: response.usage,
          is_terminal: false,
        });
      }
      messages.push({ role: 'user', content: toolResultBlocks });
    }

    // Reached the turn cap without `emit_finding`. The current loop
    // exit semantics make mid-loop emit_finding structurally
    // impossible (handled above), so this branch is purely the cap.
    throw new AnthropicRequestError(
      `Agent loop exceeded ${turnCap} turns without ${EMIT_FINDING_TOOL_NAME}`,
      {
        status: 200,
        errorCode: 'turn_cap_exceeded',
        turnCount: turnCap,
        toolCalls,
      },
    );
  }

  // Test seam — overridden in spec to substitute a mock client without
  // jest.mock() on the @anthropic-ai/sdk module. Production path
  // constructs a real `Anthropic` client with `maxRetries: 2`.
  protected createClient(): AnthropicClientLike {
    return new Anthropic({
      apiKey: this.config.anthropicApiKey,
      maxRetries: SDK_MAX_RETRIES,
    }) as unknown as AnthropicClientLike;
  }

  private resolveClient(): AnthropicClientLike {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  private async runToolCall(
    block: { name: string; id: string; input: unknown },
    repoContext: IRepoContextProvider | undefined,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; is_error?: boolean }> {
    // No repoContext provider → every non-terminal tool is unavailable.
    // Returning `is_error: true` keeps the loop alive so Claude can
    // recover; the next turn will see the failure and decide either
    // to try a different input or to emit.
    if (!repoContext) {
      return {
        content: [{ type: 'text', text: 'tool unavailable: no repo context configured' }],
        is_error: true,
      };
    }

    // Per-tool input validation. Non-terminal failures become
    // `is_error` tool_results; the loop continues.
    try {
      switch (block.name) {
        case FETCH_FILE_TOOL_NAME: {
          const input = block.input as { path?: unknown };
          if (typeof input.path !== 'string' || input.path.length === 0) {
            return errorToolResult(`invalid_input: \`path\` expected string`);
          }
          const result = await repoContext.fetchFile(input.path);
          if (!result.ok) {
            return errorToolResult(formatProviderError(result.reason, result.message));
          }
          return successToolResult(`# ${result.path}\n\n${result.content}`);
        }

        case FETCH_FUNCTION_TOOL_NAME: {
          const input = block.input as { name?: unknown; file?: unknown };
          if (typeof input.name !== 'string' || input.name.length === 0) {
            return errorToolResult(`invalid_input: \`name\` expected string`);
          }
          if (input.file !== undefined && typeof input.file !== 'string') {
            return errorToolResult(`invalid_input: \`file\` expected string`);
          }
          const result = await repoContext.fetchFunctionDefinition(
            input.name,
            input.file,
          );
          if (!result.ok) {
            return errorToolResult(formatProviderError(result.reason, result.message));
          }
          return successToolResult(
            `# ${result.path} (lines ${result.startLine}-${result.endLine})\n\n${result.content}`,
          );
        }

        case FETCH_PRIOR_REVIEW_TOOL_NAME: {
          const input = block.input as {
            pr_node_id?: unknown;
            file_path?: unknown;
            rule_id?: unknown;
          };
          const query: Parameters<IRepoContextProvider['fetchPriorReview']>[0] = {};
          if (input.pr_node_id !== undefined) {
            if (typeof input.pr_node_id !== 'string') {
              return errorToolResult('invalid_input: `pr_node_id` expected string');
            }
            query.pr_node_id = input.pr_node_id;
          }
          if (input.file_path !== undefined) {
            if (typeof input.file_path !== 'string') {
              return errorToolResult('invalid_input: `file_path` expected string');
            }
            query.file_path = input.file_path;
          }
          if (input.rule_id !== undefined) {
            if (typeof input.rule_id !== 'string') {
              return errorToolResult('invalid_input: `rule_id` expected string');
            }
            query.rule_id = input.rule_id;
          }
          const result = await repoContext.fetchPriorReview(query);
          if (!result.ok) {
            return errorToolResult(formatProviderError(result.reason, result.message));
          }
          return successToolResult(JSON.stringify(result.content));
        }

        default:
          return errorToolResult(`unknown_tool: ${block.name}`);
      }
    } catch (err: unknown) {
      // Provider methods aren't supposed to throw, but if one does
      // we want to keep the loop alive rather than crash it.
      const msg = err instanceof Error ? err.message : 'unknown error';
      return errorToolResult(`tool_invocation_error: ${msg}`);
    }
  }

  private filterHallucinatedFindings(
    raw: Finding[],
    rules: AnalyzeDiffInput['rules'],
    inputRuleKeys: Set<string>,
  ): Finding[] {
    const out: Finding[] = [];
    for (const f of raw) {
      const matchedRule = rules.find((r) => r.rule_id === f.rule_id);
      if (!matchedRule) {
        this.logger.warn(
          `Dropped hallucinated rule_id="${sanitizeSlug(f.rule_id)}"`,
        );
        continue;
      }
      const composite = `${matchedRule.source}:${matchedRule.rule_id}`;
      if (!inputRuleKeys.has(composite)) {
        this.logger.warn(
          `Dropped finding with unknown composite="${sanitizeSlug(composite)}"`,
        );
        continue;
      }
      out.push({
        rule_id: f.rule_id,
        title: f.title,
        message: f.message,
        location_hint: f.location_hint ?? null,
        citation: f.citation ?? null,
      });
    }
    return out;
  }

  private logTurn(args: {
    turn: number;
    stop_reason: string | null;
    tool_name: string;
    tool_input: unknown;
    tool_result_excerpt?: string;
    usage: { input_tokens: number; output_tokens: number };
    is_terminal: boolean;
  }): void {
    // Terminal turn logs the full input; non-terminal turns log a
    // hash + excerpt to keep token-heavy file contents out of logs.
    const baseFields = {
      turn_idx: args.turn,
      stop_reason: args.stop_reason,
      tool_name: args.tool_name,
      usage: args.usage,
    };
    if (args.is_terminal) {
      this.logger.log(
        `agent-turn: ${JSON.stringify({
          ...baseFields,
          tool_input: args.tool_input,
        })}`,
      );
    } else {
      this.logger.log(
        `agent-turn: ${JSON.stringify({
          ...baseFields,
          tool_input_hash: hashToolInput(args.tool_input),
          tool_result_excerpt: args.tool_result_excerpt,
        })}`,
      );
    }
  }

  private wrapSdkError(err: unknown): AnthropicRequestError {
    if (err instanceof APIError) {
      const status = err.status ?? 0;
      const body = err.error as
        | { error?: { type?: string; message?: string } }
        | undefined;
      const rawErrorCode = body?.error?.type;
      const serverMessage = body?.error?.message
        ? truncateForLog(body.error.message)
        : undefined;
      const errorCode = classifyErrorCode(status, rawErrorCode, serverMessage);
      const baseMsg = `Anthropic API error: HTTP ${status}${errorCode ? ` (${errorCode})` : ''}`;
      const fullMsg = serverMessage ? `${baseMsg} — ${serverMessage}` : baseMsg;
      return new AnthropicRequestError(fullMsg, {
        status,
        errorCode,
        serverMessage,
        retryAfterMs: parseAnthropicRetryAfterMs(err),
        cause: err,
      });
    }
    return new AnthropicRequestError(
      'Anthropic request failed (network or transport error)',
      { status: 0, cause: err },
    );
  }
}

// Day-5 F4 closure. Parse the `retry-after` header off an Anthropic
// APIError so the BullMQ backoffStrategy can honour it. Anthropic
// returns retry-after as delta seconds; clamp invalid/negative
// values to undefined so the caller falls back to exponential.
function parseAnthropicRetryAfterMs(err: APIError): number | undefined {
  const headers = (err as { headers?: unknown }).headers;
  if (!headers) return undefined;
  // `headers` may be a Headers instance or a plain object depending
  // on the SDK version; normalise the lookup.
  let raw: string | undefined;
  if (typeof (headers as { get?: (k: string) => string | null }).get === 'function') {
    raw =
      (headers as { get: (k: string) => string | null }).get('retry-after') ??
      undefined;
  } else if (typeof headers === 'object') {
    const dict = headers as Record<string, string | string[] | undefined>;
    const v = dict['retry-after'] ?? dict['Retry-After'];
    raw = Array.isArray(v) ? v[0] : v;
  }
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.floor(seconds * 1000);
}

// === Module-scope helpers ===

function buildUserMessage(input: AnalyzeDiffInput): string {
  const rulesBlock = input.rules
    .map((r) => `## ${r.rule_id} (${r.source})\n${r.document}`)
    .join('\n\n');
  return `<retrieved_rules>\n${rulesBlock}\n</retrieved_rules>\n<diff>\n${input.diff}\n</diff>`;
}

function findToolUseBlock(
  content: unknown[],
  toolName: string,
): { name: string; id: string; input: unknown } | undefined {
  for (const block of content) {
    const b = block as {
      type?: string;
      name?: string;
      id?: string;
      input?: unknown;
    };
    if (b.type === 'tool_use' && b.name === toolName) {
      return { name: b.name, id: b.id ?? '', input: b.input };
    }
  }
  return undefined;
}

function collectToolUseBlocks(
  content: unknown[],
): Array<{ name: string; id: string; input: unknown }> {
  const out: Array<{ name: string; id: string; input: unknown }> = [];
  for (const block of content) {
    const b = block as {
      type?: string;
      name?: string;
      id?: string;
      input?: unknown;
    };
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      out.push({ name: b.name, id: b.id ?? '', input: b.input });
    }
  }
  return out;
}

function parseEmitFindings(input: unknown): Finding[] | null {
  if (typeof input !== 'object' || input === null) return null;
  const findings = (input as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return null;
  // Validate every finding has the required shape; bail (return null)
  // if any is malformed — that triggers `malformed_emit_finding`.
  const out: Finding[] = [];
  for (const f of findings) {
    if (typeof f !== 'object' || f === null) return null;
    const item = f as Record<string, unknown>;
    if (typeof item.rule_id !== 'string' || item.rule_id.length === 0) return null;
    if (typeof item.title !== 'string' || item.title.length === 0) return null;
    if (typeof item.message !== 'string' || item.message.length === 0) return null;
    if (
      item.location_hint !== undefined &&
      item.location_hint !== null &&
      typeof item.location_hint !== 'string'
    ) {
      return null;
    }
    if (
      item.citation !== undefined &&
      item.citation !== null &&
      typeof item.citation !== 'string'
    ) {
      return null;
    }
    out.push({
      rule_id: item.rule_id,
      title: item.title,
      message: item.message,
      location_hint: (item.location_hint as string | undefined) ?? null,
      citation: (item.citation as string | undefined) ?? null,
    });
  }
  return out;
}

function accumulateUsage(
  acc: UsageStats,
  resp: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
): void {
  acc.input_tokens += resp.input_tokens ?? 0;
  acc.output_tokens += resp.output_tokens ?? 0;
  acc.cache_creation_input_tokens =
    (acc.cache_creation_input_tokens ?? 0) +
    (resp.cache_creation_input_tokens ?? 0);
  acc.cache_read_input_tokens =
    (acc.cache_read_input_tokens ?? 0) + (resp.cache_read_input_tokens ?? 0);
}

function hashToolInput(input: unknown): string {
  // 16-char SHA-256 prefix of canonical-JSON. Plenty of bits to
  // disambiguate per-review log lines without bloating storage.
  return createHash('sha256')
    .update(JSON.stringify(input ?? {}))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Wrap a cached tool result with a steering hint prepended to the
 * existing content. The hint tells the model this request is a repeat
 * of an earlier turn so it can stop re-fetching the same artifact and
 * move toward `emit_finding`. The original content is preserved
 * verbatim — the model still has all the data it asked for.
 */
function replayWithDedupHint(
  cached: Array<{ type: 'text'; text: string }>,
  cachedAtTurn: number,
): Array<{ type: 'text'; text: string }> {
  const hint =
    `[Note: an identical request was already served on turn ${cachedAtTurn}; ` +
    `cached content follows. If you have enough context, call \`emit_finding\` ` +
    `(or finish the review) instead of fetching the same artifact again.]\n\n`;
  if (cached.length === 0) {
    return [{ type: 'text', text: hint.trimEnd() }];
  }
  const [head, ...rest] = cached;
  return [{ type: 'text', text: hint + head.text }, ...rest];
}

function approximateBytes(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8');
  if (Array.isArray(payload)) {
    return payload.reduce<number>((sum, p) => sum + approximateBytes(p), 0);
  }
  if (typeof payload === 'object') {
    const p = payload as { type?: string; text?: string };
    if (p.type === 'text' && typeof p.text === 'string') {
      return Buffer.byteLength(p.text, 'utf8');
    }
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  }
  return 0;
}

function excerpt(content: Array<{ type: string; text?: string }>): string {
  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    return '';
  }
  return first.text.length > 200 ? first.text.slice(0, 200) + '…' : first.text;
}

function successToolResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text }] };
}

function errorToolResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  is_error: true;
} {
  return { content: [{ type: 'text', text }], is_error: true };
}

function formatProviderError(
  reason: RepoContextErrorReason,
  message: string,
): string {
  return `${reason}: ${message}`;
}

// Suppress unused-symbol warning for `PriorReviewEntry` — exported
// type only; we use it indirectly through the provider's return shape.
export type { PriorReviewEntry };

function sanitizeSlug(value: unknown): string {
  if (typeof value !== 'string') return '<non-string>';
  const trimmed = value.replace(/[\r\n]+/g, ' ').slice(0, 80);
  return trimmed;
}

function truncateForLog(s: string): string {
  const normalized = s.replace(/[\r\n]+/g, ' ').trim();
  return normalized.length > 500 ? normalized.slice(0, 500) + '…' : normalized;
}

function classifyErrorCode(
  status: number,
  rawErrorCode: string | undefined,
  serverMessage: string | undefined,
): string | undefined {
  if (
    status === 400 &&
    rawErrorCode === 'invalid_request_error' &&
    serverMessage &&
    /credit balance is too low/i.test(serverMessage)
  ) {
    return 'credit_balance_too_low';
  }
  return rawErrorCode;
}

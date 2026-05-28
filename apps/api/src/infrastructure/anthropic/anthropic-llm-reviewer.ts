import { Injectable, Logger } from '@nestjs/common';
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { ConfigService } from '@/config';
import {
  AnalyzeDiffInput,
  AnalyzeDiffResult,
  Finding,
  ILlmReviewer,
  PROMPT_AND_TOOL_VERSION,
  UsageStats,
} from '@/modules/reviews/types/llm-reviewer';
import { AnthropicRequestError } from './anthropic-request.error';

// Loose alias for the subset of the Anthropic client surface this
// adapter uses. Mirrors the `ChromaClientLike` pattern in
// `infrastructure/chroma/` — keeping it narrow lets test stubs
// implement only `messages.create` without satisfying every signature
// on the real `Anthropic` class.
type AnthropicClientLike = {
  messages: {
    create: (args: unknown) => Promise<{
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

// Generous default — the empty findings array uses ~50 tokens; a large
// findings array caps around 2000. Set on the adapter (not per-call) so
// the prompt-cache prefix stays byte-identical across calls.
const MAX_TOKENS = 4096;

// SDK auto-retry behavior. Set explicitly so the troubleshooting doc
// and runtime agree: a 429 or 529 is retried twice with exponential
// backoff before throwing. Set to 0 to disable; bump if a transient-
// failure pattern shows up in U4 integration / U7 smoke.
const SDK_MAX_RETRIES = 2;

// System prompt + tool definition live at module scope (not constructed
// per call) so the prompt-cache breakpoint hits byte-for-byte across
// calls. CRITICAL: editing either of these requires bumping
// PROMPT_AND_TOOL_VERSION in the same commit (the snapshot spec
// enforces this).
export const SYSTEM_PROMPT = [
  'You are an automated code reviewer for a software team.',
  '',
  'You will be given a unified diff and a list of retrieved rules from the team knowledge base. Your job is to identify which of the retrieved rules — and ONLY those rules — the diff violates.',
  '',
  'Strict constraints:',
  '- You MUST call the `report_findings` tool exactly once. Do not respond with free-form text.',
  '- You MUST only cite rules whose `rule_id` appears in the retrieved rule set. Never invent rule_ids and never quote rules from memory.',
  '- If the diff does not violate any retrieved rule, call `report_findings` with `findings: []`. An empty findings array is a valid and expected outcome on clean diffs.',
  '- One finding per distinct violation. Do not duplicate findings for the same rule on the same line.',
  '- Keep `message` actionable: state what was violated and how to fix it in 1–3 sentences.',
  '- Populate `location_hint` with a file path + line range when you can identify one from the diff hunk headers (e.g., "src/totals.js:3-5"). Leave it absent if unsure rather than guessing.',
  '- Populate `citation` with the shortest snippet from the diff that demonstrates the violation. Omit it when no concise snippet captures the issue.',
  '',
  'You will receive the retrieved rules first, then the diff. Treat the retrieved rules as the only authoritative knowledge — your prior training is irrelevant for what is and is not a rule violation.',
  '',
  'Precision discipline (false positives erode reviewer trust faster than missed violations):',
  '- When uncertain whether a fragment violates a retrieved rule, err toward NOT flagging it. A clean review on an actually-violating diff is recoverable; a noisy review on a clean diff trains the team to ignore the reviewer.',
  '- Do not flag the same logical issue under multiple rule_ids. Pick the rule that most specifically describes the violation.',
  '- Do not flag style preferences that are not explicitly stated in the retrieved rules.',
  '- Do not infer "what the team probably wants" beyond what the retrieved rule text says.',
  '',
  'Examples of correct outputs (these rule_ids are illustrative — only flag rules actually present in <retrieved_rules>):',
  '',
  'Example 1 — diff replaces `let`/`const` with `var`, and `no-var` is in the retrieved rules.',
  '  Emit one finding:',
  '    rule_id: no-var',
  '    title: Use let or const, never var',
  '    message: Replace `var` with `let` or `const`. `var` is function-scoped and hoisted, which leads to subtle re-declaration and closure bugs. Use `const` for bindings that are never reassigned, `let` otherwise.',
  '    location_hint: src/totals.js:3',
  '    citation: var sum = 0;',
  '',
  'Example 2 — diff introduces `==`/`!=` instead of strict equality, and `eqeqeq` is in the retrieved rules.',
  '  Emit one finding per distinct violating line. Do NOT emit one finding per `==` occurrence on the same line. The `citation` field should be a single concise snippet (the line itself or the shortest fragment that captures the violation).',
  '',
  'Example 3 — diff is a doc-only change (README.md, CHANGELOG.md, a comment-only edit). No code rules apply.',
  '  Correct response: call `report_findings` with `findings: []`. Never invent a finding to make the call non-empty.',
  '',
  'Example 4 — diff has multiple distinct violations across multiple files (e.g., `no-var` in one file and `eqeqeq` in another), and both rules are in the retrieved set.',
  '  Emit one finding per distinct rule per distinct location. Each finding stands on its own — do not bundle multiple rule violations into a single finding.',
  '',
  'Example 5 — diff includes a fragment that looks suspicious but no retrieved rule explicitly covers it (e.g., a magic number when `no-magic-numbers` is NOT in the retrieved set).',
  '  Correct response: do not emit a finding for that fragment. Only the retrieved rule set is authoritative.',
].join('\n');

// The forced single tool. `severity` is DELIBERATELY ABSENT from the
// schema — it's sourced from the matched rule's metadata in
// `ReviewsService` at persistence (D1 in the deepening pass). Letting
// Claude emit severity would let it silently disagree with the rule
// declaration; rule metadata wins.
export const REPORT_FINDINGS_TOOL = {
  name: 'report_findings',
  description:
    'Report which retrieved rules the PR diff violates. Call with an empty `findings` array when the diff is clean.',
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
        maxItems: 50,
      },
    },
    required: ['findings'] as const,
    additionalProperties: false,
  },
};

@Injectable()
export class AnthropicLlmReviewer implements ILlmReviewer {
  private readonly logger = new Logger(AnthropicLlmReviewer.name);

  // Lazy. Constructor only reads config — no network. The first
  // `analyzeDiff` call is what instantiates the SDK client. Mirrors the
  // `ChromaVectorStore` lazy pattern so DI bootstrap stays network-free
  // and every spec that loads `AppModule` doesn't accidentally open a
  // socket.
  private client: AnthropicClientLike | undefined;

  constructor(private readonly config: ConfigService) {}

  async analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    const client = this.resolveClient();
    const model = this.config.anthropicModel;

    // Composite id = `${source}:${rule_id}`. Two corpora can share a
    // rule_id slug, so the composite is the de-duplicated identity.
    // This is also the key used by the hallucination filter below.
    const inputRuleKeys = new Set(
      input.rules.map((r) => `${r.source}:${r.rule_id}`),
    );

    const userMessage = buildUserMessage(input);

    let response: Awaited<ReturnType<AnthropicClientLike['messages']['create']>>;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [REPORT_FINDINGS_TOOL],
        tool_choice: { type: 'tool', name: REPORT_FINDINGS_TOOL.name },
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (err) {
      throw this.wrapSdkError(err);
    }

    // Truncated / refused responses must NEVER be silently treated as
    // success. `tool_use` and `end_turn` are the only valid stops; any
    // other value (max_tokens, stop_sequence, pause_turn, refusal) means
    // the response is incomplete or off-shape.
    if (response.stop_reason !== 'tool_use' && response.stop_reason !== 'end_turn') {
      throw new AnthropicRequestError(
        `Anthropic stop_reason='${response.stop_reason}' — response did not complete with a tool call`,
        { status: 200, errorCode: 'truncated_response' },
      );
    }

    const toolUse = extractToolUse(response.content, REPORT_FINDINGS_TOOL.name);
    if (!toolUse) {
      throw new AnthropicRequestError(
        'Anthropic response did not contain a report_findings tool_use block',
        { status: 200, errorCode: 'unexpected_response_shape' },
      );
    }

    const rawFindings = (toolUse.input as { findings?: unknown }).findings;
    if (!Array.isArray(rawFindings)) {
      throw new AnthropicRequestError(
        'Anthropic tool_use input did not contain a findings array',
        { status: 200, errorCode: 'unexpected_response_shape' },
      );
    }

    // Filter hallucinated rule_ids — keyed on the composite
    // `${source}:${rule_id}` so two corpora that share a slug don't
    // leak past the filter. The SDK validates `input_schema`
    // server-side, so by the time we reach here each item has the
    // required fields; this filter handles the semantic check (does
    // the rule actually exist in the retrieved set?).
    const findings: Finding[] = [];
    for (const raw of rawFindings) {
      const f = raw as Finding;
      // We don't know the source from the finding; assume each
      // rule_id is unique in the input set (the service builds the
      // input). If two sources share a slug, the input ordering wins —
      // a known minor edge case documented in the plan.
      const matchedRule = input.rules.find((r) => r.rule_id === f.rule_id);
      if (!matchedRule) {
        // Log only the slug — never the full finding (which could
        // echo back the diff in `citation`).
        this.logger.warn(`Dropped hallucinated rule_id="${sanitizeSlug(f.rule_id)}"`);
        continue;
      }
      // Re-verify the composite to be sure (the matched rule's source
      // is the authoritative source).
      const composite = `${matchedRule.source}:${matchedRule.rule_id}`;
      if (!inputRuleKeys.has(composite)) {
        this.logger.warn(`Dropped finding with unknown composite="${sanitizeSlug(composite)}"`);
        continue;
      }
      findings.push({
        rule_id: f.rule_id,
        title: f.title,
        message: f.message,
        location_hint: f.location_hint ?? null,
        citation: f.citation ?? null,
      });
    }

    const usage: UsageStats = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? null,
    };

    return {
      findings,
      usage,
      model: response.model,
      promptVersion: PROMPT_AND_TOOL_VERSION,
    };
  }

  // Test seam — overridden in spec to substitute a mock client without
  // jest.mock() on the @anthropic-ai/sdk module. Production path
  // constructs a real `Anthropic` client with `maxRetries: 2`. Same
  // pattern as `ChromaVectorStore.createClient()`.
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

  private wrapSdkError(err: unknown): AnthropicRequestError {
    // The SDK throws `APIError` subclasses for HTTP-shaped failures
    // (4xx/5xx with a parsed body). Transport / network errors arrive
    // as plain Errors (or `TypeError` from fetch under the hood).
    if (err instanceof APIError) {
      const status = err.status ?? 0;
      // err.error.error.type is Anthropic's structured error_code
      // (e.g. 'rate_limit_error', 'authentication_error',
      // 'overloaded_error', 'invalid_request_error'). The outer
      // err.error.type is always literal 'error'.
      const body = err.error as
        | { error?: { type?: string; message?: string } }
        | undefined;
      const rawErrorCode = body?.error?.type;
      // The server's textual explanation (e.g. "Model not found" or
      // "tools.0.input_schema: invalid"). Safe to surface — this is
      // the server's reason for the failure, NOT echoed input. Capped
      // at 500 chars defensively so a future verbose explanation
      // can't bloat logs.
      const serverMessage = body?.error?.message
        ? truncateForLog(body.error.message)
        : undefined;
      // Anthropic returns `invalid_request_error` for "credit balance
      // too low" — which is opaque to the operator (the same code
      // covers genuine schema validation errors). Pattern-match the
      // server message and surface a clearer errorCode so the
      // troubleshooting table + on-call alerts can branch on it.
      const errorCode = classifyErrorCode(status, rawErrorCode, serverMessage);
      // CONSTRUCT OUR OWN MESSAGE — never reuse err.message, which
      // contains the raw body (including any echoed input fragments).
      // We DO include the server's `message` field because that's a
      // server-authored explanation, not a body echo.
      const baseMsg = `Anthropic API error: HTTP ${status}${errorCode ? ` (${errorCode})` : ''}`;
      const fullMsg = serverMessage ? `${baseMsg} — ${serverMessage}` : baseMsg;
      return new AnthropicRequestError(fullMsg, {
        status,
        errorCode,
        serverMessage,
        cause: err,
      });
    }
    // Transport-level failure (network down, DNS failure, etc).
    return new AnthropicRequestError(
      'Anthropic request failed (network or transport error)',
      { status: 0, cause: err },
    );
  }
}

// User-message builder lives at module scope so the snapshot/byte-
// identical-args test can verify it is deterministic given the inputs.
function buildUserMessage(input: AnalyzeDiffInput): string {
  const rulesBlock = input.rules
    .map((r) => `## ${r.rule_id} (${r.source})\n${r.document}`)
    .join('\n\n');
  return `<retrieved_rules>\n${rulesBlock}\n</retrieved_rules>\n<diff>\n${input.diff}\n</diff>`;
}

function extractToolUse(
  content: unknown[],
  toolName: string,
): { name: string; input: unknown } | undefined {
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: unknown };
    if (b.type === 'tool_use' && b.name === toolName) {
      return { name: b.name, input: b.input };
    }
  }
  return undefined;
}

// Defensive — never echo unbounded content into a log. Rule ids are
// short slugs, but a hallucinated value could be anything Claude
// returns, including very long strings. Cap at 80 chars.
function sanitizeSlug(value: unknown): string {
  if (typeof value !== 'string') return '<non-string>';
  const trimmed = value.replace(/[\r\n]+/g, ' ').slice(0, 80);
  return trimmed;
}

// Cap server-provided error explanations at 500 chars so a verbose
// schema-validation error doesn't bloat logs or panic dumps.
function truncateForLog(s: string): string {
  const normalized = s.replace(/[\r\n]+/g, ' ').trim();
  return normalized.length > 500 ? normalized.slice(0, 500) + '…' : normalized;
}

// Anthropic returns HTTP 400 + error.type='invalid_request_error' for
// genuine schema problems AND for "your credit balance is too low".
// Operationally these are very different — schema bugs are code
// problems, empty credits is a billing problem. Pattern-match the
// server message to give the operator a clearer signal.
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

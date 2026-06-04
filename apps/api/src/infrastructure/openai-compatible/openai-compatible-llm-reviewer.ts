import { Injectable, Logger } from '@nestjs/common';
import OpenAI, { APIError } from 'openai';
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
  RepoContextErrorReason,
} from '@/modules/reviews/types/repo-context-provider';
import { ToolCallRecord } from '@/modules/reviews/types/review.types';
import {
  buildSystemPrompt,
  DEFAULT_TURN_CAP,
  EMIT_FINDING_TOOL_NAME,
  FETCH_FILE_TOOL_NAME,
  FETCH_FUNCTION_TOOL_NAME,
  FETCH_PRIOR_REVIEW_TOOL_NAME,
  REGISTERED_TOOLS,
  SYSTEM_PROMPT,
} from '@/infrastructure/anthropic';
// AnthropicRequestError is the canonical "LLM call failed" error
// shape today. The consumer in reviews.processor.ts checks
// `err instanceof AnthropicRequestError` to route failure paths
// (see isAnthropicErrorLike / isTerminalAnthropicError). The new
// reviewer throws the same class so consumer code is unchanged
// during the spike — the rename to a provider-neutral
// `LlmRequestError` is deferred to the full migration.
import { AnthropicRequestError } from '@/infrastructure/anthropic/anthropic-request.error';

// Narrow surface of the OpenAI client this adapter touches. Mirrors
// the `AnthropicClientLike` pattern in the sibling reviewer — keeping
// it narrow lets test stubs implement only `chat.completions.create`
// without satisfying every signature on the real `OpenAI` class.
type OpenAIClientLike = {
  chat: {
    completions: {
      create: (args: unknown, options?: unknown) => Promise<{
        id?: string;
        model: string;
        choices: Array<{
          index: number;
          message: {
            role: string;
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason: string | null;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      }>;
    };
  };
};

// Per-turn ceiling on completion tokens. Mirrors the Anthropic
// reviewer's MAX_TOKENS_PER_TURN — generous enough for an
// `emit_finding` payload with the full 10 findings (~2k tokens) and
// modest enough that a runaway turn can't bloat.
const MAX_TOKENS_PER_TURN = 2048;

// SDK auto-retry behaviour. The `openai` SDK retries on 408/409/429/5xx
// by default; pinning to 2 matches the Anthropic adapter's discipline
// so failure semantics line up across providers.
const SDK_MAX_RETRIES = 2;

// Per-request timeout in ms. Same rationale as the Anthropic adapter:
// the default plus retries plus N turns would let a stalled call hold
// the row for hours; 60s per request caps the worst case at ~18 minutes
// total for a 6-turn loop with 2 retries.
const PER_REQUEST_TIMEOUT_MS = 60_000;

// OpenAI's `tool` block shape. JSON Schema lives under
// `function.parameters` (vs Anthropic's `input_schema`); semantically
// identical contents.
type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

// Convert the canonical Anthropic-shape tool definitions to OpenAI
// function-calling shape. Pure rename — `input_schema` → `parameters`,
// wrap in `{type: 'function', function: {...}}`. The snapshot test in
// llm-reviewer.spec.ts guards the canonical schema bytes; this adapter
// never mutates them, only repackages.
function toOpenAITool(t: (typeof REGISTERED_TOOLS)[number]): OpenAITool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  };
}

// Internal message shape we accumulate across turns. Loose typing —
// OpenAI's strict union covers system/user/assistant/tool but the SDK
// accepts a wider surface than its types expose and we route through
// the narrow client interface anyway.
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

@Injectable()
export class OpenAICompatibleLlmReviewer implements ILlmReviewer {
  private readonly logger = new Logger(OpenAICompatibleLlmReviewer.name);

  // Lazy. Constructor only reads config — no network.
  private client: OpenAIClientLike | undefined;

  constructor(private readonly config: ConfigService) {}

  async analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    const client = this.resolveClient();
    const model = this.config.openrouterModel;
    const turnCap = this.config.anthropicAgentTurnCap;
    // Reuse the canonical SYSTEM_PROMPT (built at DEFAULT_TURN_CAP)
    // when the turn cap is the default — the bytes of the system
    // prompt are part of the snapshot-hash invariant. Non-default
    // caps yield a runtime-only variant with the same shape.
    const systemPrompt =
      turnCap === DEFAULT_TURN_CAP ? SYSTEM_PROMPT : buildSystemPrompt(turnCap);

    // Composite id = `${source}:${rule_id}`. Two corpora can share a
    // rule_id slug, so the composite is the de-duplicated identity.
    const inputRuleKeys = new Set(
      input.rules.map((r) => `${r.source}:${r.rule_id}`),
    );

    const userMessage = buildUserMessage(input);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const tools: OpenAITool[] = REGISTERED_TOOLS.map(toOpenAITool);

    const cumulativeUsage: UsageStats = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    };
    const toolCalls: ToolCallRecord[] = [];
    let lastModel = model;
    let emittedFindings: Finding[] | null = null;
    let cacheHitCount = 0;
    let hallucinatedFindingCount = 0;

    // Per-review dedup cache for non-terminal tool calls — same
    // semantics as the Anthropic reviewer's `toolResultCache`.
    // Successful results only; error results stay uncached so the
    // model can legitimately retry transient failures.
    const toolResultCache = new Map<
      string,
      {
        turn: number;
        content: string;
      }
    >();

    for (let turn = 1; turn <= turnCap; turn++) {
      const turnStartedAt = Date.now();
      let response: Awaited<
        ReturnType<OpenAIClientLike['chat']['completions']['create']>
      >;
      try {
        response = await client.chat.completions.create(
          {
            model,
            messages,
            tools,
            // OpenAI analog of Anthropic's `tool_choice: {type: 'any'}`
            // — force at least one tool call per turn. `'required'`
            // is the documented value for OpenAI / OpenRouter.
            tool_choice: 'required',
            max_tokens: MAX_TOKENS_PER_TURN,
          },
          { timeout: PER_REQUEST_TIMEOUT_MS },
        );
      } catch (err) {
        throw this.wrapSdkError(err);
      }

      lastModel = response.model;
      accumulateUsage(cumulativeUsage, response.usage);

      const assistantMessage = response.choices[0]?.message;
      if (!assistantMessage) {
        throw new AnthropicRequestError(
          'OpenAI-compatible response had no choices[0].message',
          { status: 200, errorCode: 'unexpected_response_shape' },
        );
      }
      const rawToolCalls = assistantMessage.tool_calls ?? [];

      this.logTurnVerbose({
        turn,
        request: { model, message_count: messages.length, tool_count: tools.length },
        response: {
          finish_reason: response.choices[0]?.finish_reason,
          tool_call_count: rawToolCalls.length,
          content_excerpt: excerptString(assistantMessage.content),
          usage: response.usage,
        },
      });

      // Parse and partition tool calls. A malformed arguments JSON
      // counts as a parse failure — recorded but not raised. The
      // model is allowed to mix [emit_finding, fetch_*] in the same
      // turn; emit wins (loop terminates) so the non-terminal calls
      // are not executed.
      const parsedCalls: Array<{
        id: string;
        name: string;
        input: unknown;
      }> = [];
      let parseFailures = 0;
      for (const call of rawToolCalls) {
        if (call.type !== 'function') {
          parseFailures += 1;
          continue;
        }
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(call.function.arguments);
        } catch {
          parseFailures += 1;
          this.logger.warn(
            `tool_call arguments failed JSON.parse (turn=${turn} tool=${call.function.name})`,
          );
          continue;
        }
        parsedCalls.push({
          id: call.id,
          name: call.function.name,
          input: parsedInput,
        });
      }

      const emitCall = parsedCalls.find(
        (c) => c.name === EMIT_FINDING_TOOL_NAME,
      );
      const nonTerminalCalls = parsedCalls.filter(
        (c) => c.name !== EMIT_FINDING_TOOL_NAME,
      );

      if (emitCall) {
        const findings = parseEmitFindings(emitCall.input);
        if (!findings) {
          // Spike diagnostic: log the raw payload so we can see why
          // schema validation failed. Truncated to 2KB to keep log
          // sizes sane. Gated on llmSpikeVerbose to keep the
          // production-path quiet.
          if (this.config.llmSpikeVerbose) {
            this.logger.warn(
              `emit_finding raw payload (validation FAILED): ${truncateForLog(
                JSON.stringify(emitCall.input).slice(0, 2048),
              )}`,
            );
          }
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
        hallucinatedFindingCount = findings.length - emittedFindings.length;
        const toolInputHash = hashToolInput(emitCall.input);
        const resultBytes = approximateBytes(emitCall.input);
        toolCalls.push({
          turn_idx: turn,
          tool_name: EMIT_FINDING_TOOL_NAME,
          input_hash: toolInputHash,
          result_bytes: resultBytes,
          latency_ms: Date.now() - turnStartedAt,
          stop_reason:
            response.choices[0]?.finish_reason ?? 'unknown',
        });
        this.logTurn({
          turn,
          finish_reason: response.choices[0]?.finish_reason ?? null,
          tool_name: EMIT_FINDING_TOOL_NAME,
          tool_input: emitCall.input,
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

      // No emit_finding. We expect at least one parseable non-terminal
      // tool call (because tool_choice='required'). Degenerate paths:
      //   - tool_choice ignored, no tool calls: shape error
      //   - all tool calls failed to parse: shape error (data we want)
      if (rawToolCalls.length === 0) {
        throw new AnthropicRequestError(
          'OpenAI-compatible response had no tool_calls (tool_choice="required" requires one)',
          { status: 200, errorCode: 'unexpected_response_shape' },
        );
      }
      if (nonTerminalCalls.length === 0 && parseFailures > 0) {
        throw new AnthropicRequestError(
          `All ${parseFailures} tool_calls had unparseable arguments`,
          { status: 200, errorCode: 'unexpected_response_shape' },
        );
      }

      // Push the assistant message verbatim — OpenAI requires the
      // assistant turn carrying tool_calls to appear before the
      // matching role:tool messages, with every tool_call_id covered.
      messages.push({
        role: 'assistant',
        content: assistantMessage.content,
        tool_calls: rawToolCalls,
      });

      for (const call of nonTerminalCalls) {
        const blockInputHash = hashToolInput(call.input);
        const cacheKey = `${call.name}:${blockInputHash}`;
        const cached = toolResultCache.get(cacheKey);

        let resultText: string;
        let isError: boolean;
        let isCacheHit = false;
        if (cached) {
          resultText = replayWithDedupHint(cached.content, cached.turn);
          isError = false;
          isCacheHit = true;
          cacheHitCount += 1;
        } else {
          const result = await this.runToolCall(call, input.repoContext);
          resultText = result.text;
          isError = result.is_error === true;
          if (!isError) {
            toolResultCache.set(cacheKey, { turn, content: result.text });
          }
        }

        const resultExcerpt = excerptString(resultText);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          // OpenAI's tool result content is a string. We prefix
          // is_error semantics inline since the schema doesn't carry
          // a typed error flag — the model can read the marker.
          content: isError ? `[is_error] ${resultText}` : resultText,
        });
        toolCalls.push({
          turn_idx: turn,
          tool_name: call.name,
          input_hash: blockInputHash,
          result_bytes: approximateBytes(resultText),
          latency_ms: Date.now() - turnStartedAt,
          stop_reason: response.choices[0]?.finish_reason ?? 'unknown',
          ...(isError ? { is_error: true } : {}),
          ...(isCacheHit ? { cache_hit: true } : {}),
        });
        this.logTurn({
          turn,
          finish_reason: response.choices[0]?.finish_reason ?? null,
          tool_name: call.name,
          tool_input: call.input,
          tool_result_excerpt: resultExcerpt,
          usage: response.usage,
          is_terminal: false,
        });
      }
    }

    // Turn cap exhausted without emit_finding.
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
  // jest.mock() on the `openai` module.
  protected createClient(): OpenAIClientLike {
    return new OpenAI({
      apiKey: this.config.openrouterApiKey,
      baseURL: this.config.openrouterBaseUrl,
      maxRetries: SDK_MAX_RETRIES,
    }) as unknown as OpenAIClientLike;
  }

  private resolveClient(): OpenAIClientLike {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  private async runToolCall(
    call: { name: string; id: string; input: unknown },
    repoContext: IRepoContextProvider | undefined,
  ): Promise<{ text: string; is_error?: boolean }> {
    if (!repoContext) {
      return {
        text: 'tool unavailable: no repo context configured',
        is_error: true,
      };
    }
    try {
      switch (call.name) {
        case FETCH_FILE_TOOL_NAME: {
          const input = call.input as { path?: unknown };
          if (typeof input.path !== 'string' || input.path.length === 0) {
            return { text: 'invalid_input: `path` expected string', is_error: true };
          }
          const result = await repoContext.fetchFile(input.path);
          if (!result.ok) {
            return {
              text: formatProviderError(result.reason, result.message),
              is_error: true,
            };
          }
          return { text: `# ${result.path}\n\n${result.content}` };
        }
        case FETCH_FUNCTION_TOOL_NAME: {
          const input = call.input as { name?: unknown; file?: unknown };
          if (typeof input.name !== 'string' || input.name.length === 0) {
            return { text: 'invalid_input: `name` expected string', is_error: true };
          }
          if (input.file !== undefined && typeof input.file !== 'string') {
            return { text: 'invalid_input: `file` expected string', is_error: true };
          }
          const result = await repoContext.fetchFunctionDefinition(
            input.name,
            input.file,
          );
          if (!result.ok) {
            return {
              text: formatProviderError(result.reason, result.message),
              is_error: true,
            };
          }
          return {
            text: `# ${result.path} (lines ${result.startLine}-${result.endLine})\n\n${result.content}`,
          };
        }
        case FETCH_PRIOR_REVIEW_TOOL_NAME: {
          const input = call.input as {
            pr_node_id?: unknown;
            file_path?: unknown;
            rule_id?: unknown;
          };
          const query: Parameters<IRepoContextProvider['fetchPriorReview']>[0] = {};
          if (input.pr_node_id !== undefined) {
            if (typeof input.pr_node_id !== 'string') {
              return {
                text: 'invalid_input: `pr_node_id` expected string',
                is_error: true,
              };
            }
            query.pr_node_id = input.pr_node_id;
          }
          if (input.file_path !== undefined) {
            if (typeof input.file_path !== 'string') {
              return {
                text: 'invalid_input: `file_path` expected string',
                is_error: true,
              };
            }
            query.file_path = input.file_path;
          }
          if (input.rule_id !== undefined) {
            if (typeof input.rule_id !== 'string') {
              return {
                text: 'invalid_input: `rule_id` expected string',
                is_error: true,
              };
            }
            query.rule_id = input.rule_id;
          }
          const result = await repoContext.fetchPriorReview(query);
          if (!result.ok) {
            return {
              text: formatProviderError(result.reason, result.message),
              is_error: true,
            };
          }
          return { text: JSON.stringify(result.content) };
        }
        default:
          return { text: `unknown_tool: ${call.name}`, is_error: true };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { text: `tool_invocation_error: ${msg}`, is_error: true };
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
    finish_reason: string | null;
    tool_name: string;
    tool_input: unknown;
    tool_result_excerpt?: string;
    usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    is_terminal: boolean;
  }): void {
    const baseFields = {
      turn_idx: args.turn,
      finish_reason: args.finish_reason,
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

  private logTurnVerbose(args: {
    turn: number;
    request: { model: string; message_count: number; tool_count: number };
    response: {
      finish_reason: string | null | undefined;
      tool_call_count: number;
      content_excerpt: string | null;
      usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    };
  }): void {
    if (!this.config.llmSpikeVerbose) return;
    this.logger.debug(
      `spike-turn: ${JSON.stringify({
        turn: args.turn,
        request: args.request,
        response: args.response,
      })}`,
    );
  }

  private wrapSdkError(err: unknown): AnthropicRequestError {
    if (err instanceof APIError) {
      const status = err.status ?? 0;
      const body = (err as unknown as { error?: { error?: { type?: string; message?: string } } })
        .error;
      const rawErrorCode = body?.error?.type;
      const serverMessage = body?.error?.message
        ? truncateForLog(body.error.message)
        : undefined;
      const baseMsg = `OpenAI-compatible API error: HTTP ${status}${rawErrorCode ? ` (${rawErrorCode})` : ''}`;
      const fullMsg = serverMessage ? `${baseMsg} — ${serverMessage}` : baseMsg;
      return new AnthropicRequestError(fullMsg, {
        status,
        errorCode: rawErrorCode,
        serverMessage,
        retryAfterMs: parseOpenAIRetryAfterMs(err),
        cause: err,
      });
    }
    return new AnthropicRequestError(
      'OpenAI-compatible request failed (network or transport error)',
      { status: 0, cause: err },
    );
  }
}

// Parse the `retry-after` header off an OpenAI APIError so the
// BullMQ backoffStrategy can honour it. Like Anthropic's, retry-after
// is delta seconds; clamp invalid values to undefined.
function parseOpenAIRetryAfterMs(err: APIError): number | undefined {
  const headers = (err as unknown as { headers?: unknown }).headers;
  if (!headers) return undefined;
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

// === Module-scope helpers (mirror the Anthropic reviewer; deferred
// to a shared helpers file in the full migration) ===

function buildUserMessage(input: AnalyzeDiffInput): string {
  const rulesBlock = input.rules
    .map((r) => `## ${r.rule_id} (${r.source})\n${r.document}`)
    .join('\n\n');
  return `<retrieved_rules>\n${rulesBlock}\n</retrieved_rules>\n<diff>\n${input.diff}\n</diff>`;
}

function parseEmitFindings(input: unknown): Finding[] | null {
  if (typeof input !== 'object' || input === null) return null;
  let findings = (input as { findings?: unknown }).findings;
  // Lenient parse for the observed OSS deviation where the model
  // wraps the array literal as a JSON-encoded string (`{"findings":
  // "[]"}` instead of `{"findings": []}`). Qwen3-Coder produced this
  // on PR #17 during the spike — the intent was "no findings"; the
  // wire shape was wrong. Strict providers (Anthropic) never trigger
  // this branch. Strict for non-string non-array inputs.
  if (typeof findings === 'string') {
    try {
      findings = JSON.parse(findings);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(findings)) return null;
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
  resp:
    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    | undefined,
): void {
  if (!resp) return;
  acc.input_tokens += resp.prompt_tokens ?? 0;
  acc.output_tokens += resp.completion_tokens ?? 0;
  // OpenAI-compatible providers don't expose Anthropic-style explicit
  // cache fields. Leaving these null is consistent with "no cache
  // metric" — the dashboard's existing nullable handling renders this
  // as "—" rather than misleading zero.
}

function hashToolInput(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input ?? {}))
    .digest('hex')
    .slice(0, 16);
}

// Prefix a steering hint onto a replayed cached tool result. Same
// intent as the Anthropic reviewer's `replayWithDedupHint` — tell the
// model this request is a duplicate of an earlier turn so it stops
// re-fetching the same artifact. OpenAI's tool message carries a
// single string body (not content blocks), so we concatenate.
function replayWithDedupHint(cached: string, cachedAtTurn: number): string {
  const hint =
    `[Note: an identical request was already served on turn ${cachedAtTurn}; ` +
    `cached content follows. If you have enough context, call \`emit_finding\` ` +
    `(or finish the review) instead of fetching the same artifact again.]\n\n`;
  return hint + cached;
}

function approximateBytes(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8');
  if (Array.isArray(payload)) {
    return payload.reduce<number>((sum, p) => sum + approximateBytes(p), 0);
  }
  if (typeof payload === 'object') {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  }
  return 0;
}

function excerptString(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function formatProviderError(
  reason: RepoContextErrorReason,
  message: string,
): string {
  return `${reason}: ${message}`;
}

function sanitizeSlug(value: unknown): string {
  if (typeof value !== 'string') return '<non-string>';
  return value.replace(/[\r\n]+/g, ' ').slice(0, 80);
}

function truncateForLog(s: string): string {
  const normalized = s.replace(/[\r\n]+/g, ' ').trim();
  return normalized.length > 500 ? normalized.slice(0, 500) + '…' : normalized;
}

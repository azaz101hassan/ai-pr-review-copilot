import { Injectable, Logger } from '@nestjs/common';
import OpenAI, { APIError } from 'openai';
import { ConfigService } from '@/config';
import {
  AnalyzeDiffInput,
  AnalyzeDiffResult,
  Finding,
  ILlmReviewer,
  PROMPT_AND_TOOL_VERSION,
  UsageStats,
} from '@/modules/reviews/types/llm-reviewer';
import { ToolCallRecord } from '@/modules/reviews/types/review.types';
import {
  approximateBytes,
  buildDedupHintText,
  buildSystemPrompt,
  buildUserMessage,
  DEFAULT_TURN_CAP,
  EMIT_FINDING_TOOL_NAME,
  excerptString,
  filterHallucinatedFindings,
  hashToolInput,
  LlmRequestError,
  MAX_TOKENS_PER_TURN,
  parseEmitFindings,
  parseRetryAfterMs,
  PER_REQUEST_TIMEOUT_MS,
  REGISTERED_TOOLS,
  runToolCall,
  SDK_MAX_RETRIES,
  summarizeEmitInput,
  SYSTEM_PROMPT,
  truncateForLog,
} from '@/infrastructure/llm';

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

type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

// Re-shape an Anthropic-style tool definition into OpenAI function-call
// shape. Pure rename — `input_schema` → `parameters`, wrap in
// `{type: 'function', function: {...}}`. The snapshot-hash invariant
// pins the canonical schema bytes; this adapter never mutates them.
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
export class OpenRouterLlmReviewer implements ILlmReviewer {
  private readonly logger = new Logger(OpenRouterLlmReviewer.name);

  private client: OpenAIClientLike | undefined;

  constructor(private readonly config: ConfigService) {}

  async analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    const client = this.resolveClient();
    const model = this.config.openrouterModel;
    const turnCap = this.config.agentTurnCap;
    const systemPrompt =
      turnCap === DEFAULT_TURN_CAP ? SYSTEM_PROMPT : buildSystemPrompt(turnCap);

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

    const toolResultCache = new Map<string, { turn: number; content: string }>();

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
            // — force at least one tool call per turn.
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
        throw new LlmRequestError(
          'OpenRouter response had no choices[0].message',
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

      // A malformed arguments JSON counts as a parse failure — logged
      // but not raised. Model is free to mix [emit_finding, fetch_*] in
      // one turn; emit wins and the non-terminal calls are skipped.
      const parsedCalls: Array<{ id: string; name: string; input: unknown }> = [];
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

      const emitCall = parsedCalls.find((c) => c.name === EMIT_FINDING_TOOL_NAME);
      const nonTerminalCalls = parsedCalls.filter(
        (c) => c.name !== EMIT_FINDING_TOOL_NAME,
      );

      if (emitCall) {
        // Lenient parse covers the observed OSS deviation where the
        // model wraps the array literal as a JSON-encoded string
        // (`{"findings": "[]"}` instead of `{"findings": []}`). Qwen3-Coder
        // produced this on PR #17 during the spike. Strict providers
        // never trigger the branch.
        const findings = parseEmitFindings(emitCall.input, { lenient: true });
        if (!findings) {
          if (this.config.llmSpikeVerbose) {
            this.logger.warn(
              `emit_finding raw payload (validation FAILED): ${truncateForLog(
                JSON.stringify(emitCall.input).slice(0, 2048),
              )}`,
            );
          }
          throw new LlmRequestError(
            'emit_finding payload failed schema validation',
            {
              status: 200,
              errorCode: 'malformed_emit_finding',
              turnCount: turn,
              toolCalls,
            },
          );
        }
        emittedFindings = filterHallucinatedFindings(
          findings,
          input.rules,
          inputRuleKeys,
          this.logger,
        );
        hallucinatedFindingCount = findings.length - emittedFindings.length;
        const toolInputHash = hashToolInput(emitCall.input);
        toolCalls.push({
          turn_idx: turn,
          tool_name: EMIT_FINDING_TOOL_NAME,
          input_hash: toolInputHash,
          result_bytes: approximateBytes(emitCall.input),
          latency_ms: Date.now() - turnStartedAt,
          stop_reason: response.choices[0]?.finish_reason ?? 'unknown',
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

      if (rawToolCalls.length === 0) {
        throw new LlmRequestError(
          'OpenRouter response had no tool_calls (tool_choice="required" requires one)',
          { status: 200, errorCode: 'unexpected_response_shape' },
        );
      }
      if (parseFailures > 0) {
        // ANY parse failure is terminal for the turn. If we kept going,
        // the assistant message would carry tool_call_ids we never
        // responded to with a role:'tool' message, and the next request
        // would fail with "missing tool_result for tool_call_id X".
        throw new LlmRequestError(
          `${parseFailures} tool_call(s) had unparseable arguments`,
          { status: 200, errorCode: 'unexpected_response_shape' },
        );
      }

      // OpenAI requires the assistant turn carrying tool_calls to
      // appear before the matching role:tool messages, with every
      // tool_call_id covered.
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
          resultText = buildDedupHintText(cached.turn) + cached.content;
          isError = false;
          isCacheHit = true;
          cacheHitCount += 1;
        } else {
          const result = await runToolCall(call, input.repoContext);
          resultText = result.text;
          isError = !result.ok;
          if (!isError) {
            toolResultCache.set(cacheKey, { turn, content: result.text });
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          // OpenAI's tool result content is a single string; prefix the
          // is_error marker inline since the schema carries no typed
          // error flag.
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
          tool_result_excerpt: excerptString(resultText),
          usage: response.usage,
          is_terminal: false,
        });
      }
    }

    throw new LlmRequestError(
      `Agent loop exceeded ${turnCap} turns without ${EMIT_FINDING_TOOL_NAME}`,
      {
        status: 200,
        errorCode: 'turn_cap_exceeded',
        turnCount: turnCap,
        toolCalls,
      },
    );
  }

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
      // Terminal turns carry the full emit_finding payload as tool_input —
      // dumping that into logs would echo private code excerpts (rule
      // messages, citations). Log a hash + findings count instead.
      this.logger.log(
        `agent-turn: ${JSON.stringify({
          ...baseFields,
          ...summarizeEmitInput(args.tool_input),
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

  private wrapSdkError(err: unknown): LlmRequestError {
    if (err instanceof APIError) {
      const status = err.status ?? 0;
      const body = (err as unknown as {
        error?: { error?: { type?: string; message?: string } };
      }).error;
      const rawErrorCode = body?.error?.type;
      const serverMessage = body?.error?.message
        ? truncateForLog(body.error.message)
        : undefined;
      const baseMsg = `OpenRouter API error: HTTP ${status}${rawErrorCode ? ` (${rawErrorCode})` : ''}`;
      const fullMsg = serverMessage ? `${baseMsg} — ${serverMessage}` : baseMsg;
      const headers = (err as unknown as { headers?: unknown }).headers;
      return new LlmRequestError(fullMsg, {
        status,
        errorCode: rawErrorCode,
        serverMessage,
        retryAfterMs: parseRetryAfterMs(headers),
        cause: err,
      });
    }
    return new LlmRequestError(
      'OpenRouter request failed (network or transport error)',
      { status: 0, cause: err },
    );
  }
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
  // OpenRouter responses have no Anthropic-style cache fields; leaving
  // them null is consistent with "no cache metric" and the dashboard
  // renders that as "—" rather than a misleading zero.
}

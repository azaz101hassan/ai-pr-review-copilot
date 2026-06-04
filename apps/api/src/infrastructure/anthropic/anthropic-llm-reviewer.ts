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
import type { PriorReviewEntry } from '@/modules/reviews/types/repo-context-provider';
import { ToolCallRecord } from '@/modules/reviews/types/review.types';
import {
  approximateBytes,
  buildDedupHintText,
  buildSystemPrompt,
  buildUserMessage,
  DEFAULT_TURN_CAP,
  EMIT_FINDING_TOOL_NAME,
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
  SYSTEM_PROMPT,
  truncateForLog,
} from '@/infrastructure/llm';

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

type AnthropicTextBlock = { type: 'text'; text: string };
type ToolUseBlock = { name: string; id: string; input: unknown };

@Injectable()
export class AnthropicLlmReviewer implements ILlmReviewer {
  private readonly logger = new Logger(AnthropicLlmReviewer.name);

  private client: AnthropicClientLike | undefined;

  constructor(private readonly config: ConfigService) {}

  async analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    const client = this.resolveClient();
    const model = this.config.anthropicModel;
    const turnCap = this.config.agentTurnCap;
    const systemPrompt =
      turnCap === DEFAULT_TURN_CAP ? SYSTEM_PROMPT : buildSystemPrompt(turnCap);

    const inputRuleKeys = new Set(
      input.rules.map((r) => `${r.source}:${r.rule_id}`),
    );

    const userMessage = buildUserMessage(input);

    // BP3 (3rd cache breakpoint) attaches to the diff + rules block —
    // the largest static prefix that survives across all turns. BP1
    // (end of tools) and BP2 (end of system) are set at request build.
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
    let cacheHitCount = 0;
    let hallucinatedFindingCount = 0;

    const toolResultCache = new Map<
      string,
      { turn: number; content: AnthropicTextBlock[] }
    >();

    for (let turn = 1; turn <= turnCap; turn++) {
      const turnStartedAt = Date.now();
      let response: Awaited<ReturnType<AnthropicClientLike['messages']['create']>>;
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
            // BP1 — last registered tool carries cache_control so the
            // Anthropic API caches everything up to and including it.
            tools: REGISTERED_TOOLS.map((tool, idx) =>
              idx === REGISTERED_TOOLS.length - 1
                ? { ...tool, cache_control: { type: 'ephemeral' } }
                : tool,
            ),
            tool_choice: { type: 'any' },
            messages,
          },
          // Per-request timeout must live in RequestOptions (2nd arg),
          // not the body — Anthropic rejects unknown body keys with 400.
          { timeout: PER_REQUEST_TIMEOUT_MS },
        );
      } catch (err) {
        throw this.wrapSdkError(err);
      }

      lastModel = response.model;
      accumulateUsage(cumulativeUsage, response.usage);

      // Same-turn mix of [fetch_*, emit_finding] exits via emit_finding
      // without invoking the non-terminal tools — otherwise we'd orphan
      // tool_result blocks Claude never sees.
      const emitBlock = findToolUseBlock(response.content, EMIT_FINDING_TOOL_NAME);
      const nonTerminalCalls = collectToolUseBlocks(response.content).filter(
        (b) => b.name !== EMIT_FINDING_TOOL_NAME,
      );

      if (emitBlock) {
        const findings = parseEmitFindings(emitBlock.input);
        if (!findings) {
          throw new LlmRequestError('emit_finding payload failed schema validation', {
            status: 200,
            errorCode: 'malformed_emit_finding',
            turnCount: turn,
            toolCalls,
          });
        }
        emittedFindings = filterHallucinatedFindings(
          findings,
          input.rules,
          inputRuleKeys,
          this.logger,
        );
        hallucinatedFindingCount = findings.length - emittedFindings.length;
        const toolInputHash = hashToolInput(emitBlock.input);
        toolCalls.push({
          turn_idx: turn,
          tool_name: EMIT_FINDING_TOOL_NAME,
          input_hash: toolInputHash,
          result_bytes: approximateBytes(emitBlock.input),
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

      if (nonTerminalCalls.length === 0) {
        throw new LlmRequestError(
          'Anthropic response did not contain any tool_use block (tool_choice="any" requires one)',
          { status: 200, errorCode: 'unexpected_response_shape' },
        );
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResultBlocks: unknown[] = [];
      for (const block of nonTerminalCalls) {
        const blockInputHash = hashToolInput(block.input);
        const cacheKey = `${block.name}:${blockInputHash}`;
        const cached = toolResultCache.get(cacheKey);

        let content: AnthropicTextBlock[];
        let isError: boolean;
        let isCacheHit = false;
        if (cached) {
          content = wrapWithDedupHint(cached.content, cached.turn);
          isError = false;
          isCacheHit = true;
          cacheHitCount += 1;
        } else {
          const result = await runToolCall(block, input.repoContext);
          content = [{ type: 'text', text: result.text }];
          isError = !result.ok;
          if (!isError) {
            toolResultCache.set(cacheKey, { turn, content });
          }
        }

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: isError,
          content,
        });
        toolCalls.push({
          turn_idx: turn,
          tool_name: block.name,
          input_hash: blockInputHash,
          result_bytes: approximateBytes(content),
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
          tool_result_excerpt: excerptTextBlock(content),
          usage: response.usage,
          is_terminal: false,
        });
      }
      messages.push({ role: 'user', content: toolResultBlocks });
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

  // Test seam — overridden in spec to substitute a mock client without
  // jest.mock() on the @anthropic-ai/sdk module.
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

  private logTurn(args: {
    turn: number;
    stop_reason: string | null;
    tool_name: string;
    tool_input: unknown;
    tool_result_excerpt?: string;
    usage: { input_tokens: number; output_tokens: number };
    is_terminal: boolean;
  }): void {
    const baseFields = {
      turn_idx: args.turn,
      stop_reason: args.stop_reason,
      tool_name: args.tool_name,
      usage: args.usage,
    };
    if (args.is_terminal) {
      this.logger.log(
        `agent-turn: ${JSON.stringify({ ...baseFields, tool_input: args.tool_input })}`,
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

  private wrapSdkError(err: unknown): LlmRequestError {
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
      const headers = (err as unknown as { headers?: unknown }).headers;
      return new LlmRequestError(fullMsg, {
        status,
        errorCode,
        serverMessage,
        retryAfterMs: parseRetryAfterMs(headers),
        cause: err,
      });
    }
    return new LlmRequestError('Anthropic request failed (network or transport error)', {
      status: 0,
      cause: err,
    });
  }
}

function findToolUseBlock(content: unknown[], toolName: string): ToolUseBlock | undefined {
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string; input?: unknown };
    if (b.type === 'tool_use' && b.name === toolName) {
      return { name: b.name, id: b.id ?? '', input: b.input };
    }
  }
  return undefined;
}

function collectToolUseBlocks(content: unknown[]): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string; input?: unknown };
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      out.push({ name: b.name, id: b.id ?? '', input: b.input });
    }
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
    (acc.cache_creation_input_tokens ?? 0) + (resp.cache_creation_input_tokens ?? 0);
  acc.cache_read_input_tokens =
    (acc.cache_read_input_tokens ?? 0) + (resp.cache_read_input_tokens ?? 0);
}

function wrapWithDedupHint(
  cached: AnthropicTextBlock[],
  cachedAtTurn: number,
): AnthropicTextBlock[] {
  const hint = buildDedupHintText(cachedAtTurn);
  if (cached.length === 0) {
    return [{ type: 'text', text: hint.trimEnd() }];
  }
  const [head, ...rest] = cached;
  return [{ type: 'text', text: hint + head.text }, ...rest];
}

function excerptTextBlock(content: AnthropicTextBlock[]): string {
  const first = content[0];
  if (!first || typeof first.text !== 'string') return '';
  return first.text.length > 200 ? first.text.slice(0, 200) + '…' : first.text;
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

export type { PriorReviewEntry };

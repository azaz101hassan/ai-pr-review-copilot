// apps/api/src/infrastructure/llm/openrouter-faithfulness-judge.ts
import type OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { Logger } from '@nestjs/common';
import type {
  IFaithfulnessJudge,
  FaithfulnessJudgeInput,
} from '@/modules/reviews/eval/faithfulness-judge.contract';
import type { FaithfulnessResult } from '@/modules/reviews/eval/recording';
import {
  buildJudgeUserMessage,
  parseJudgeClaims,
  computeResult,
  FaithfulnessJudgeError,
  FAITHFULNESS_TOOL_NAME,
  JUDGE_MAX_TOKENS,
} from '@/modules/reviews/eval/faithfulness-judge';
import {
  JUDGE_SYSTEM_PROMPT,
  FAITHFULNESS_VERDICT_TOOL,
} from '@/modules/reviews/eval/faithfulness-judge.prompt';

export interface OpenRouterFaithfulnessJudgeOptions {
  /**
   * Judge model id. Required — there's no provider-neutral default
   * since OpenRouter routes by model id. Operators typically set this
   * to the same model id used by the reviewer so the eval cost matches
   * production behaviour.
   */
  model: string;
}

/**
 * OpenRouter-flavoured faithfulness judge. Same prompt + tool schema
 * as the Anthropic adapter; the OpenAI Chat Completions tool-call
 * payload shape differs (function.arguments is a JSON string instead
 * of a typed `input` object), so the parse step deserializes before
 * handing off to the shared `parseJudgeClaims` helper.
 */
export class OpenRouterFaithfulnessJudge implements IFaithfulnessJudge {
  private readonly logger = new Logger(OpenRouterFaithfulnessJudge.name);
  readonly model: string;

  constructor(
    private readonly client: OpenAI,
    options: OpenRouterFaithfulnessJudgeOptions,
  ) {
    this.model = options.model;
  }

  async judge(input: FaithfulnessJudgeInput): Promise<FaithfulnessResult> {
    const userMessage = buildJudgeUserMessage(
      input.finding,
      input.ruleDocText,
      input.diff,
    );

    let response: ChatCompletion;
    try {
      response = (await this.client.chat.completions.create({
        model: this.model,
        max_tokens: JUDGE_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: FAITHFULNESS_VERDICT_TOOL.name,
              description: FAITHFULNESS_VERDICT_TOOL.description,
              parameters: FAITHFULNESS_VERDICT_TOOL.input_schema as Record<
                string,
                unknown
              >,
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: FAITHFULNESS_TOOL_NAME },
        },
      })) as ChatCompletion;
    } catch (err) {
      this.logger.warn(
        `judge.sdk-error finding="${input.finding.rule_id}" ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    const toolCall = extractFaithfulnessToolCall(response);
    if (!toolCall) {
      throw new FaithfulnessJudgeError(
        `OpenRouter judge response did not contain a ${FAITHFULNESS_TOOL_NAME} tool_call`,
      );
    }

    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(toolCall.arguments);
    } catch (err) {
      throw new FaithfulnessJudgeError(
        `OpenRouter judge tool_call arguments did not parse as JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const claims = parseJudgeClaims(parsedInput);
    return computeResult(claims);
  }
}

function extractFaithfulnessToolCall(
  response: ChatCompletion,
): { arguments: string } | null {
  const calls = response.choices[0]?.message?.tool_calls ?? [];
  for (const call of calls) {
    if (call.type !== 'function') continue;
    if (call.function?.name !== FAITHFULNESS_TOOL_NAME) continue;
    if (typeof call.function?.arguments !== 'string') continue;
    return { arguments: call.function.arguments };
  }
  return null;
}

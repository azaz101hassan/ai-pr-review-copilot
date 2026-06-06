// apps/api/src/infrastructure/llm/anthropic-faithfulness-judge.ts
import type Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import type {
  IFaithfulnessJudge,
  FaithfulnessJudgeInput,
} from '@/modules/reviews/eval/faithfulness-judge.contract';
import type { FaithfulnessResult } from '@/modules/reviews/eval/recording';
import {
  judgeFinding,
  DEFAULT_JUDGE_MODEL,
} from '@/modules/reviews/eval/faithfulness-judge';

export interface AnthropicFaithfulnessJudgeOptions {
  /** Judge model id. Defaults to claude-haiku-4-5-20251001. */
  model?: string;
}

/**
 * Anthropic-flavoured faithfulness judge. Delegates to `judgeFinding`
 * (the existing Anthropic call shape) — kept thin so the Anthropic
 * branch stays comparable to the OpenRouter branch.
 */
export class AnthropicFaithfulnessJudge implements IFaithfulnessJudge {
  private readonly logger = new Logger(AnthropicFaithfulnessJudge.name);
  readonly model: string;

  constructor(
    private readonly client: Anthropic,
    options: AnthropicFaithfulnessJudgeOptions = {},
  ) {
    this.model = options.model ?? DEFAULT_JUDGE_MODEL;
  }

  async judge(input: FaithfulnessJudgeInput): Promise<FaithfulnessResult> {
    try {
      return await judgeFinding({
        finding: input.finding,
        ruleDocText: input.ruleDocText,
        diff: input.diff,
        client: this.client,
        model: this.model,
      });
    } catch (err) {
      this.logger.warn(
        `judge.failed finding="${input.finding.rule_id}" ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}

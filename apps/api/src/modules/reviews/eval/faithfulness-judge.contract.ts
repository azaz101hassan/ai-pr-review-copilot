/**
 * Provider-agnostic faithfulness-judge contract.
 *
 * The judge is the eval harness's "did the reviewer ground its claims in
 * the cited rule + diff" pass. One call per finding, structured tool-use
 * output, deterministic temperature 0. The reviewer surface and the judge
 * surface follow the same active provider — both swap together when
 * `LLM_PROVIDER` flips — so a capture run under OpenRouter judges with
 * OpenRouter, and a capture run under Anthropic judges with Anthropic.
 *
 * Implementations live in `apps/api/src/infrastructure/llm/` next to the
 * reviewer + summarizer implementations and bind the `FAITHFULNESS_JUDGE`
 * token from each provider's NestJS module.
 */

import type { FaithfulnessResult } from './recording';

export const FAITHFULNESS_JUDGE = Symbol('FaithfulnessJudge');

/** Minimal finding shape the judge needs. */
export interface JudgeFindingInput {
  rule_id: string;
  title: string;
  message: string;
  location_hint?: string | null;
  citation?: string | null;
}

export interface FaithfulnessJudgeInput {
  finding: JudgeFindingInput;
  ruleDocText: string;
  diff: string;
}

export interface IFaithfulnessJudge {
  /**
   * Judge a single finding's faithfulness via claim decomposition.
   * Throws on malformed/unparseable judge responses (e.g. tool-use block
   * missing) — never returns a silent default score.
   */
  judge(input: FaithfulnessJudgeInput): Promise<FaithfulnessResult>;

  /**
   * The judge model id used for this run. Stamped into recording
   * provenance so analysis can correlate scores with the model that
   * produced them.
   */
  readonly model: string;
}

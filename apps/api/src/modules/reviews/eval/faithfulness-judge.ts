/**
 * Claim-decomposition faithfulness judge — Anthropic call shape +
 * cross-provider helpers.
 *
 * A single LLM call per finding via structured tool-use. Decomposes
 * the finding's title/message into atomic self-contained claims, and
 * for each claim emits a { claim, reason, verdict } entry.
 *
 * Score = supported / total. `unclear` counts as `not_supported`
 * (conservative — unverifiable = ungrounded). Zero claims → score
 * is null (not silently 0 or 1).
 *
 * This file keeps the Anthropic-specific `judgeFinding(client, ...)`
 * for back-compat with the focused unit spec, plus the cross-provider
 * pure helpers (`buildJudgeUserMessage`, `parseJudgeClaims`,
 * `computeResult`, `FAITHFULNESS_TOOL_NAME`, `JUDGE_MAX_TOKENS`,
 * `DEFAULT_JUDGE_MODEL`). The two provider adapters in
 * `infrastructure/llm/{anthropic,openrouter}-faithfulness-judge.ts`
 * implement the `IFaithfulnessJudge` contract on top of those helpers.
 */

import type { FaithfulnessResult, FaithfulnessClaim, FaithfulnessVerdict } from './recording';
import type { JudgeFindingInput } from './faithfulness-judge.contract';
import {
  JUDGE_SYSTEM_PROMPT,
  FAITHFULNESS_VERDICT_TOOL,
} from './faithfulness-judge.prompt';

// ── Types ──────────────────────────────────────────────────────────────

/** Loose alias for the subset of the Anthropic client surface the judge uses. */
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

export interface JudgeCallArgs {
  finding: JudgeFindingInput;
  ruleDocText: string;
  diff: string;
  client: AnthropicClientLike;
  /** Override the judge model (default: claude-haiku-4-5-20251001). */
  model?: string;
}

// ── Constants ──────────────────────────────────────────────────────────

export const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';
export const JUDGE_MAX_TOKENS = 4096;
export const FAITHFULNESS_TOOL_NAME = 'faithfulness_verdict';
const VALID_VERDICTS = new Set<FaithfulnessVerdict>([
  'supported',
  'not_supported',
  'unclear',
]);

// Re-export the canonical finding-input shape so consumers can import
// either from the contract or from this file — both are stable.
export type { JudgeFindingInput };

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Judge a single finding's faithfulness via claim decomposition.
 *
 * Anthropic-shaped call; the OpenRouter adapter has its own implementation
 * in `infrastructure/llm/openrouter-faithfulness-judge.ts`. Makes one
 * Haiku call with temperature 0. Returns the score and per-claim
 * verdicts. Throws on malformed/unparseable judge responses — never
 * returns a silent default score.
 */
export async function judgeFinding(args: JudgeCallArgs): Promise<FaithfulnessResult> {
  const { finding, ruleDocText, diff, client, model } = args;
  const judgeModel = model ?? DEFAULT_JUDGE_MODEL;

  const userMessage = buildJudgeUserMessage(finding, ruleDocText, diff);

  const response = await client.messages.create(
    {
      model: judgeModel,
      max_tokens: JUDGE_MAX_TOKENS,
      temperature: 0,
      system: JUDGE_SYSTEM_PROMPT,
      tools: [FAITHFULNESS_VERDICT_TOOL],
      tool_choice: { type: 'tool', name: FAITHFULNESS_TOOL_NAME },
      messages: [{ role: 'user', content: userMessage }],
    },
  );

  const toolBlock = findToolUseBlock(response.content, FAITHFULNESS_TOOL_NAME);
  if (!toolBlock) {
    throw new FaithfulnessJudgeError(
      `Faithfulness judge response did not contain a ${FAITHFULNESS_TOOL_NAME} tool_use block`,
    );
  }

  const claims = parseJudgeClaims(toolBlock.input);
  return computeResult(claims);
}

// ── Cross-provider helpers (exported) ─────────────────────────────────

export function buildJudgeUserMessage(
  finding: JudgeFindingInput,
  ruleDocText: string,
  diff: string,
): string {
  const findingParts = [
    `Title: ${finding.title}`,
    `Message: ${finding.message}`,
  ];
  if (finding.location_hint) {
    findingParts.push(`Location hint: ${finding.location_hint}`);
  }
  if (finding.citation) {
    findingParts.push(`Citation: ${finding.citation}`);
  }

  return [
    '<finding>',
    findingParts.join('\n'),
    '</finding>',
    '',
    '<rule_document>',
    ruleDocText,
    '</rule_document>',
    '',
    '<diff>',
    diff,
    '</diff>',
  ].join('\n');
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

export function parseJudgeClaims(input: unknown): FaithfulnessClaim[] {
  if (typeof input !== 'object' || input === null) {
    throw new FaithfulnessJudgeError(
      'Faithfulness judge tool input is not an object',
    );
  }

  const obj = input as { claims?: unknown };
  if (!Array.isArray(obj.claims)) {
    throw new FaithfulnessJudgeError(
      'Faithfulness judge tool input is missing the `claims` array',
    );
  }

  const claims: FaithfulnessClaim[] = [];
  for (let i = 0; i < obj.claims.length; i++) {
    const raw = obj.claims[i];
    if (typeof raw !== 'object' || raw === null) {
      throw new FaithfulnessJudgeError(
        `Faithfulness judge claim at index ${i} is not an object`,
      );
    }

    const entry = raw as Record<string, unknown>;

    if (typeof entry.claim !== 'string' || entry.claim.length === 0) {
      throw new FaithfulnessJudgeError(
        `Faithfulness judge claim at index ${i} has invalid or missing \`claim\` field`,
      );
    }

    if (typeof entry.reason !== 'string' || entry.reason.length === 0) {
      throw new FaithfulnessJudgeError(
        `Faithfulness judge claim at index ${i} has invalid or missing \`reason\` field`,
      );
    }

    if (
      typeof entry.verdict !== 'string' ||
      !VALID_VERDICTS.has(entry.verdict as FaithfulnessVerdict)
    ) {
      throw new FaithfulnessJudgeError(
        `Faithfulness judge claim at index ${i} has invalid verdict: ${JSON.stringify(entry.verdict)}`,
      );
    }

    claims.push({
      claim: entry.claim,
      kind: '', // claim-kind tagging deferred
      reason: entry.reason,
      verdict: entry.verdict as FaithfulnessVerdict,
    });
  }

  return claims;
}

export function computeResult(claims: FaithfulnessClaim[]): FaithfulnessResult {
  if (claims.length === 0) {
    return { score: null, claims };
  }

  const supported = claims.filter((c) => c.verdict === 'supported').length;
  const score = supported / claims.length;

  return { score, claims };
}

// ── Error class ────────────────────────────────────────────────────────

export class FaithfulnessJudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaithfulnessJudgeError';
  }
}

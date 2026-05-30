/**
 * Faithfulness judge prompt + version discipline.
 *
 * Mirrors the `PROMPT_AND_TOOL_VERSION` + `computePromptToolHash()`
 * pattern from `infrastructure/anthropic/anthropic-llm-reviewer.ts`.
 *
 * IF YOU EDIT THE PROMPT OR TOOL SCHEMA YOU MUST:
 *   1. Bump `FAITHFULNESS_JUDGE_VERSION`.
 *   2. Add a new entry to `FAITHFULNESS_JUDGE_PROMPT_HASH_MAP` with
 *      the new sha256 (copy the hash from the snapshot spec's failure
 *      message).
 *   Both changes must land in the SAME commit. Recordings produced
 *   under the old version are stale and must be re-captured.
 */

import { createHash } from 'node:crypto';

// ── Version constant ───────────────────────────────────────────────────

export const FAITHFULNESS_JUDGE_VERSION = 'v1' as const;

// ── System prompt ──────────────────────────────────────────────────────

export const JUDGE_SYSTEM_PROMPT = [
  'You are a faithfulness evaluator for an automated code-review system.',
  'Your job is to determine whether each atomic claim in a review finding',
  'is supported by the evidence provided (the cited rule document and the PR diff).',
  '',
  'You will be given:',
  '  1. A review finding (title + message, and optionally location_hint + citation).',
  '  2. The full text of the cited rule from the knowledge base.',
  '  3. The PR diff that was reviewed.',
  '',
  'Your task:',
  '  1. Decompose the finding\'s title and message into atomic, self-contained claims.',
  '     Each claim must be a single, independently verifiable statement.',
  '     Replace all pronouns and references with their concrete referents',
  '     so each claim stands alone without needing the original context.',
  '     Do NOT decompose the finding\'s location_hint or citation — only title and message.',
  '',
  '  2. For each claim, determine whether it is SUPPORTED by the evidence',
  '     (the rule document text AND/OR the PR diff). A claim is:',
  '       - "supported": directly inferable from the rule document and/or the diff.',
  '       - "not_supported": contradicted by or not inferable from the evidence.',
  '       - "unclear": the evidence is ambiguous or insufficient to determine support.',
  '',
  '  3. For each claim, provide your REASON first (the evidence or lack thereof),',
  '     then your VERDICT. Reason-before-verdict is mandatory.',
  '',
  'Constraints:',
  '  - Be conservative: a claim must be directly and clearly supported by the',
  '    evidence to receive a "supported" verdict. Do not assume implicit support.',
  '  - Claims that merely restate the rule document verbatim are "supported"',
  '    (they are grounded in the evidence, even if not insightful).',
  '  - Claims about specific code behavior visible in the diff are "supported"',
  '    if the diff shows that behavior.',
  '  - Claims about code behavior NOT visible in the diff or rule are "not_supported".',
  '  - If the finding decomposes to zero claims, return an empty claims array.',
  '',
  'Call the `faithfulness_verdict` tool with your decomposed claims and verdicts.',
].join('\n');

// ── Tool schema (structured output) ────────────────────────────────────

export const FAITHFULNESS_VERDICT_TOOL = {
  name: 'faithfulness_verdict',
  description:
    'Report the claim decomposition and per-claim entailment verdicts for a review finding.',
  input_schema: {
    type: 'object' as const,
    properties: {
      claims: {
        type: 'array' as const,
        description:
          'Atomic claims decomposed from the finding, each with a reason and verdict.',
        items: {
          type: 'object' as const,
          properties: {
            claim: {
              type: 'string' as const,
              minLength: 1,
              description:
                'A single atomic, self-contained claim from the finding. No pronouns — use concrete referents.',
            },
            reason: {
              type: 'string' as const,
              minLength: 1,
              description:
                'The evidence (or lack thereof) for this claim. Must come before the verdict in your reasoning.',
            },
            verdict: {
              type: 'string' as const,
              enum: ['supported', 'not_supported', 'unclear'],
              description:
                'Whether this claim is supported by the rule document and/or the diff.',
            },
          },
          required: ['claim', 'reason', 'verdict'] as const,
          additionalProperties: false,
        },
      },
    },
    required: ['claims'] as const,
    additionalProperties: false,
  },
};

// ── Hash computation ───────────────────────────────────────────────────

export function computeJudgePromptHash(): string {
  return createHash('sha256')
    .update(JUDGE_SYSTEM_PROMPT)
    .update(JSON.stringify(FAITHFULNESS_VERDICT_TOOL))
    .digest('hex');
}

// ── Hash map (version → expected hash) ─────────────────────────────────

export const FAITHFULNESS_JUDGE_PROMPT_HASH_MAP: Record<
  typeof FAITHFULNESS_JUDGE_VERSION,
  string
> = {
  // sha256(JUDGE_SYSTEM_PROMPT + JSON.stringify(FAITHFULNESS_VERDICT_TOOL)).
  // The snapshot spec re-computes this on every test run; editing the
  // prompt or tool schema without updating both this hash AND
  // FAITHFULNESS_JUDGE_VERSION in the same commit fails the spec.
  v1: '4e54d8f2251d1948ba4e7eebb656d434c7ebcccf44912ac3848bc09fdbf2ae8d',
};

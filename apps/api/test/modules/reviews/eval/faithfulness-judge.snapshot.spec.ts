import {
  computeJudgePromptHash,
  FAITHFULNESS_JUDGE_VERSION,
  FAITHFULNESS_JUDGE_PROMPT_HASH_MAP,
} from '../../../../src/modules/reviews/eval/faithfulness-judge.prompt';

// Drift guard for the faithfulness judge prompt. Mirrors the
// `anthropic-llm-reviewer.snapshot.spec.ts` pattern — changing the
// judge prompt or tool schema without bumping the version (and adding
// the new hash entry) fails this spec.
//
// IF THIS TEST FAILS YOU MUST DO BOTH OF THE FOLLOWING IN THE SAME COMMIT:
//   1. Bump `FAITHFULNESS_JUDGE_VERSION` in
//      `apps/api/src/modules/reviews/eval/faithfulness-judge.prompt.ts`
//      so every recording written from this point on reflects the new
//      judge prompt version. Recordings produced under the old version
//      are stale and must be re-captured.
//   2. Add a new entry to `FAITHFULNESS_JUDGE_PROMPT_HASH_MAP` mapping
//      the new version to the new sha256 (copy the hash from this
//      test's failure message).
describe('Faithfulness judge — prompt drift guard', () => {
  it('judge prompt + tool hash matches FAITHFULNESS_JUDGE_PROMPT_HASH_MAP[FAITHFULNESS_JUDGE_VERSION]', () => {
    const actualHash = computeJudgePromptHash();
    const expectedHash =
      FAITHFULNESS_JUDGE_PROMPT_HASH_MAP[FAITHFULNESS_JUDGE_VERSION];
    expect(expectedHash).toBeDefined();
    expect(actualHash).toBe(expectedHash);
  });

  it('HASH_MAP contains an entry for the current FAITHFULNESS_JUDGE_VERSION', () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        FAITHFULNESS_JUDGE_PROMPT_HASH_MAP,
        FAITHFULNESS_JUDGE_VERSION,
      ),
    ).toBe(true);
  });
});

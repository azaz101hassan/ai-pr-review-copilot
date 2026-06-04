import { computePromptToolHash } from '../../../src/infrastructure/llm';
import {
  PROMPT_AND_TOOL_VERSION,
  PROMPT_AND_TOOL_VERSION_HASH_MAP,
} from '../../../src/modules/reviews/types/llm-reviewer';

// Drift guard for the prompt + tool schemas. Closes the gap where
// `jest -u` could silently regenerate a snapshot file without
// bumping the version constant. The hash map is the single source
// of truth — changing the prompt or any tool schema without bumping
// the version (and adding the new hash entry) fails this spec.
//
// IF THIS TEST FAILS YOU MUST DO BOTH OF THE FOLLOWING IN THE SAME COMMIT:
//   1. Bump `PROMPT_AND_TOOL_VERSION` in
//      `apps/api/src/modules/reviews/types/llm-reviewer.ts` so every
//      `reviews.prompt_version` row written from this point on reflects
//      the new prompt/schema version. Eval reproducibility depends
//      on this contract.
//   2. Add a new entry to `PROMPT_AND_TOOL_VERSION_HASH_MAP` mapping
//      the new version to the new sha256 (copy the hash from this
//      test's failure message).
//
// Doing just (1) without (2) means HASH_MAP[VERSION] is undefined and
// the assertion fails with a clear message. Doing just (2) without
// (1) means an old version constant maps to a new hash and eval
// reproducibility silently breaks — but this spec catches that case
// because the hash for the OLD version is now different.
describe('AnthropicLlmReviewer — prompt + tool drift guard', () => {
  it('SYSTEM_PROMPT + REGISTERED_TOOLS hash matches PROMPT_AND_TOOL_VERSION_HASH_MAP[PROMPT_AND_TOOL_VERSION]', () => {
    const actualHash = computePromptToolHash();
    const expectedHash = PROMPT_AND_TOOL_VERSION_HASH_MAP[PROMPT_AND_TOOL_VERSION];
    expect(expectedHash).toBeDefined();
    expect(actualHash).toBe(expectedHash);
  });

  it('HASH_MAP contains an entry for the current PROMPT_AND_TOOL_VERSION', () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        PROMPT_AND_TOOL_VERSION_HASH_MAP,
        PROMPT_AND_TOOL_VERSION,
      ),
    ).toBe(true);
  });
});

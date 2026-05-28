import { createHash } from 'node:crypto';
import {
  SYSTEM_PROMPT,
  REPORT_FINDINGS_TOOL,
} from '../../../src/infrastructure/anthropic/anthropic-llm-reviewer';
import { PROMPT_AND_TOOL_VERSION } from '../../../src/modules/reviews/types/llm-reviewer';

// Drift guard for the prompt + tool schema. Hashes both together so a
// change to either fails this spec — the snapshot file records the
// expected sha256.
//
// IF THIS TEST FAILS YOU MUST DO BOTH OF THE FOLLOWING IN THE SAME COMMIT:
//   1. Re-record the snapshot (`jest -u`) so the new hash is captured.
//   2. Bump `PROMPT_AND_TOOL_VERSION` in
//      `apps/api/src/modules/reviews/types/llm-reviewer.ts` so every
//      `reviews.prompt_version` row written from this point on reflects
//      the new prompt/schema version. Day 6 evaluation reproducibility
//      depends on this contract.
//
// Doing just (1) breaks Day-6 reproducibility silently. Doing just (2)
// gives you a version constant that doesn't match the prompt actually
// in use. Both are required.
describe('AnthropicLlmReviewer — prompt + tool drift guard', () => {
  it('SYSTEM_PROMPT + REPORT_FINDINGS_TOOL hash matches recorded snapshot', () => {
    const hash = createHash('sha256')
      .update(SYSTEM_PROMPT)
      .update(JSON.stringify(REPORT_FINDINGS_TOOL))
      .digest('hex');
    expect({ hash, version: PROMPT_AND_TOOL_VERSION }).toMatchSnapshot();
  });
});

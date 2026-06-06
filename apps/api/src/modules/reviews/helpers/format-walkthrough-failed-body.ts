// Walkthrough body posted when the worker fails to complete a review —
// pre-LLM (GitHub API errors, diff overflow, PR closed mid-run) or
// terminal LLM-side (auth, account-cap, malformed responses). Shares
// the outer marker with the success / skipped bodies so upsertWalkthrough
// PATCH-edits the same comment on subsequent attempts.
//
// The body intentionally does NOT expose raw error codes — they're audit
// concerns, not user-facing copy. A short reason hint is included so the
// PR author understands why no findings landed.

export type FailureReason =
  | 'pr_closed_during_review'
  | 'diff_too_large'
  | 'github_api_error'
  | 'comment_post_failed'
  | 'inline_post_failed'
  | 'anthropic_error'
  | 'llm_error'
  | 'internal_error';

export interface FormatWalkthroughFailedBodyInput {
  prNodeId: string;
  reason: FailureReason;
}

const REASON_COPY: Record<FailureReason, string> = {
  pr_closed_during_review:
    'the PR was closed before the review finished',
  diff_too_large:
    'the diff is larger than the byte-size safety cap',
  github_api_error:
    'the bot could not fetch the PR or diff from GitHub',
  comment_post_failed:
    'the bot could not post its walkthrough comment to GitHub',
  inline_post_failed:
    'the bot generated findings but GitHub rejected the inline review',
  anthropic_error:
    'the language-model call was rejected (likely an account or configuration issue)',
  llm_error:
    'the language-model call was rejected (likely an account or configuration issue)',
  internal_error:
    'the bot hit an unexpected internal error',
};

export function formatWalkthroughFailedBody(
  input: FormatWalkthroughFailedBodyInput,
): string {
  const reasonCopy = REASON_COPY[input.reason];
  if (!reasonCopy) {
    throw new Error(
      `formatWalkthroughFailedBody: unknown reason "${String(input.reason)}".`,
    );
  }
  if (!input.prNodeId) {
    throw new Error('formatWalkthroughFailedBody: prNodeId is required.');
  }

  // Outer marker — shared with the success + skipped bodies so a
  // failure walkthrough either replaces (if a later attempt succeeds)
  // or is replaced by an earlier success comment on the same PR.
  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  // Mode marker — lets a future dashboard scraper distinguish a
  // failure walkthrough from a success / skip without re-parsing.
  const modeMarker = `<!-- ai-pr-review-copilot:v1:mode=failed -->`;
  const header = '**AI PR Review Copilot** — review could not complete';

  return [
    marker,
    header,
    modeMarker,
    '',
    `The bot tried to check this PR against your knowledge base but did not finish: ${reasonCopy}.`,
    '',
    '_No findings were generated. The audit log records the underlying error code for the operator to inspect._',
  ].join('\n');
}

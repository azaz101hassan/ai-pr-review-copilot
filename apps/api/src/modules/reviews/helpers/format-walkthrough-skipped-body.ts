// Walkthrough body posted when the worker skips a PR because its diff
// exceeds MAX_REVIEW_DIFF_LINES. Distinct from the normal-review body
// (format-walkthrough-success-body.ts) — different shape, no rules-cited
// block, no summary — but uses the same outer marker so upsertWalkthrough
// can PATCH it in place on re-runs of the same PR.

export interface FormatWalkthroughSkippedBodyInput {
  prNodeId: string;
  changedLines: number;
  limit: number;
}

export function formatWalkthroughSkippedBody(
  input: FormatWalkthroughSkippedBodyInput,
): string {
  if (!Number.isFinite(input.changedLines) || input.changedLines <= 0) {
    throw new Error(
      `formatWalkthroughSkippedBody: changedLines must be a positive number (got ${input.changedLines}).`,
    );
  }
  if (!Number.isFinite(input.limit) || input.limit <= 0) {
    throw new Error(
      `formatWalkthroughSkippedBody: limit must be a positive number (got ${input.limit}).`,
    );
  }

  // Outer marker — reused by upsertWalkthrough's cache + scan path so a
  // size-skip walkthrough survives PR synchronize webhooks as a single
  // PATCH-able comment (no comment spam).
  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  // Mode marker — lets future renderers / a dashboard scraper branch
  // on "was this a skip or a real review?" without re-parsing the body.
  const modeMarker = `<!-- ai-pr-review-copilot:v1:mode=size-skipped -->`;
  const header = '**AI PR Review Copilot** — review skipped';

  return [
    marker,
    header,
    modeMarker,
    '',
    `This PR has **${input.changedLines} changed lines**, which exceeds the configured limit of **${input.limit}** for this reviewer.`,
    '',
    `The bot is tuned to apply your team's knowledge base to small, focused PRs (under ${input.limit} changed lines) where findings are reliable. On larger diffs quality drops and the bot tends to surface noise rather than signal — so it skips them rather than posting a low-confidence review.`,
    '',
    '_No findings were generated. To get a review on this work, consider breaking it into smaller PRs._',
  ].join('\n');
}

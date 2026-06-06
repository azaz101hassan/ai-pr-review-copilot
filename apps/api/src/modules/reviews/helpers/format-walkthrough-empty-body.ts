// Walkthrough body posted on the empty-diff terminal exit (Step 6c).
// A PR with no reviewable diff content never runs retrieval or the
// agent loop and never posts a Review, so this body says exactly that
// and nothing more — no "rules retrieved" line and no "see the review
// below" footer (both false on this path). Shares the outer marker
// with the other walkthrough bodies so upsertWalkthrough PATCHes the
// same comment id across the lifecycle.

export interface FormatWalkthroughEmptyBodyInput {
  prNodeId: string;
  missingChecksPermission?: boolean;
}

export function formatWalkthroughEmptyBody(
  input: FormatWalkthroughEmptyBodyInput,
): string {
  if (!input.prNodeId) {
    throw new Error('formatWalkthroughEmptyBody: prNodeId is required.');
  }

  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  const modeMarker = `<!-- ai-pr-review-copilot:v1:mode=empty-diff -->`;
  const header = '**AI PR Review Copilot** - no changes to review';

  const lines: string[] = [
    marker,
    header,
    modeMarker,
    '',
    "_This PR has no reviewable diff content, so there is nothing to check against your team's knowledge base._",
  ];

  if (input.missingChecksPermission) {
    lines.push(
      '',
      '> _The merge-box status badge is unavailable until your repo admin accepts this app\'s new "Checks" permission at [github.com/settings/installations](https://github.com/settings/installations)._',
    );
  }

  return lines.join('\n');
}

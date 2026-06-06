// Walkthrough body posted at worker dequeue, BEFORE the diff fetch
// and agent loop. PATCH-edited in place by the worker on
// completion (success, failed, or skipped). Shares the outer
// marker with the other walkthrough bodies so upsertWalkthrough
// PATCHes the same comment id across the lifecycle.

export interface FormatWalkthroughInProgressBodyInput {
  prNodeId: string;
  missingChecksPermission?: boolean;
}

export function formatWalkthroughInProgressBody(
  input: FormatWalkthroughInProgressBodyInput,
): string {
  if (!input.prNodeId) {
    throw new Error('formatWalkthroughInProgressBody: prNodeId is required.');
  }

  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  const modeMarker = `<!-- ai-pr-review-copilot:v1:mode=in-progress -->`;
  const header = '**AI PR Review Copilot** — review in progress';

  const lines: string[] = [
    marker,
    header,
    modeMarker,
    '',
    "_Checking this diff against your team's knowledge base. Usually 30-90 seconds on small PRs._",
  ];

  if (input.missingChecksPermission) {
    lines.push(
      '',
      '> _The merge-box status badge is unavailable until your repo admin accepts this app\'s new "Checks" permission at [github.com/settings/installations](https://github.com/settings/installations)._',
    );
  }

  return lines.join('\n');
}

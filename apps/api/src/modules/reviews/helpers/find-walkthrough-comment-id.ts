import type { Octokit } from 'octokit';

// Scan path for the Walkthrough comment id when our cache
// (pull_requests.walkthrough_comment_id) is empty. Reads the PR's
// issue comments and returns the first whose body starts with our
// v1 marker keyed by this PR's node id. Used in the worker step 10a
// before deciding whether to POST a new Walkthrough or PATCH the
// existing one.
//
// per_page=100 is the GitHub max — we don't paginate in v1 because
// any reasonable PR has well under 100 comments by the time the
// bot runs. If pagination becomes necessary later, scan in order
// (oldest first, GitHub's default) so the bot's earliest comment
// wins.

export interface FindWalkthroughCommentIdArgs {
  owner: string;
  repo: string;
  pr_number: number;
  pr_node_id: string;
}

export async function findWalkthroughCommentId(
  octokit: Octokit,
  args: FindWalkthroughCommentIdArgs,
): Promise<number | null> {
  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${args.pr_node_id} -->`;

  const res = await octokit.rest.issues.listComments({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.pr_number,
    per_page: 100,
  });

  const comments = (res.data ?? []) as Array<{
    id: number;
    body: string | null;
  }>;

  for (const c of comments) {
    if (typeof c.body === 'string' && c.body.startsWith(marker)) {
      return c.id;
    }
  }
  return null;
}

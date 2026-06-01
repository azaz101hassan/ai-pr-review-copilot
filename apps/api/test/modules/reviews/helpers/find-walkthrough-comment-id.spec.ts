import { findWalkthroughCommentId } from '@/modules/reviews/helpers/find-walkthrough-comment-id';
import type { Octokit } from 'octokit';

function makeOctokit(listComments: jest.Mock): Octokit {
  return {
    rest: {
      issues: {
        listComments,
      },
    },
  } as unknown as Octokit;
}

const ARGS = {
  owner: 'octocat',
  repo: 'demo',
  pr_number: 7,
  pr_node_id: 'PR_node_test',
};

describe('findWalkthroughCommentId', () => {
  it('returns null when there are no comments', async () => {
    const list = jest.fn().mockResolvedValue({ data: [] });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBeNull();
    expect(list).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'demo',
      issue_number: 7,
      per_page: 100,
    });
  });

  it('returns the id of a comment whose body starts with the matching marker', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [
        { id: 1, body: '<!-- some other marker -->\n...' },
        {
          id: 2,
          body:
            '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_node_test -->\nbody',
        },
        { id: 3, body: 'a plain comment' },
      ],
    });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBe(2);
  });

  it('ignores a marker for a different PR node id', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [
        {
          id: 9,
          body:
            '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_OTHER -->\nbody',
        },
      ],
    });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBeNull();
  });

  it('returns null when no body matches', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [
        { id: 1, body: 'one' },
        { id: 2, body: 'two' },
      ],
    });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBeNull();
  });

  it('tolerates a comment with a null body', async () => {
    const list = jest.fn().mockResolvedValue({
      data: [
        { id: 1, body: null },
        {
          id: 2,
          body:
            '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_node_test -->\nbody',
        },
      ],
    });
    const id = await findWalkthroughCommentId(makeOctokit(list), ARGS);
    expect(id).toBe(2);
  });
});

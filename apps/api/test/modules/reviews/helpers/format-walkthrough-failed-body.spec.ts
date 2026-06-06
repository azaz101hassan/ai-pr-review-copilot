import { formatWalkthroughFailedBody } from '@/modules/reviews/helpers/format-walkthrough-failed-body';

describe('formatWalkthroughFailedBody', () => {
  const VALID_PR_NODE_ID = 'PR_kwDOSrUXLs7hjjgc';

  it('includes the shared walkthrough marker so upsertWalkthrough can PATCH it later', () => {
    const body = formatWalkthroughFailedBody({
      prNodeId: VALID_PR_NODE_ID,
      reason: 'anthropic_error',
    });
    expect(body).toContain(
      `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${VALID_PR_NODE_ID} -->`,
    );
  });

  it('includes a failed-mode marker distinct from the success / skipped markers', () => {
    const body = formatWalkthroughFailedBody({
      prNodeId: VALID_PR_NODE_ID,
      reason: 'github_api_error',
    });
    expect(body).toContain('<!-- ai-pr-review-copilot:v1:mode=failed -->');
    expect(body).not.toContain('mode=size-skipped');
  });

  it('states explicitly that no findings were generated', () => {
    const body = formatWalkthroughFailedBody({
      prNodeId: VALID_PR_NODE_ID,
      reason: 'internal_error',
    });
    expect(body.toLowerCase()).toContain('no findings were generated');
  });

  it('says "review could not complete" in the header so the user sees status at a glance', () => {
    const body = formatWalkthroughFailedBody({
      prNodeId: VALID_PR_NODE_ID,
      reason: 'anthropic_error',
    });
    expect(body.toLowerCase()).toContain('review could not complete');
  });

  it.each([
    ['pr_closed_during_review', /closed/i],
    ['diff_too_large', /diff|cap/i],
    ['github_api_error', /github/i],
    ['anthropic_error', /language-model|model|account|configuration/i],
    ['comment_post_failed', /walkthrough|comment/i],
    ['inline_post_failed', /inline/i],
    ['internal_error', /internal/i],
  ] as const)(
    'renders a reason-specific hint for %s',
    (reason, hintPattern) => {
      const body = formatWalkthroughFailedBody({
        prNodeId: VALID_PR_NODE_ID,
        reason,
      });
      expect(body).toMatch(hintPattern);
    },
  );

  it('does NOT expose raw error codes in the body (audit-only concern)', () => {
    const body = formatWalkthroughFailedBody({
      prNodeId: VALID_PR_NODE_ID,
      reason: 'anthropic_error',
    });
    expect(body).not.toMatch(/invalid_request_error|credit_balance_too_low|authentication_error|permission_error/);
  });

  it('renders the same body for the same inputs (stable output)', () => {
    const a = formatWalkthroughFailedBody({
      prNodeId: VALID_PR_NODE_ID,
      reason: 'github_api_error',
    });
    const b = formatWalkthroughFailedBody({
      prNodeId: VALID_PR_NODE_ID,
      reason: 'github_api_error',
    });
    expect(a).toBe(b);
  });

  it('throws on an unknown reason (defensive)', () => {
    expect(() =>
      formatWalkthroughFailedBody({
        prNodeId: VALID_PR_NODE_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reason: 'not-a-reason' as any,
      }),
    ).toThrow(/unknown reason/);
  });

  it('throws on an empty prNodeId (defensive — the worker always has one)', () => {
    expect(() =>
      formatWalkthroughFailedBody({
        prNodeId: '',
        reason: 'github_api_error',
      }),
    ).toThrow(/prNodeId/);
  });

  it('includes the KB-tone failure copy', () => {
    const body = formatWalkthroughFailedBody({
      prNodeId: 'PR_x',
      reason: 'llm_error',
    });
    expect(body).toMatch(
      /tried to check this PR against your knowledge base but did not finish/,
    );
  });
});

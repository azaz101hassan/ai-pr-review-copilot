import { formatWalkthroughEmptyBody } from '@/modules/reviews/helpers/format-walkthrough-empty-body';

describe('formatWalkthroughEmptyBody', () => {
  it('emits the v1 walkthrough marker keyed by the PR node id', () => {
    const body = formatWalkthroughEmptyBody({ prNodeId: 'PR_kw_42' });
    expect(body).toContain(
      '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_kw_42 -->',
    );
  });

  it('emits the mode=empty-diff marker', () => {
    const body = formatWalkthroughEmptyBody({ prNodeId: 'PR_x' });
    expect(body).toContain('<!-- ai-pr-review-copilot:v1:mode=empty-diff -->');
  });

  it('contains the honest no-reviewable-diff copy', () => {
    const body = formatWalkthroughEmptyBody({ prNodeId: 'PR_x' });
    expect(body).toMatch(/This PR has no reviewable diff content/);
  });

  it('does NOT claim rules were retrieved or that a review was posted', () => {
    const body = formatWalkthroughEmptyBody({ prNodeId: 'PR_x' });
    expect(body).not.toContain('rules retrieved');
    expect(body).not.toContain('See the review below');
    expect(body).not.toContain('mode=success');
  });

  it('appends the permission-pending line when missingChecksPermission is true', () => {
    const body = formatWalkthroughEmptyBody({
      prNodeId: 'PR_x',
      missingChecksPermission: true,
    });
    expect(body).toMatch(/merge-box status badge is unavailable/);
  });

  it('omits the permission-pending line by default', () => {
    const body = formatWalkthroughEmptyBody({ prNodeId: 'PR_x' });
    expect(body).not.toMatch(/merge-box status badge is unavailable/);
  });

  it('throws on an empty prNodeId', () => {
    expect(() => formatWalkthroughEmptyBody({ prNodeId: '' })).toThrow(
      /prNodeId is required/,
    );
  });
});

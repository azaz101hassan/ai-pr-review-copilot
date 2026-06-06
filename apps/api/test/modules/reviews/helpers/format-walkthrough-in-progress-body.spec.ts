import { formatWalkthroughInProgressBody } from '@/modules/reviews/helpers/format-walkthrough-in-progress-body';

describe('formatWalkthroughInProgressBody', () => {
  it('emits the v1 walkthrough marker keyed by the PR node id', () => {
    const body = formatWalkthroughInProgressBody({ prNodeId: 'PR_kw_42' });
    expect(body).toContain(
      '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_kw_42 -->',
    );
  });

  it('emits the mode=in-progress marker', () => {
    const body = formatWalkthroughInProgressBody({ prNodeId: 'PR_x' });
    expect(body).toContain('<!-- ai-pr-review-copilot:v1:mode=in-progress -->');
  });

  it('contains the KB-grounded single-sentence status copy', () => {
    const body = formatWalkthroughInProgressBody({ prNodeId: 'PR_x' });
    expect(body).toMatch(
      /Checking this diff against your team's knowledge base/,
    );
  });

  it('appends the permission-pending line when missingChecksPermission is true', () => {
    const body = formatWalkthroughInProgressBody({
      prNodeId: 'PR_x',
      missingChecksPermission: true,
    });
    expect(body).toMatch(/merge-box status badge is unavailable/);
  });

  it('omits the permission-pending line by default', () => {
    const body = formatWalkthroughInProgressBody({ prNodeId: 'PR_x' });
    expect(body).not.toMatch(/merge-box status badge is unavailable/);
  });

  it('throws on an empty prNodeId', () => {
    expect(() => formatWalkthroughInProgressBody({ prNodeId: '' })).toThrow(
      /prNodeId is required/,
    );
  });
});

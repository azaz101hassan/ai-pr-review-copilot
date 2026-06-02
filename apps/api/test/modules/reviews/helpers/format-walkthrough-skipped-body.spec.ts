import { formatWalkthroughSkippedBody } from '@/modules/reviews/helpers/format-walkthrough-skipped-body';

describe('formatWalkthroughSkippedBody', () => {
  const VALID_PR_NODE_ID = 'PR_kwDOSrUXLs7hjjgc';

  it('includes the walkthrough marker so upsertWalkthrough can find/PATCH it later', () => {
    const body = formatWalkthroughSkippedBody({
      prNodeId: VALID_PR_NODE_ID,
      changedLines: 1200,
      limit: 500,
    });
    expect(body).toContain(`<!-- ai-pr-review-copilot:walkthrough:v1:pr=${VALID_PR_NODE_ID} -->`);
  });

  it('quotes both the actual changed-line count and the configured limit', () => {
    const body = formatWalkthroughSkippedBody({
      prNodeId: VALID_PR_NODE_ID,
      changedLines: 1200,
      limit: 500,
    });
    expect(body).toContain('1200');
    expect(body).toContain('500');
  });

  it('states explicitly that no findings were generated', () => {
    const body = formatWalkthroughSkippedBody({
      prNodeId: VALID_PR_NODE_ID,
      changedLines: 800,
      limit: 500,
    });
    expect(body.toLowerCase()).toMatch(/no findings|skipped|not reviewed/);
  });

  it('explains the bot is tuned for small focused PRs', () => {
    const body = formatWalkthroughSkippedBody({
      prNodeId: VALID_PR_NODE_ID,
      changedLines: 800,
      limit: 500,
    });
    expect(body.toLowerCase()).toMatch(/small|focused|under \d+/);
  });

  it('includes a skipped-mode marker distinct from the normal review marker', () => {
    const body = formatWalkthroughSkippedBody({
      prNodeId: VALID_PR_NODE_ID,
      changedLines: 800,
      limit: 500,
    });
    // Distinguishes a size-skip body from a normal review walkthrough
    // body so a future renderer/scraper can branch on mode.
    expect(body).toContain('<!-- ai-pr-review-copilot:v1:mode=size-skipped -->');
  });

  it('renders the same body for the same inputs (stable output)', () => {
    const a = formatWalkthroughSkippedBody({
      prNodeId: VALID_PR_NODE_ID,
      changedLines: 800,
      limit: 500,
    });
    const b = formatWalkthroughSkippedBody({
      prNodeId: VALID_PR_NODE_ID,
      changedLines: 800,
      limit: 500,
    });
    expect(a).toBe(b);
  });

  it('throws on a non-positive changedLines (defensive — the worker should never pass this)', () => {
    expect(() =>
      formatWalkthroughSkippedBody({
        prNodeId: VALID_PR_NODE_ID,
        changedLines: 0,
        limit: 500,
      }),
    ).toThrow(/changedLines/);
  });

  it('throws on a non-positive limit (defensive — ConfigService bounds this)', () => {
    expect(() =>
      formatWalkthroughSkippedBody({
        prNodeId: VALID_PR_NODE_ID,
        changedLines: 800,
        limit: 0,
      }),
    ).toThrow(/limit/);
  });
});

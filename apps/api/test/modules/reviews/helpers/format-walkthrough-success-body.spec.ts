import {
  formatWalkthroughSuccessBody,
  type FormatWalkthroughSuccessBodyInput,
} from '@/modules/reviews/helpers/format-walkthrough-success-body';

const REVIEW_ID = '11111111-1111-1111-1111-111111111111';

function baseInput(): FormatWalkthroughSuccessBodyInput {
  return {
    prNodeId: 'PR_x',
    reviewId: REVIEW_ID,
    retrievedRulesCount: 40,
    firingRules: [],
    intro: null,
    reviewPosted: true,
    missingChecksPermission: false,
    // Inject identity sanitizer: the sanitize-finding-markdown module
    // is stubbed under Jest (ESM-only pipeline). Using the real stub
    // wraps output in [stub]...[/stub] which breaks truncation assertions.
    sanitize: (s: string) => s,
  };
}

describe('formatWalkthroughSuccessBody', () => {
  it('throws on a non-UUID reviewId', () => {
    expect(() =>
      formatWalkthroughSuccessBody({ ...baseInput(), reviewId: 'not-a-uuid' }),
    ).toThrow(/UUID/);
  });

  it('emits the walkthrough marker, mode=success, and the review-id marker', () => {
    const body = formatWalkthroughSuccessBody(baseInput());
    expect(body).toContain('<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_x -->');
    expect(body).toContain('<!-- ai-pr-review-copilot:v1:mode=success -->');
    expect(body).toContain(`<!-- ai-pr-review-copilot:v1:review-id=${REVIEW_ID} -->`);
  });

  it('includes the KB-grounding banner line citing the retrieved count', () => {
    const body = formatWalkthroughSuccessBody({ ...baseInput(), retrievedRulesCount: 40 });
    expect(body).toMatch(/Reviewed against your team's knowledge base — top \*\*40\*\* rules retrieved/);
  });

  it('renders the LLM prose intro under a "### Summary" header when intro is non-null', () => {
    const body = formatWalkthroughSuccessBody({ ...baseInput(), intro: 'This PR adds the orders controller.' });
    expect(body).toContain('### Summary');
    expect(body).toContain('This PR adds the orders controller.');
  });

  it('omits the Summary section entirely when intro is null', () => {
    const body = formatWalkthroughSuccessBody({ ...baseInput(), intro: null });
    expect(body).not.toContain('### Summary');
  });

  it('omits the Rules cited details when firingRules is empty', () => {
    const body = formatWalkthroughSuccessBody({ ...baseInput(), firingRules: [] });
    expect(body).not.toContain('Rules cited');
  });

  it('renders Rules cited grouped by source with severity emoji when firingRules is non-empty', () => {
    const firingRules: FormatWalkthroughSuccessBodyInput['firingRules'] = [
      { rule_id: 'no-secret-in-log', source: 'api-conventions.json', title: 'Sensitive identifiers must not appear in log statements', severity: 'error' },
      { rule_id: 'thin-controllers', source: 'api-conventions.json', title: 'Controllers contain HTTP wiring only', severity: 'error' },
      { rule_id: 'bound-query-pagination', source: 'team-standards.json', title: 'Endpoints returning collections must bound a limit', severity: 'warning' },
    ];
    const body = formatWalkthroughSuccessBody({ ...baseInput(), firingRules });
    expect(body).toContain('Rules cited (3)');
    expect(body).toContain('**From `api-conventions.json`**');
    expect(body).toContain('**From `team-standards.json`**');
    expect(body).toContain('🛑 `no-secret-in-log`');
    expect(body).toContain('⚠️ `bound-query-pagination`');
  });

  it('sanitizes and truncates rule titles to 80 chars', () => {
    const long = 'X'.repeat(200);
    const body = formatWalkthroughSuccessBody({
      ...baseInput(),
      firingRules: [{ rule_id: 'long-title-rule', source: 'a.json', title: long, severity: 'info' }],
    });
    expect(body).toContain('X'.repeat(80));
    expect(body).not.toContain('X'.repeat(120));
  });

  it('routes rule titles and the intro through the injected sanitizer', () => {
    const tag = (s: string) => `S(${s})`;
    const body = formatWalkthroughSuccessBody({
      ...baseInput(),
      sanitize: tag,
      intro: 'orders summary',
      firingRules: [
        {
          rule_id: 'r1',
          source: 'a.json',
          title: 'short title',
          severity: 'info',
        },
      ],
    });
    expect(body).toContain('S(orders summary)');
    expect(body).toContain('S(short title)');
  });

  it('appends the permission-pending line when missingChecksPermission is true', () => {
    const body = formatWalkthroughSuccessBody({ ...baseInput(), missingChecksPermission: true });
    expect(body).toMatch(/merge-box status badge is unavailable/);
  });

  it('renders the "see the review below" footer when reviewPosted is true', () => {
    const body = formatWalkthroughSuccessBody({ ...baseInput(), reviewPosted: true });
    expect(body).toContain(
      'See the review below for the per-line findings and severity rollup.',
    );
  });

  it('omits the "see the review below" footer when reviewPosted is false (clean review, no Review posted)', () => {
    const body = formatWalkthroughSuccessBody({
      ...baseInput(),
      reviewPosted: false,
      intro: 'This PR is clean.',
      firingRules: [
        { rule_id: 'r1', source: 'a.json', title: 'A rule', severity: 'info' },
      ],
    });
    // The misleading footer is gone...
    expect(body).not.toContain('See the review below');
    // ...but the rest of the body still renders: markers, KB banner,
    // the Summary intro, and the Rules cited block.
    expect(body).toContain('<!-- ai-pr-review-copilot:v1:mode=success -->');
    expect(body).toMatch(/top \*\*40\*\* rules retrieved/);
    expect(body).toContain('### Summary');
    expect(body).toContain('This PR is clean.');
    expect(body).toContain('Rules cited (1)');
  });
});

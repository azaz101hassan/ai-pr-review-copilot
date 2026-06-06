import {
  formatReviewBody,
  FindingWithSeverity,
} from '@/modules/reviews/helpers/format-review-body';
import type { OutsideDiffFinding } from '@/modules/reviews/helpers/anchor-findings-to-diff';

const VALID_UUID = '01234567-89ab-4cde-8fed-cba987654321';
const REVIEW_ID = '22222222-2222-2222-2222-222222222222';

const passthroughSanitize = (s: string) => s;

describe('formatReviewBody', () => {
  it('throws on a non-UUID reviewId', () => {
    expect(() =>
      formatReviewBody({
        reviewId: 'nope',
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        retrievedRulesCount: 0,
        outsideDiff: [],
      }),
    ).toThrow(/UUID/);
  });

  it('emits the marker on every body', () => {
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 0, warning: 0, info: 0, total: 0 },
      retrievedRulesCount: 40,
      outsideDiff: [],
    });
    expect(body).toContain(`<!-- ai-pr-review-copilot:v1:review-id=${REVIEW_ID} -->`);
  });

  it('zero-findings body has the KB-consulted banner and no counts table', () => {
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 0, warning: 0, info: 0, total: 0 },
      retrievedRulesCount: 40,
      outsideDiff: [],
    });
    expect(body).toMatch(/0 findings — your knowledge base was consulted \(top 40 rules retrieved\)/);
    expect(body).not.toContain('| 🛑 errors |');
  });

  it('N-findings body has the banner line and the counts table', () => {
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 1, warning: 2, info: 0, total: 3 },
      retrievedRulesCount: 40,
      outsideDiff: [],
    });
    expect(body).toMatch(/3 findings — your knowledge base was consulted \(top 40 rules retrieved\)/);
    expect(body).toContain('| 🛑 errors | ⚠️ warnings | 💡 info |');
    expect(body).toContain('| 1 | 2 | 0 |');
  });

  it('renders outside-diff findings under a CAUTION callout', () => {
    const outsideDiff: OutsideDiffFinding[] = [
      {
        finding: {
          rule_id: 'readonly-injected-deps',
          severity: 'warning',
          title: 'Injected deps should be readonly',
          message: 'Constructor param `logger` is mutable.',
          location_hint: 'src/x.ts:120-125',
          citation: null,
        },
        parsedAnchor: { path: 'src/x.ts', startLine: 120, endLine: 125 },
      },
    ];
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 0, warning: 1, info: 0, total: 1 },
      retrievedRulesCount: 40,
      outsideDiff,
      sanitize: (s) => s,
    });
    expect(body).toContain('> [!CAUTION]');
    expect(body).toContain('Outside diff range comments (1)');
    expect(body).toContain('src/x.ts:120-125');
    expect(body).toContain('readonly-injected-deps');
  });

  it('routes the outside-diff message through the injected sanitizer', () => {
    const tag = (s: string) => `S(${s})`;
    const outsideDiff: OutsideDiffFinding[] = [
      {
        finding: {
          rule_id: 'r1',
          severity: 'warning',
          title: 't',
          message: 'mutable logger',
          location_hint: 'src/x.ts:1',
          citation: null,
        },
        parsedAnchor: { path: 'src/x.ts', startLine: 1, endLine: 1 },
      },
    ];
    const body = formatReviewBody({
      reviewId: REVIEW_ID,
      counts: { error: 0, warning: 1, info: 0, total: 1 },
      retrievedRulesCount: 40,
      outsideDiff,
      sanitize: tag,
    });
    expect(body).toContain('S(mutable logger)');
  });
});

describe('formatReviewBody — UUID validation (additional cases)', () => {
  it('throws on a UUID with an injected suffix', () => {
    expect(() =>
      formatReviewBody({
        reviewId: `${VALID_UUID} extra`,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        retrievedRulesCount: 0,
        outsideDiff: [],
      }),
    ).toThrow(/UUID/);
  });

  it('accepts a canonical lowercase UUID', () => {
    expect(() =>
      formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        retrievedRulesCount: 0,
        outsideDiff: [],
      }),
    ).not.toThrow();
  });

  it('accepts a canonical uppercase UUID', () => {
    expect(() =>
      formatReviewBody({
        reviewId: VALID_UUID.toUpperCase(),
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        retrievedRulesCount: 0,
        outsideDiff: [],
      }),
    ).not.toThrow();
  });
});

describe('formatReviewBody — marker', () => {
  it('puts the v1 review-id marker on the first line', () => {
    const body = formatReviewBody({
      reviewId: VALID_UUID,
      counts: { error: 0, warning: 0, info: 0, total: 0 },
      retrievedRulesCount: 0,
      outsideDiff: [],
    });
    const lines = body.split('\n');
    expect(lines[0]).toBe(
      `<!-- ai-pr-review-copilot:v1:review-id=${VALID_UUID} -->`,
    );
  });
});

describe('formatReviewBody — does NOT include bold header', () => {
  it('does NOT render the bold header line', () => {
    const body = formatReviewBody({
      reviewId: VALID_UUID,
      counts: { error: 1, warning: 0, info: 0, total: 1 },
      retrievedRulesCount: 0,
      outsideDiff: [],
      sanitize: passthroughSanitize,
    });
    expect(body).not.toContain('**AI PR Review Copilot**');
  });
});

// Re-export check — FindingWithSeverity is still the shared shape.
describe('FindingWithSeverity (type re-export)', () => {
  it('compiles', () => {
    const f: FindingWithSeverity = {
      rule_id: 'r',
      title: 't',
      message: 'm',
      severity: 'warning',
      location_hint: null,
      citation: null,
    };
    expect(f.severity).toBe('warning');
  });
});

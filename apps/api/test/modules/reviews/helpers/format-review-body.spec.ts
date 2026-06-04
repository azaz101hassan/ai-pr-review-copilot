import {
  formatReviewBody,
  FindingWithSeverity,
} from '@/modules/reviews/helpers/format-review-body';
import { formatWalkthroughBody } from '@/modules/reviews/helpers/format-walkthrough-body';

const VALID_UUID = '01234567-89ab-4cde-8fed-cba987654321';

const passthroughSanitize = (s: string) => s;

describe('formatReviewBody (pointer-only shape)', () => {
  describe('reviewId UUID validation', () => {
    it('throws on a non-UUID reviewId', () => {
      expect(() =>
        formatReviewBody({
          reviewId: 'not-a-uuid',
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          hasOutsideDiff: false,
          sanitize: passthroughSanitize,
        }),
      ).toThrow(/canonical UUID/);
    });

    it('throws on a UUID with an injected suffix', () => {
      expect(() =>
        formatReviewBody({
          reviewId: `${VALID_UUID} extra`,
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          hasOutsideDiff: false,
          sanitize: passthroughSanitize,
        }),
      ).toThrow(/canonical UUID/);
    });

    it('accepts a canonical lowercase UUID', () => {
      expect(() =>
        formatReviewBody({
          reviewId: VALID_UUID,
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          hasOutsideDiff: false,
          sanitize: passthroughSanitize,
        }),
      ).not.toThrow();
    });

    it('accepts a canonical uppercase UUID', () => {
      expect(() =>
        formatReviewBody({
          reviewId: VALID_UUID.toUpperCase(),
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          hasOutsideDiff: false,
          sanitize: passthroughSanitize,
        }),
      ).not.toThrow();
    });
  });

  describe('marker', () => {
    it('puts the v1 review-id marker on the first line', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      const lines = body.split('\n');
      expect(lines[0]).toBe(
        `<!-- ai-pr-review-copilot:v1:review-id=${VALID_UUID} -->`,
      );
    });
  });

  describe('body content', () => {
    it('renders the no-findings line when total === 0', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('No findings');
    });

    it('renders the pointer line when findings exist', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 1, warning: 2, info: 0, total: 3 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      expect(body).toMatch(/Inline comments below/);
      expect(body).toMatch(/walkthrough comment/);
    });

    it('does NOT render the counts table (that lives in the walkthrough)', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 1, warning: 2, info: 0, total: 3 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      expect(body).not.toContain('🛑');
      expect(body).not.toContain('⚠️');
      expect(body).not.toContain('| ---');
      expect(body).not.toMatch(/\|\s*1\s*\|/);
    });

    it('does NOT render the bold header (that lives in the walkthrough)', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 1, warning: 0, info: 0, total: 1 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      expect(body).not.toContain('**AI PR Review Copilot**');
    });
  });

  describe('walkthrough pointer', () => {
    it('includes an outside-diff pointer line when hasOutsideDiff is true', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 1, info: 0, total: 1 },
        hasOutsideDiff: true,
        sanitize: passthroughSanitize,
      });
      expect(body).toMatch(/outside this diff/);
    });

    it('omits the outside-diff pointer when hasOutsideDiff is false', () => {
      const body = formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 1, info: 0, total: 1 },
        hasOutsideDiff: false,
        sanitize: passthroughSanitize,
      });
      expect(body).not.toMatch(/outside this diff/);
    });
  });

  describe('does NOT include per-finding blocks', () => {
    it('does not call the sanitizer (no per-finding text in body)', () => {
      const calls: string[] = [];
      const recordingSanitize = (s: string) => {
        calls.push(s);
        return s;
      };
      formatReviewBody({
        reviewId: VALID_UUID,
        counts: { error: 1, warning: 0, info: 0, total: 1 },
        hasOutsideDiff: false,
        sanitize: recordingSanitize,
      });
      expect(calls).toHaveLength(0);
    });
  });
});

// Collision-guard against the bug that produced two visually-identical
// posts on PR #29: the walkthrough comment and the review event landed
// in the same conversation timeline within seconds and both rendered
// the same `**AI PR Review Copilot** — automated review` header plus
// the same `| 🛑 errors | ⚠️ warnings | 💡 info |` counts table.
// Looked exactly like duplicate posts.
//
// Two-formatter unit tests in isolation can't catch this — each test
// verifies its own body. This test pairs the formatters and asserts
// the rendered bodies do not collide on the substrings GitHub renders
// most prominently in the timeline.
describe('walkthrough / review body collision guard', () => {
  const counts = { error: 5, warning: 2, info: 0, total: 7 };

  it('the two bodies share no significant rendered substring', () => {
    const walkthrough = formatWalkthroughBody({
      prNodeId: 'PR_node_id',
      reviewId: VALID_UUID,
      counts,
      outsideDiff: [],
      sanitize: passthroughSanitize,
    });
    const review = formatReviewBody({
      reviewId: VALID_UUID,
      counts,
      hasOutsideDiff: false,
      sanitize: passthroughSanitize,
    });

    // Bold header line is the walkthrough's identity in the timeline.
    expect(walkthrough).toContain('**AI PR Review Copilot**');
    expect(review).not.toContain('**AI PR Review Copilot**');

    // Counts-table row is the walkthrough's most prominent rendering.
    const tableHeader = '| 🛑 errors | ⚠️ warnings | 💡 info |';
    expect(walkthrough).toContain(tableHeader);
    expect(review).not.toContain(tableHeader);

    // The numeric counts row likewise belongs only to the walkthrough.
    const countsRow = `| ${counts.error} | ${counts.warning} | ${counts.info} |`;
    expect(walkthrough).toContain(countsRow);
    expect(review).not.toContain(countsRow);
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

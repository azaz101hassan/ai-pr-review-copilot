import { formatWalkthroughBody } from '@/modules/reviews/helpers/format-walkthrough-body';
import type { OutsideDiffFinding } from '@/modules/reviews/helpers/anchor-findings-to-diff';
import type { FindingWithSeverity } from '@/modules/reviews/helpers/format-review-body';

const VALID_UUID = '01234567-89ab-4cde-8fed-cba987654321';
const PR_NODE_ID = 'PR_kwDOABCDEFG';

function f(overrides: Partial<FindingWithSeverity> = {}): FindingWithSeverity {
  return {
    rule_id: 'rule.test',
    title: 'A finding',
    message: 'Some explanation.',
    severity: 'warning',
    location_hint: null,
    citation: null,
    ...overrides,
  };
}

function out(
  finding: FindingWithSeverity,
  parsed: OutsideDiffFinding['parsedAnchor'] = null,
): OutsideDiffFinding {
  return { finding, parsedAnchor: parsed };
}

const passthroughSanitize = (s: string) => s;

describe('formatWalkthroughBody', () => {
  describe('marker', () => {
    it('puts the v1 HTML walkthrough marker on line 1', () => {
      const body = formatWalkthroughBody({
        prNodeId: PR_NODE_ID,
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      expect(body.split('\n')[0]).toBe(
        `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${PR_NODE_ID} -->`,
      );
    });

    it('throws when reviewId is not a canonical UUID', () => {
      expect(() =>
        formatWalkthroughBody({
          prNodeId: PR_NODE_ID,
          reviewId: 'not-a-uuid',
          counts: { error: 0, warning: 0, info: 0, total: 0 },
          outsideDiff: [],
          sanitize: passthroughSanitize,
        }),
      ).toThrow(/canonical UUID/);
    });
  });

  describe('zero findings', () => {
    it('renders the no-findings line and omits the outside-diff section', () => {
      const body = formatWalkthroughBody({
        prNodeId: PR_NODE_ID,
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('No findings');
      expect(body).not.toContain('<details>');
      expect(body).not.toContain('Outside diff range');
    });
  });

  describe('counts table', () => {
    it('renders error/warning/info counts when non-zero', () => {
      const body = formatWalkthroughBody({
        prNodeId: PR_NODE_ID,
        reviewId: VALID_UUID,
        counts: { error: 2, warning: 3, info: 1, total: 6 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('🛑');
      expect(body).toContain('2');
      expect(body).toContain('⚠️');
      expect(body).toContain('3');
      expect(body).toContain('💡');
      expect(body).toContain('1');
    });
  });

  describe('outside-diff section', () => {
    it('renders a collapsible <details> block with all outside-diff findings', () => {
      const body = formatWalkthroughBody({
        prNodeId: PR_NODE_ID,
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 2, info: 0, total: 2 },
        outsideDiff: [
          out(
            f({ title: 'First', message: 'm1' }),
            { path: 'src/a.ts', startLine: 5, endLine: 5 },
          ),
          out(f({ title: 'Second', message: 'm2', location_hint: null })),
        ],
        sanitize: passthroughSanitize,
      });
      expect(body).toContain('<details>');
      expect(body).toContain('Outside diff range comments (2)');
      expect(body).toContain('First');
      expect(body).toContain('Second');
      // First has a parsed anchor — render its file:line hint.
      expect(body).toContain('src/a.ts:5');
    });
  });

  describe('marker keyed by prNodeId', () => {
    it('different prNodeId produces a different marker', () => {
      const a = formatWalkthroughBody({
        prNodeId: 'PR_A',
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      const b = formatWalkthroughBody({
        prNodeId: 'PR_B',
        reviewId: VALID_UUID,
        counts: { error: 0, warning: 0, info: 0, total: 0 },
        outsideDiff: [],
        sanitize: passthroughSanitize,
      });
      expect(a.split('\n')[0]).not.toBe(b.split('\n')[0]);
    });
  });
});

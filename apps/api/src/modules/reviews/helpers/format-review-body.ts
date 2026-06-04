import type { Finding } from '@/modules/reviews/types/llm-reviewer';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';
import type { FindingCounts } from './finding-counts.types';

type SanitizeFn = (input: string) => string;

// Pointer-only Review body. The counts table and any outside-diff
// rendering live in the walkthrough issue comment; the review's body
// exists only to carry the UUID marker (so duplicate-review detection
// works) and to point readers at the walkthrough.
//
// History: an earlier "slim" iteration of this body still rendered the
// counts table AND the same header as the walkthrough. That collided
// visually in the PR timeline — the walkthrough issue comment and the
// review event landed within seconds of each other and looked like
// duplicate posts. The counts table is the walkthrough's job; this
// file's job is the marker plus a one-line pointer.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Severity-rich Finding shape. The processor narrows the raw Finding
// shape from the LLM reviewer into this by joining with the matched
// rule's metadata.
export interface FindingWithSeverity extends Finding {
  severity: 'error' | 'warning' | 'info';
}

export interface FormatReviewBodyInput {
  reviewId: string;
  counts: FindingCounts;
  hasOutsideDiff: boolean;
  // Sanitizer kept for symmetry with the other formatters even though
  // this body doesn't currently render user-controlled markdown.
  sanitize?: SanitizeFn;
}

export function formatReviewBody(input: FormatReviewBodyInput): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatReviewBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }
  void (input.sanitize ?? sanitizeFindingMarkdown);

  const marker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;

  if (input.counts.total === 0) {
    return [marker, '_No findings — the diff matched no team rules._'].join('\n');
  }

  // With findings: a single pointer line. Header + counts live in the
  // walkthrough comment. Mentioning the walkthrough by name keeps the
  // reader oriented when both posts land in the same timeline.
  const lines: string[] = [
    marker,
    '_Inline comments below. See the walkthrough comment for the full summary._',
  ];

  if (input.hasOutsideDiff) {
    lines.push(
      '_Some findings sit outside this diff and are listed in the walkthrough._',
    );
  }

  return lines.join('\n');
}

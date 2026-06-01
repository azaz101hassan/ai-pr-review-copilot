import type { Finding } from '@/modules/reviews/types/llm-reviewer';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';
import type { FindingCounts } from './finding-counts.types';

type SanitizeFn = (input: string) => string;

// Slim Review-with-inlines body. Per-finding rendering moved to
// format-inline-comment (anchorable findings) and
// format-walkthrough-body (outside-diff findings). The Review's
// body only carries the self-identifying header, the UUID marker,
// a counts row, and (when applicable) a pointer to the Walkthrough.
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
  // Sanitizer is plumbed in for symmetry with the other formatters
  // even though the slim body does not currently render any
  // user-controlled markdown — callers can keep passing it without
  // a code change if findings ever return to the body.
  sanitize?: SanitizeFn;
}

export function formatReviewBody(input: FormatReviewBodyInput): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatReviewBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }
  // sanitize is intentionally unused right now — keep the param for
  // symmetry. Reference it once to make tsc happy in strict mode.
  void (input.sanitize ?? sanitizeFindingMarkdown);

  const header = '**🤖 AI PR Review Copilot** — automated review (Day 5)';
  const marker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;

  const lines: string[] = [header, marker, ''];

  if (input.counts.total === 0) {
    lines.push('_No findings — the diff matched no team rules._');
    return lines.join('\n');
  }

  lines.push('| 🛑 errors | ⚠️ warnings | 💡 info |');
  lines.push('|---|---|---|');
  lines.push(
    `| ${input.counts.error} | ${input.counts.warning} | ${input.counts.info} |`,
  );

  if (input.hasOutsideDiff) {
    lines.push('');
    lines.push(
      '_See the Walkthrough comment above for findings outside this diff._',
    );
  }

  return lines.join('\n');
}

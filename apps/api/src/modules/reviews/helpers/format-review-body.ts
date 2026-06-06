import type { Finding } from '@/modules/reviews/types/llm-reviewer';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';
import type { FindingCounts } from './finding-counts.types';
import type { OutsideDiffFinding } from './anchor-findings-to-diff';

type SanitizeFn = (input: string) => string;

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
  retrievedRulesCount: number;
  outsideDiff: OutsideDiffFinding[];
  sanitize?: SanitizeFn;
}

export function formatReviewBody(input: FormatReviewBodyInput): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatReviewBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }
  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;
  const marker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;

  const lines: string[] = [marker, ''];

  if (input.counts.total === 0) {
    lines.push(
      `**0 findings — your knowledge base was consulted (top ${input.retrievedRulesCount} rules retrieved).**`,
      '',
      '_The diff is within scope and matched no team rules._',
      '',
      'See the walkthrough comment above for the change summary.',
    );
    return lines.join('\n');
  }

  lines.push(
    `**${input.counts.total} findings — your knowledge base was consulted (top ${input.retrievedRulesCount} rules retrieved).**`,
    '',
    '| 🛑 errors | ⚠️ warnings | 💡 info |',
    '|---|---|---|',
    `| ${input.counts.error} | ${input.counts.warning} | ${input.counts.info} |`,
  );

  if (input.outsideDiff.length > 0) {
    lines.push(
      '',
      '> [!CAUTION]',
      "> Some findings are outside the changed lines and can't be posted inline due to GitHub limitations.",
      '>',
      '> <details>',
      `> <summary>⚠️ Outside diff range comments (${input.outsideDiff.length})</summary>`,
      '>',
    );
    for (const od of input.outsideDiff) {
      const block = renderOutsideDiffEntry(od, sanitize);
      for (const blockLine of block.split('\n')) {
        lines.push(`> ${blockLine}`);
      }
      lines.push('>');
    }
    lines.push('> </details>');
  }

  lines.push(
    '',
    'See the walkthrough comment above for the change summary. Inline comments are anchored below.',
  );

  return lines.join('\n');
}

function renderOutsideDiffEntry(
  entry: OutsideDiffFinding,
  sanitize: SanitizeFn,
): string {
  const f = entry.finding;
  const message = sanitize(f.message || '_(no message)_');
  const where = entry.parsedAnchor
    ? entry.parsedAnchor.startLine !== null
      ? entry.parsedAnchor.endLine !== null &&
        entry.parsedAnchor.startLine !== entry.parsedAnchor.endLine
        ? `${entry.parsedAnchor.path}:${entry.parsedAnchor.startLine}-${entry.parsedAnchor.endLine}`
        : `${entry.parsedAnchor.path}:${entry.parsedAnchor.startLine}`
      : entry.parsedAnchor.path
    : f.location_hint ?? '(no location)';
  return [
    `**\`${where}\`** — ${f.rule_id}`,
    '',
    message,
    '',
    `_Rule:_ \`${f.rule_id}\``,
  ].join('\n');
}

import type { OutsideDiffFinding } from './anchor-findings-to-diff';
import type { FindingWithSeverity } from './format-review-body';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';

type SanitizeFn = (input: string) => string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FindingCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export interface FormatWalkthroughBodyInput {
  prNodeId: string;
  reviewId: string;
  counts: FindingCounts;
  outsideDiff: OutsideDiffFinding[];
  sanitize?: SanitizeFn;
}

export function formatWalkthroughBody(
  input: FormatWalkthroughBodyInput,
): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatWalkthroughBody: reviewId is not a canonical UUID (got "${input.reviewId}").`,
    );
  }

  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;
  const marker = `<!-- ai-pr-review-copilot:walkthrough:v1:pr=${input.prNodeId} -->`;
  const header = '**🤖 AI PR Review Copilot** — automated review (walkthrough)';
  const reviewMarker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;

  const lines: string[] = [marker, header, reviewMarker, ''];

  if (input.counts.total === 0) {
    lines.push('_No findings — the diff matched no team rules._');
    return lines.join('\n');
  }

  // Counts table.
  lines.push('| 🛑 errors | ⚠️ warnings | 💡 info |');
  lines.push('|---|---|---|');
  lines.push(
    `| ${input.counts.error} | ${input.counts.warning} | ${input.counts.info} |`,
  );

  if (input.outsideDiff.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push(
      `<summary>⚠️ Outside diff range comments (${input.outsideDiff.length})</summary>`,
    );
    lines.push('');
    for (const od of input.outsideDiff) {
      lines.push(renderOutsideDiffEntry(od, sanitize));
      lines.push('');
    }
    lines.push('</details>');
  }

  return lines.join('\n');
}

function renderOutsideDiffEntry(
  entry: OutsideDiffFinding,
  sanitize: SanitizeFn,
): string {
  const f = entry.finding;
  const title = sanitize(f.title || '(untitled)');
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
    `**${title}** — \`${where}\``,
    '',
    message,
    `_Rule:_ \`${f.rule_id}\``,
  ].join('\n');
}

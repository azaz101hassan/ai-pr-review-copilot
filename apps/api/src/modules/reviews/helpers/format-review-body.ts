import type { Finding } from '@/modules/reviews/types/llm-reviewer';
import { sanitizeFindingMarkdown } from './sanitize-finding-markdown';

type SanitizeFn = (input: string) => string;

// Day-5 Review body assembly. Composes the self-identifying header,
// the machine-readable HTML comment marker, and each finding's
// sanitized markdown block into the single body string that the
// worker POSTs as `event=COMMENT` on the PR.
//
// Header format (literal first line):
//   **🤖 AI PR Review Copilot** — automated review (Day 5)
//
// Marker (literal second line):
//   <!-- ai-pr-review-copilot:v1:review-id={uuid} -->
//
// The marker is injected AFTER the sanitizer runs (the per-finding
// sanitization strips HTML comments), so the formatter is the only
// place that can introduce HTML into the output. The `reviewId`
// MUST match the canonical UUID regex; the formatter throws on a
// mismatch so the worker never POSTs a body with a spoofable marker
// payload (a defense even though `reviewId` is internally minted
// and never sources from attacker-controlled input today).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEVERITY_ORDER: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export interface FindingWithSeverity extends Finding {
  severity: 'error' | 'warning' | 'info';
}

export interface FormatReviewBodyInput {
  findings: FindingWithSeverity[];
  reviewId: string;
  // Optional sanitizer override — defaults to the production
  // unified+rehype-sanitize pipeline. Tests inject a synchronous
  // no-op or whitespace-trim sanitizer to exercise the formatter
  // logic without booting the ESM-only unified ecosystem under
  // jest's CJS runtime.
  sanitize?: SanitizeFn;
}

export function formatReviewBody(input: FormatReviewBodyInput): string {
  if (!UUID_RE.test(input.reviewId)) {
    throw new Error(
      `formatReviewBody: reviewId is not a canonical UUID (got "${input.reviewId}"). The HTML comment marker requires a UUID payload to keep the marker shape spoofing-resistant.`,
    );
  }

  const sanitize = input.sanitize ?? sanitizeFindingMarkdown;

  const header = '**🤖 AI PR Review Copilot** — automated review (Day 5)';
  const marker = `<!-- ai-pr-review-copilot:v1:review-id=${input.reviewId} -->`;

  if (input.findings.length === 0) {
    return [
      header,
      marker,
      '',
      '_No findings — the diff matched no team rules._',
    ].join('\n');
  }

  // Severity-then-emit-order. Stable sort preserves the model's
  // intra-severity ordering, which often reflects file proximity.
  const ordered = [...input.findings].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 99) -
      (SEVERITY_ORDER[b.severity] ?? 99),
  );

  const blocks = ordered.map((f) => {
    const titleHtml = sanitize(f.title || '(untitled)');
    const messageHtml = sanitize(
      f.message || '_(no message)_',
    );
    // Citation goes through a fenced code block so its content is
    // displayed literally without further markdown interpretation.
    // We widen to four backticks if the citation itself contains a
    // triple-backtick sequence so the fence isn't prematurely closed.
    const citation = f.citation ?? '';
    const fence = citation.includes('```') ? '````' : '```';
    const citationBlock = citation
      ? `${fence}\n${citation}\n${fence}`
      : '_(no citation)_';
    const ruleLine = `_Rule:_ \`${f.rule_id}\``;
    const sevTag = `**[${f.severity}]**`;

    return [
      `${sevTag} ${titleHtml}`,
      '',
      messageHtml,
      '',
      '_Citation:_',
      citationBlock,
      ruleLine,
    ].join('\n');
  });

  return [header, marker, '', ...interleaveSeparator(blocks)].join('\n');
}

// Inserts a blank line between each pair of adjacent blocks so the
// rendered Markdown has visible separation between findings.
function interleaveSeparator(blocks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) out.push('');
    out.push(blocks[i]);
  }
  return out;
}

// Server-presentational component: renders the reviews as a GitHub-issue-style
// vertical list. No client hooks; call site owns Suspense boundaries.
import Link from 'next/link';
import { RelativeTime } from '@/components/relative-time';
import type { ReviewListEntry, ReviewStatus } from '@/lib/api-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusDotClass(status: ReviewStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-severity-muted';
    case 'failed':
      return 'bg-severity-error';
    case 'in_progress':
      return 'bg-severity-warning';
    default:
      return 'bg-muted-foreground';
  }
}

function statusLabel(status: ReviewStatus): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'in_progress':
      return 'In progress';
    default:
      return status;
  }
}

function isDryRun(promptVersion: string): boolean {
  return promptVersion.includes('dry-run');
}

function DryRunPill() {
  return (
    <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      dry-run
    </span>
  );
}

// ---------------------------------------------------------------------------
// Row sub-components
// ---------------------------------------------------------------------------

interface ReviewRowProps {
  review: ReviewListEntry;
}

function ReviewRow({ review }: ReviewRowProps) {
  const href = `/reviews/${encodeURIComponent(review.id)}`;
  const dry = isDryRun(review.prompt_version);

  // Token total — omit entirely when both are null
  const tokenTotal =
    review.input_tokens != null && review.output_tokens != null
      ? review.input_tokens + review.output_tokens
      : null;

  // Author identifier for byline: for PR-linked reviews use author_login;
  // for standalone reviews fall back to created_by
  const bylineAuthor =
    review.pr_node_id != null
      ? (review.author_login ?? null)
      : (review.created_by ?? null);

  // Line 1 headline content
  const hasLinkedPr = review.pr_node_id != null && review.repo_full_name != null;

  return (
    <li className="group border-b border-border px-4 py-3 hover:bg-accent/30 transition-colors duration-100">
      <Link
        href={href}
        className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm"
        aria-label={
          hasLinkedPr
            ? `Review of ${review.repo_full_name} #${review.pr_number}${review.pr_title ? ': ' + review.pr_title : ''}`
            : 'Standalone review'
        }
      >
        {/* Line 1: status dot + identity + dry-run pill */}
        <div className="flex items-center gap-2 min-w-0">
          {/* Status dot — color is decorative; sr-only text carries the meaning */}
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(review.status)}`}
            aria-hidden="true"
          />
          <span className="sr-only">{statusLabel(review.status)}</span>

          {hasLinkedPr ? (
            /* PR-linked row headline */
            <span className="flex min-w-0 flex-1 items-baseline gap-2 flex-wrap">
              <span className="font-mono text-sm text-muted-foreground shrink-0">
                {review.repo_full_name}
              </span>
              <span className="font-mono text-sm text-foreground shrink-0">
                #{review.pr_number}
              </span>
              {review.pr_title && (
                <span className="truncate text-sm text-foreground">
                  {review.pr_title}
                </span>
              )}
            </span>
          ) : (
            /* Standalone row headline */
            <span className="flex-1 text-sm text-muted-foreground">
              Standalone review
            </span>
          )}

          {dry && (
            <span className="ml-auto shrink-0">
              <DryRunPill />
            </span>
          )}
        </div>

        {/* Line 2: muted byline */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 pl-[calc(0.5rem+8px)] text-xs text-muted-foreground">
          {bylineAuthor && (
            <>
              <span className="font-mono">{bylineAuthor}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <RelativeTime value={review.created_at} />
          {tokenTotal != null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{tokenTotal.toLocaleString()} tokens</span>
            </>
          )}
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

interface ReviewsListProps {
  items: ReviewListEntry[];
}

export function ReviewsList({ items }: ReviewsListProps) {
  return (
    <ul
      role="list"
      className="rounded-md border border-border"
    >
      {items.map((review) => (
        <ReviewRow key={review.id} review={review} />
      ))}
    </ul>
  );
}

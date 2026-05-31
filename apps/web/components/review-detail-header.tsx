'use client';

// PR identity header for the review detail page. Renders a GitHub-style
// header when a PR summary is available, and collapses to a minimal
// standalone-review header when pr is null (dry-run, deleted PR, etc.).
//
// This is a client component solely because the copy-UUID button needs
// useState. Everything else here is presentational.

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RelativeTime } from '@/components/relative-time';
import type { ReviewDetailRecord, ReviewDetailPrSummary } from '@/lib/api-types';

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'completed'
      ? 'secondary'
      : status === 'failed'
        ? 'destructive'
        : 'default';
  return (
    <Badge variant={variant} className="capitalize">
      {status.replace('_', ' ')}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Copyable review UUID button
// ---------------------------------------------------------------------------

function CopyUuid({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy review ID"
      className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? 'Copied' : id}
    </button>
  );
}

// ---------------------------------------------------------------------------
// External link icon (inline SVG, no icon library dependency)
// ---------------------------------------------------------------------------

function ExternalLinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReviewDetailHeaderProps {
  review: ReviewDetailRecord;
  pr: ReviewDetailPrSummary | null;
}

// ---------------------------------------------------------------------------
// PR header (pr is not null)
// ---------------------------------------------------------------------------

function PrHeader({ review, pr }: { review: ReviewDetailRecord; pr: ReviewDetailPrSummary }) {
  const ghUrl = `https://github.com/${pr.repo_full_name}/pull/${pr.number}`;

  return (
    <header className="space-y-2 pb-1 border-b border-border">
      {/* Breadcrumb-equivalent: repo path */}
      <p className="text-xs font-mono text-muted-foreground tracking-tight">
        {pr.repo_full_name}
      </p>

      {/* H1 row: PR number + title on the left, copyable UUID on the right */}
      <div className="flex items-start justify-between gap-4">
        <h1
          className="text-2xl font-semibold tracking-tight"
          style={{ textWrap: 'balance' } as React.CSSProperties}
        >
          <span className="font-mono">#{pr.number}</span>
          {' '}
          <span>{pr.title}</span>
        </h1>
        <CopyUuid id={review.id} />
      </div>

      {/* Meta strip: badge · author · relative time · prompt version · model · GitHub link */}
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <StatusBadge status={review.status} />
          <span className="select-none" aria-hidden>·</span>
          <span>
            <span className="font-mono text-foreground">{pr.author_login}</span>
            {' '}opened this PR
          </span>
          <span className="select-none" aria-hidden>·</span>
          <RelativeTime value={pr.created_at} />
          <span className="select-none" aria-hidden>·</span>
          <span className="font-mono text-xs">{review.prompt_version}</span>
          <span className="select-none" aria-hidden>·</span>
          <span className="font-mono text-xs">{review.model}</span>
        </div>

        <Button
          variant="outline"
          size="sm"
          asChild
        >
          <a href={ghUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5">
            View on GitHub
            <ExternalLinkIcon />
          </a>
        </Button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Standalone header (pr is null)
// ---------------------------------------------------------------------------

function StandaloneHeader({ review }: { review: ReviewDetailRecord }) {
  return (
    <header className="space-y-2 pb-1 border-b border-border">
      {/* H1 row: title on the left, copyable UUID on the right */}
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Standalone review
        </h1>
        <CopyUuid id={review.id} />
      </div>

      {/* Meta strip: badge · created relative time · prompt version · model */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <StatusBadge status={review.status} />
        <span className="select-none" aria-hidden>·</span>
        <span>review created</span>
        {' '}
        <RelativeTime value={review.created_at} />
        <span className="select-none" aria-hidden>·</span>
        <span className="font-mono text-xs">{review.prompt_version}</span>
        <span className="select-none" aria-hidden>·</span>
        <span className="font-mono text-xs">{review.model}</span>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export function ReviewDetailHeader({ review, pr }: ReviewDetailHeaderProps) {
  if (pr) {
    return <PrHeader review={review} pr={pr} />;
  }
  return <StandaloneHeader review={review} />;
}

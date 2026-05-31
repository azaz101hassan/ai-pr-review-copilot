// Server-presentational component: renders a single review's detail view.
// Hierarchy per design principle 4: PR/review metadata (quiet top strip) →
// findings (headline section) → retrieved chunks + token breakdown (supporting context).
//
// The API returns the detail as three siblings (review / findings /
// retrievedChunks / pr); this component takes them as separate props.
// The `pr` sibling carries PR identity (repo, number, title, author); when
// null the header collapses to standalone-review mode.
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { ReviewDetailHeader } from '@/components/review-detail-header';
import type {
  ReviewDetailRecord,
  ReviewDetailPrSummary,
  ReviewFindingRecord,
  HydratedChunk,
  SeverityLevel,
} from '@/lib/api-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Severity badge: uses severity tokens from globals.css, never raw destructive
// ---------------------------------------------------------------------------

function severityClass(level: SeverityLevel): string {
  switch (level) {
    case 'error':
      return 'border-[color:var(--severity-error)] text-[color:var(--severity-error)]';
    case 'warning':
      return 'border-[color:var(--severity-warning)] text-[color:var(--severity-warning)]';
    case 'info':
      return 'border-[color:var(--severity-info)] text-[color:var(--severity-info)]';
    default:
      return 'border-[color:var(--severity-muted)] text-[color:var(--severity-muted)]';
  }
}

function SeverityBadge({ level }: { level: SeverityLevel }) {
  return (
    <Badge
      variant="outline"
      className={`capitalize ${severityClass(level)}`}
    >
      {level}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Status badge — reuses badge component
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'completed'
      ? 'secondary'
      : status === 'failed'
        ? 'destructive'
        : 'outline';
  return (
    <Badge variant={variant} className="capitalize">
      {status.replace('_', ' ')}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Findings table (headline section)
// ---------------------------------------------------------------------------

interface FindingsTableProps {
  findings: ReviewFindingRecord[];
}

function FindingsTable({ findings }: FindingsTableProps) {
  if (findings.length === 0) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        No findings for this review.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[90px]">Severity</TableHead>
          <TableHead className="w-[140px]">Rule</TableHead>
          <TableHead>Message</TableHead>
          <TableHead className="w-[200px]">File</TableHead>
          <TableHead className="w-[80px]">Line</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map((f) => (
          <TableRow key={f.id}>
            <TableCell>
              <SeverityBadge level={f.severity} />
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs text-muted-foreground">
                {f.rule_id}
              </span>
            </TableCell>
            <TableCell>
              <span className="text-sm text-foreground">{f.message}</span>
            </TableCell>
            <TableCell>
              {f.file_path ? (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {f.file_path}
                </span>
              ) : (
                <span className="text-muted-foreground/40" aria-hidden>
                  &mdash;
                </span>
              )}
            </TableCell>
            <TableCell>
              {f.line_start != null ? (
                <span className="tabular-nums text-xs text-muted-foreground">
                  {f.line_start}
                  {f.line_end != null && f.line_end !== f.line_start
                    ? `–${f.line_end}`
                    : ''}
                </span>
              ) : (
                <span className="text-muted-foreground/40" aria-hidden>
                  &mdash;
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Retrieved chunks list (supporting context)
// HydratedChunk is a discriminated union: { missing: false, title, body, ... }
// or { missing: true, id }.
// ---------------------------------------------------------------------------

interface ChunkCardProps {
  chunk: HydratedChunk;
}

function ChunkCard({ chunk }: ChunkCardProps) {
  if (chunk.missing) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">
          Knowledge source removed
        </p>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground/60">
          {chunk.id}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
        <span className="font-mono text-[11px] font-medium text-foreground">
          {chunk.rule_id}
        </span>
        <span className="text-xs text-muted-foreground">{chunk.title}</span>
        <span className="font-mono text-[11px] text-muted-foreground/70">
          {chunk.source_id}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">
        {chunk.body}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token breakdown (supporting context — quieter, smaller)
// Uses the raw Anthropic-named token columns from the review row.
// ---------------------------------------------------------------------------

interface TokenBreakdownProps {
  review: ReviewDetailRecord;
}

function TokenBreakdown({ review }: TokenBreakdownProps) {
  const duration =
    review.completed_at != null
      ? new Date(review.completed_at).getTime() -
        new Date(review.created_at).getTime()
      : null;

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
      <div>
        <dt className="text-muted-foreground">Input tokens</dt>
        <dd className="tabular-nums text-foreground">
          {review.input_tokens != null ? (
            review.input_tokens.toLocaleString()
          ) : (
            <span className="text-muted-foreground/40">&mdash;</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Output tokens</dt>
        <dd className="tabular-nums text-foreground">
          {review.output_tokens != null ? (
            review.output_tokens.toLocaleString()
          ) : (
            <span className="text-muted-foreground/40">&mdash;</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Cache write</dt>
        <dd className="tabular-nums text-foreground">
          {review.cache_creation_input_tokens != null ? (
            review.cache_creation_input_tokens.toLocaleString()
          ) : (
            <span className="text-muted-foreground/40">&mdash;</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Cache read</dt>
        <dd className="tabular-nums text-foreground">
          {review.cache_read_input_tokens != null ? (
            review.cache_read_input_tokens.toLocaleString()
          ) : (
            <span className="text-muted-foreground/40">&mdash;</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Turns</dt>
        <dd className="tabular-nums text-foreground">{review.turn_count}</dd>
      </div>
      {duration != null && (
        <div>
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="tabular-nums text-foreground">
            {formatMs(duration)}
          </dd>
        </div>
      )}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface ReviewDetailProps {
  review: ReviewDetailRecord;
  findings: ReviewFindingRecord[];
  retrievedChunks: HydratedChunk[];
  pr: ReviewDetailPrSummary | null;
}

export function ReviewDetail({
  review,
  findings,
  retrievedChunks,
  pr,
}: ReviewDetailProps) {
  const hasChunks = retrievedChunks.length > 0;

  return (
    <article className="space-y-8">
      {/* PR identity header — anchors the page in GitHub context */}
      <ReviewDetailHeader review={review} pr={pr} />

      <Separator />

      {/* Findings — headline section, most important */}
      <section aria-labelledby="findings-heading">
        <h2
          id="findings-heading"
          className="mb-4 text-base font-semibold text-foreground"
        >
          Findings
          {findings.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({findings.length})
            </span>
          )}
        </h2>
        <FindingsTable findings={findings} />
      </section>

      <Separator />

      {/* Retrieved chunks + token breakdown — supporting context */}
      <section aria-labelledby="context-heading">
        <h2
          id="context-heading"
          className="mb-4 text-base font-semibold text-foreground"
        >
          Knowledge context
          {hasChunks && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({retrievedChunks.length} chunk
              {retrievedChunks.length !== 1 ? 's' : ''})
            </span>
          )}
        </h2>
        {hasChunks ? (
          <div className="flex flex-col gap-2">
            {retrievedChunks.map((chunk, i) => (
              <ChunkCard key={chunk.id ?? i} chunk={chunk} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No knowledge chunks retrieved for this review.
          </p>
        )}
      </section>

      <Separator />

      {/* Token + performance breakdown */}
      <section aria-labelledby="tokens-heading">
        <h2
          id="tokens-heading"
          className="mb-4 text-sm font-medium text-muted-foreground"
        >
          Token usage
        </h2>
        <TokenBreakdown review={review} />
      </section>
    </article>
  );
}

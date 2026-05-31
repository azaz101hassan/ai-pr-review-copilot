// Server-presentational component: renders a single review's detail view.
// Hierarchy per design principle 4: PR metadata (quiet top strip) →
// findings (headline section) → retrieved chunks + token breakdown (supporting context).
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
import type {
  ReviewDetailItem,
  ReviewFindingSummary,
  RetrievedChunk,
  SeverityLevel,
} from '@/lib/api-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(epochMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}

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
// PR metadata strip (quiet — muted foreground, compact)
// ---------------------------------------------------------------------------

interface MetaStripProps {
  review: ReviewDetailItem;
}

function MetaStrip({ review }: MetaStripProps) {
  const hasNoId = review.pr_node_id == null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm text-muted-foreground">
      <span>
        Review{' '}
        <span className="tabular-nums text-foreground">#{review.id}</span>
      </span>
      {hasNoId ? (
        <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          dry-run
        </span>
      ) : (
        <>
          {review.repo_full_name && (
            <span className="font-mono text-xs">{review.repo_full_name}</span>
          )}
          {review.pr_number != null && (
            <span>
              PR{' '}
              <span className="tabular-nums text-foreground">
                #{review.pr_number}
              </span>
            </span>
          )}
          {review.author_login && (
            <span>
              by{' '}
              <span className="text-foreground">{review.author_login}</span>
            </span>
          )}
        </>
      )}
      <span>
        <time dateTime={new Date(review.created_at).toISOString()}>
          {formatDate(review.created_at)}
        </time>
      </span>
      {review.prompt_version && (
        <span className="font-mono text-xs">{review.prompt_version}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR title (visible only when present)
// ---------------------------------------------------------------------------

function PrTitle({ title }: { title: string | null }) {
  if (!title) return null;
  return (
    <h1 className="text-xl font-semibold text-foreground" style={{ textWrap: 'balance' }}>
      {title}
    </h1>
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
      {status}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Findings table (headline section)
// ---------------------------------------------------------------------------

interface FindingsTableProps {
  findings: ReviewFindingSummary[];
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
// ---------------------------------------------------------------------------

interface ChunkCardProps {
  chunk: RetrievedChunk;
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
        {chunk.rule_id && (
          <span className="font-mono text-[11px] font-medium text-foreground">
            {chunk.rule_id}
          </span>
        )}
        {chunk.source_path && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {chunk.source_path}
          </span>
        )}
      </div>
      {chunk.text_preview && (
        <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">
          {chunk.text_preview}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token breakdown (supporting context — quieter, smaller)
// ---------------------------------------------------------------------------

interface TokenBreakdownProps {
  review: ReviewDetailItem;
}

function TokenBreakdown({ review }: TokenBreakdownProps) {
  const hasTokens =
    review.total_input_tokens != null || review.total_output_tokens != null;

  const duration =
    review.completed_at != null
      ? review.completed_at - review.created_at
      : null;

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
      <div>
        <dt className="text-muted-foreground">Input tokens</dt>
        <dd className="tabular-nums text-foreground">
          {hasTokens && review.total_input_tokens != null
            ? review.total_input_tokens.toLocaleString()
            : <span className="text-muted-foreground/40">&mdash;</span>}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Output tokens</dt>
        <dd className="tabular-nums text-foreground">
          {hasTokens && review.total_output_tokens != null
            ? review.total_output_tokens.toLocaleString()
            : <span className="text-muted-foreground/40">&mdash;</span>}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Cached input</dt>
        <dd className="tabular-nums text-foreground">
          {review.cached_input_tokens != null
            ? review.cached_input_tokens.toLocaleString()
            : <span className="text-muted-foreground/40">&mdash;</span>}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Turns</dt>
        <dd className="tabular-nums text-foreground">
          {review.turn_count ?? <span className="text-muted-foreground/40">&mdash;</span>}
        </dd>
      </div>
      {duration != null && (
        <div>
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="tabular-nums text-foreground">{formatMs(duration)}</dd>
        </div>
      )}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface ReviewDetailProps {
  review: ReviewDetailItem;
}

export function ReviewDetail({ review }: ReviewDetailProps) {
  const hasChunks = review.retrieved_chunks.length > 0;

  return (
    <article className="space-y-8">
      {/* PR metadata strip — quiet, contextual */}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={review.status} />
          <MetaStrip review={review} />
        </div>
        <PrTitle title={review.pr_title} />
      </header>

      <Separator />

      {/* Findings — headline section, most important */}
      <section aria-labelledby="findings-heading">
        <h2
          id="findings-heading"
          className="mb-4 text-base font-semibold text-foreground"
        >
          Findings
          {review.findings.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({review.findings.length})
            </span>
          )}
        </h2>
        <FindingsTable findings={review.findings} />
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
              ({review.retrieved_chunks.length} chunk
              {review.retrieved_chunks.length !== 1 ? 's' : ''})
            </span>
          )}
        </h2>
        {hasChunks ? (
          <div className="flex flex-col gap-2">
            {review.retrieved_chunks.map((chunk, i) => (
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

// Server-presentational component: renders the reviews list table.
// No client hooks; call site owns Suspense boundaries.
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import type { ReviewListItem, ReviewStatus } from '@/lib/api-types';

function statusVariant(
  status: ReviewStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed':
      return 'secondary';
    case 'failed':
      return 'destructive';
    case 'in_progress':
      return 'default';
    default:
      return 'outline';
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
    case 'pending':
      return 'Pending';
    default:
      return status;
  }
}

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

function DryRunPill() {
  return (
    <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      dry-run
    </span>
  );
}

interface ReviewsTableProps {
  items: ReviewListItem[];
}

export function ReviewsTable({ items }: ReviewsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[90px]">Status</TableHead>
          <TableHead>Repository</TableHead>
          <TableHead className="w-[60px]">PR</TableHead>
          <TableHead>Title</TableHead>
          <TableHead className="w-[120px]">Author</TableHead>
          <TableHead className="w-[160px]">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              <Badge variant={statusVariant(item.status)}>
                {statusLabel(item.status)}
              </Badge>
            </TableCell>
            <TableCell>
              {item.repo_full_name ? (
                <span className="font-mono text-xs text-foreground">
                  {item.repo_full_name}
                </span>
              ) : (
                <DryRunPill />
              )}
            </TableCell>
            <TableCell>
              {item.pr_number != null ? (
                <span className="tabular-nums text-muted-foreground">
                  #{item.pr_number}
                </span>
              ) : (
                <span className="text-muted-foreground/40" aria-hidden>
                  &mdash;
                </span>
              )}
            </TableCell>
            <TableCell>
              <Link
                href={`/reviews/${item.id}`}
                className="line-clamp-1 text-foreground underline-offset-2 hover:underline focus-visible:underline"
              >
                {item.pr_title ?? (
                  <span className="italic text-muted-foreground">
                    No title
                  </span>
                )}
              </Link>
            </TableCell>
            <TableCell>
              <span className="text-sm text-muted-foreground">
                {item.author_login ?? (
                  <span className="text-muted-foreground/40" aria-hidden>
                    &mdash;
                  </span>
                )}
              </span>
            </TableCell>
            <TableCell>
              <time
                dateTime={new Date(item.created_at).toISOString()}
                className="text-xs tabular-nums text-muted-foreground"
              >
                {formatDate(item.created_at)}
              </time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

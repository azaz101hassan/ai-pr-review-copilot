'use client';

// PaginationControls bumps ?offset=N via router.push.
// IMPORTANT: This component itself does NOT include a <Suspense> wrapper.
// Every call site MUST wrap this in <Suspense> — next build enforces this.
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';

interface PaginationControlsProps {
  offset: number;
  limit: number;
  total: number;
}

export function PaginationControls({
  offset,
  limit,
  total,
}: PaginationControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  function navigate(newOffset: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (newOffset === 0) {
      params.delete('offset');
    } else {
      params.set('offset', String(newOffset));
    }
    startTransition(() => {
      router.push(`?${params.toString()}`);
    });
  }

  if (total <= limit) return null;

  return (
    <nav
      className="flex items-center justify-between"
      aria-label="Pagination"
    >
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Showing {offset + 1}&ndash;{Math.min(offset + limit, total)} of{' '}
        {total}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(prevOffset)}
          disabled={!hasPrev || isPending}
          aria-label="Previous page"
        >
          Previous
        </Button>
        <span className="text-sm tabular-nums text-muted-foreground">
          {currentPage} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(nextOffset)}
          disabled={!hasNext || isPending}
          aria-label="Next page"
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

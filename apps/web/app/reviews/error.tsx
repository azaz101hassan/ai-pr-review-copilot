'use client';

// Error boundary for the reviews list page.
// Catches API failures (5xx, network errors). 404s land in not-found.tsx.
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

interface ReviewsErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ReviewsError({ error, reset }: ReviewsErrorProps) {
  useEffect(() => {
    console.error('[reviews] page error:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <p className="text-base font-medium text-foreground">
        Couldn&apos;t load reviews.
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        The API may be unavailable. Run{' '}
        <code className="rounded bg-muted px-1 font-mono text-xs">
          npm run dev
        </code>{' '}
        from the repo root and refresh.
      </p>
      <Button variant="outline" size="sm" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}

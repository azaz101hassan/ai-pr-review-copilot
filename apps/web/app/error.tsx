'use client';

// Root-level error boundary. Catches total failures (both analytics and
// filters throw). Renders an honest failure surface per design principle 5.
import { useEffect } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface AnalyticsErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AnalyticsError({
  error,
  reset,
}: AnalyticsErrorProps) {
  useEffect(() => {
    console.error('[analytics] page error:', error);
  }, [error]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Analytics
        </h1>
      </header>

      <Alert>
        <AlertDescription className="space-y-3">
          <p className="text-sm text-foreground">
            Could not load analytics. The API may be down.
          </p>
          <p className="text-sm text-muted-foreground">
            Run{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              npm run dev
            </code>{' '}
            from the repo root, then retry.
          </p>
          <Button variant="outline" size="sm" onClick={reset}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

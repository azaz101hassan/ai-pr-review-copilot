'use client';

// Error boundary for the settings page.
import { useEffect } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface SettingsErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function SettingsError({
  error,
  reset,
}: SettingsErrorProps) {
  useEffect(() => {
    console.error('[settings] page error:', error);
  }, [error]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Settings
        </h1>
      </header>

      <Alert>
        <AlertDescription className="space-y-3">
          <p className="text-sm text-foreground">
            Could not load settings. The API may be down.
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

'use client';

// FilterBar reads URL search params and updates them on change.
// IMPORTANT: This component itself does NOT include a <Suspense> wrapper.
// Every call site that renders <FilterBar> MUST wrap it in <Suspense>
// (next build enforces this — next dev lets it pass silently).
// See: https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout
import { useSearchParams, useRouter } from 'next/navigation';
import { useTransition, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';

export interface FilterBarProps {
  repos?: string[];
  authors?: string[];
  className?: string;
}

export function FilterBar({ repos = [], authors = [], className }: FilterBarProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Track the last changed control so we can restore focus after navigation.
  const lastChangedRef = useRef<HTMLSelectElement | HTMLInputElement | null>(null);

  // Restore focus to the changed control after searchParams settle.
  useEffect(() => {
    if (lastChangedRef.current) {
      lastChangedRef.current.focus();
    }
  }, [searchParams]);

  const updateParam = useCallback(
    (key: string, value: string, el: HTMLSelectElement | HTMLInputElement) => {
      lastChangedRef.current = el;
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      // Reset offset to 0 whenever a filter changes.
      params.delete('offset');
      startTransition(() => {
        router.push(`?${params.toString()}`);
      });
    },
    [searchParams, router],
  );

  return (
    <div
      className={cn('flex flex-wrap items-center gap-2', className)}
      aria-label="Filter controls"
    >
      {/* Repo filter */}
      {repos.length > 0 ? (
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={searchParams.get('repo') ?? ''}
          onChange={(e) => updateParam('repo', e.target.value, e.currentTarget)}
          aria-label="Filter by repository"
        >
          <option value="">All repos</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="h-8 w-48 rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Repository…"
          defaultValue={searchParams.get('repo') ?? ''}
          onBlur={(e) => updateParam('repo', e.target.value, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              updateParam('repo', e.currentTarget.value, e.currentTarget);
            }
          }}
          aria-label="Filter by repository"
        />
      )}

      {/* Author filter */}
      {authors.length > 0 ? (
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={searchParams.get('author') ?? ''}
          onChange={(e) =>
            updateParam('author', e.target.value, e.currentTarget)
          }
          aria-label="Filter by author"
        >
          <option value="">All authors</option>
          {authors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Author…"
          defaultValue={searchParams.get('author') ?? ''}
          onBlur={(e) => updateParam('author', e.target.value, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              updateParam('author', e.currentTarget.value, e.currentTarget);
            }
          }}
          aria-label="Filter by author"
        />
      )}

      {/* Pending indicator — visible while Next.js refetches the Server Component */}
      {isPending && (
        <span className="text-xs text-muted-foreground" aria-live="polite">
          Loading…
        </span>
      )}
    </div>
  );
}

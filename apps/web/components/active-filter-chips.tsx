'use client';

// Active-filter chip strip. Reads the URL search params, renders a chip
// per active filter (currently `repo` and `author`), and removes the
// matching key when the chip's × is clicked. Other params are preserved
// (including `offset`, which gets reset since the result set changes).
//
// Renders nothing when no chips are active so the page doesn't reserve
// vertical space for an empty strip.

import { useSearchParams, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from '@/lib/utils';

const FILTER_KEYS = [
  { key: 'repo', label: 'repo' },
  { key: 'author', label: 'author' },
] as const;

interface ActiveFilterChipsProps {
  className?: string;
}

export function ActiveFilterChips({ className }: ActiveFilterChipsProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const active = FILTER_KEYS.flatMap(({ key, label }) => {
    const value = searchParams.get(key);
    return value ? [{ key, label, value }] : [];
  });

  if (active.length === 0) return null;

  function clear(key: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(key);
    params.delete('offset');
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `?${qs}` : '?');
    });
  }

  function clearAll() {
    startTransition(() => {
      router.push('?');
    });
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 text-xs',
        isPending && 'opacity-60',
        className,
      )}
      aria-label="Active filters"
    >
      {active.map(({ key, label, value }) => (
        <button
          key={key}
          type="button"
          onClick={() => clear(key)}
          className="group inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-muted-foreground transition-colors hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-label={`Clear ${label} filter: ${value}`}
        >
          <span className="font-mono">{label}:</span>
          <span className="font-mono text-foreground">{value}</span>
          <span
            aria-hidden="true"
            className="text-muted-foreground group-hover:text-foreground"
          >
            ×
          </span>
        </button>
      ))}
      {active.length > 1 && (
        <button
          type="button"
          onClick={clearAll}
          className="ml-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

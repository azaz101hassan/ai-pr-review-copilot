'use client';

// SSE connection-state indicator. Shows "Live", "Reconnecting", or
// "Live updates unavailable" based on EventSource readyState + cap flag.
// role="status" + aria-live="polite" per PRODUCT.md accessibility section.
import { cn } from '@/lib/utils';

export type SseState = 'live' | 'reconnecting' | 'unavailable';

interface SseStatusBadgeProps {
  state: SseState;
  className?: string;
}

// Visual dot colors paired with text labels — color is never the only signal.
const stateConfig: Record<
  SseState,
  { dot: string; label: string; textClass: string }
> = {
  live: {
    dot: 'bg-[var(--severity-info)]',
    label: 'Live',
    textClass: 'text-muted-foreground',
  },
  reconnecting: {
    dot: 'bg-[var(--severity-warning)]',
    label: 'Reconnecting',
    textClass: 'text-muted-foreground',
  },
  unavailable: {
    dot: 'bg-[var(--severity-muted)]',
    label: 'Live updates unavailable',
    textClass: 'text-muted-foreground',
  },
};

export function SseStatusBadge({ state, className }: SseStatusBadgeProps) {
  const { dot, label, textClass } = stateConfig[state];

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        textClass,
        className,
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', dot)}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

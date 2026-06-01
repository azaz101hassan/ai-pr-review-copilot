'use client';

import { useEffect, useReducer } from 'react';
import { formatAbsolute, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

interface RelativeTimeProps {
  // ISO 8601 string or epoch ms. Matches what the API ships.
  value: string | number;
  className?: string;
}

// Shared minute tick. One module-level setInterval drives every
// <RelativeTime> instance instead of N timers (a 50-row reviews list
// previously ran 50 separate setIntervals). The timer is created on
// the first subscriber and torn down when the last one unmounts, so
// the cost is zero when the surface has no relative timestamps.
const TICK_INTERVAL_MS = 60_000;
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function subscribeTick(cb: () => void): () => void {
  tickListeners.add(cb);
  if (tickTimer === null) {
    tickTimer = setInterval(() => {
      for (const listener of tickListeners) listener();
    }, TICK_INTERVAL_MS);
  }
  return () => {
    tickListeners.delete(cb);
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

// Renders a relative timestamp ("3 hours ago") with the absolute time
// in a tooltip. Mirrors GitHub's <time> element pattern: relative
// primary text, absolute on hover, ISO in `dateTime` for screen
// readers and copy-paste.
//
// Client component because the relative text depends on the current
// clock; computing at SSR would freeze the value at request time and
// drift visibly under live SSE updates.
export function RelativeTime({ value, className }: RelativeTimeProps) {
  // Force a re-render whenever the shared tick fires. The actual
  // relative-string computation happens inline below, so it always
  // sees the latest `value` prop.
  const [, forceTick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    return subscribeTick(forceTick);
  }, []);

  const iso = typeof value === 'string' ? value : new Date(value).toISOString();
  const absolute = formatAbsolute(value);
  const text = formatRelative(value);

  return (
    <time dateTime={iso} title={absolute} className={cn('tabular-nums', className)}>
      {text}
    </time>
  );
}

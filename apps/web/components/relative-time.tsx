'use client';

import { useEffect, useState } from 'react';
import { formatAbsolute, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

interface RelativeTimeProps {
  // ISO 8601 string or epoch ms. Matches what the API ships.
  value: string | number;
  className?: string;
  // Live-update interval. Default 60s — every minute is enough for the
  // dashboard's read cadence and stays under the SSE pulse rate.
  updateIntervalMs?: number;
}

// Renders a relative timestamp ("3 hours ago") with the absolute time
// in a tooltip. Mirrors GitHub's <time> element pattern: relative
// primary text, absolute on hover, ISO in `dateTime` for screen
// readers and copy-paste.
//
// Client component because the relative text depends on the current
// clock; computing at SSR would freeze the value at request time and
// drift visibly under live SSE updates.
export function RelativeTime({ value, className, updateIntervalMs = 60_000 }: RelativeTimeProps) {
  const [text, setText] = useState(() => formatRelative(value));

  useEffect(() => {
    setText(formatRelative(value));
    const id = setInterval(() => setText(formatRelative(value)), updateIntervalMs);
    return () => clearInterval(id);
  }, [value, updateIntervalMs]);

  const iso = typeof value === 'string' ? value : new Date(value).toISOString();
  const absolute = formatAbsolute(value);

  return (
    <time dateTime={iso} title={absolute} className={cn('tabular-nums', className)}>
      {text}
    </time>
  );
}

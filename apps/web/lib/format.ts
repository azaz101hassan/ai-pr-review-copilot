// Shared formatting helpers. Consolidates the inline formatDate that used
// to live in reviews-table.tsx and review-detail.tsx. Date inputs accept
// either an ISO 8601 string (Drizzle timestamp_ms → JSON.stringify shape)
// or an epoch-ms number.

const ABS_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const REL_FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// Absolute, deterministic. Same shape used everywhere a fixed timestamp
// is appropriate (CSV exports, tooltips, copy-paste handoffs).
export function formatAbsolute(input: string | number): string {
  return ABS_FORMAT.format(new Date(input));
}

// Relative to "now," with the same grain GitHub uses: seconds, minutes,
// hours, days, weeks, then absolute for anything older than ~30 days.
// Returns "just now" inside ±5s of now (avoids stutter on freshly-arrived
// SSE events). Past values render as "5 minutes ago"; future values
// (clock skew) render as "in 5 minutes" via Intl's numeric: auto.
export function formatRelative(input: string | number, now: Date = new Date()): string {
  const ts = new Date(input).getTime();
  const nowMs = now.getTime();
  const deltaSeconds = Math.round((ts - nowMs) / 1000);
  const abs = Math.abs(deltaSeconds);

  if (abs < 5) return 'just now';
  if (abs < 60) return REL_FORMAT.format(deltaSeconds, 'second');
  if (abs < 60 * 60) return REL_FORMAT.format(Math.round(deltaSeconds / 60), 'minute');
  if (abs < 60 * 60 * 24) return REL_FORMAT.format(Math.round(deltaSeconds / 3600), 'hour');
  if (abs < 60 * 60 * 24 * 7) return REL_FORMAT.format(Math.round(deltaSeconds / 86400), 'day');
  if (abs < 60 * 60 * 24 * 30) return REL_FORMAT.format(Math.round(deltaSeconds / (86400 * 7)), 'week');

  // Older than ~30 days: drop to absolute. Relative reads ("5 months ago")
  // are less useful than the exact date for an audit-style dashboard.
  return formatAbsolute(input);
}

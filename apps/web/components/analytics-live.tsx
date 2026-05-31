'use client';

// Client Component: subscribes to the SSE stream at /api/dashboard/events
// and applies terminal-event deltas to the analytics tile state.
//
// Design invariants:
//   - Stale-closure guard: the current filter spec lives in a useRef so
//     the onmessage handler always sees the latest filter without needing
//     a dependency-array re-register.
//   - Hold-stale on reconnect: tiles keep their last-good values during the
//     refetch triggered by EventSource.onopen after a prior disconnect.
//   - Cap-reached: addEventListener('cap-reached') closes the source and
//     flips capReached state; no reconnect loop after that.
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { AnalyticsTiles } from '@/components/analytics-tiles';
import { SseStatusBadge, type SseState } from '@/components/sse-status-badge';
import type {
  AnalyticsResponse,
  TerminalReviewEvent,
} from '@/lib/api-types';

interface AnalyticsLiveProps {
  initialAggregate: AnalyticsResponse;
  /** A pre-built query string (without the leading '?') derived from
   *  server searchParams. The EventSource always connects to /api/dashboard/events
   *  (broadcast); this value is used for client-side event filtering only. */
  filterQuery: string;
  /** Slot for the filter bar — rendered above the tiles. The Server
   *  Component passes it in so it doesn't need to be re-fetched client-side. */
  filterBarSlot?: ReactNode;
}

// Fetch a fresh analytics snapshot with the current filter and return it.
// Returns null on any failure so tiles can keep showing stale data.
async function fetchLatestAggregate(
  filterQuery: string,
): Promise<AnalyticsResponse | null> {
  try {
    const qs = filterQuery ? `?${filterQuery}` : '';
    const res = await fetch(`/api/dashboard/analytics${qs}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as AnalyticsResponse;
  } catch {
    return null;
  }
}

// Produce a shallow clone of the aggregate with SSE event deltas applied.
// Volume isn't stored explicitly — it's derived from statusBreakdown — so
// incrementing the right status bucket is all we need.
function applyDelta(
  agg: AnalyticsResponse,
  ev: TerminalReviewEvent,
): AnalyticsResponse {
  const tokenDelta = ev.token_totals;
  return {
    ...agg,
    statusBreakdown: {
      ...agg.statusBreakdown,
      completed:
        ev.status === 'completed'
          ? agg.statusBreakdown.completed + 1
          : agg.statusBreakdown.completed,
      failed:
        ev.status === 'failed'
          ? agg.statusBreakdown.failed + 1
          : agg.statusBreakdown.failed,
    },
    severityRollup: {
      error: agg.severityRollup.error + (ev.finding_counts?.error ?? 0),
      warning: agg.severityRollup.warning + (ev.finding_counts?.warning ?? 0),
      info: agg.severityRollup.info + (ev.finding_counts?.info ?? 0),
    },
    // Token totals: accumulate when the event carries token data.
    tokenTotals: tokenDelta
      ? {
          input_tokens: agg.tokenTotals.input_tokens + tokenDelta.input_tokens,
          output_tokens:
            agg.tokenTotals.output_tokens + tokenDelta.output_tokens,
          cache_creation_input_tokens:
            agg.tokenTotals.cache_creation_input_tokens +
            (tokenDelta.cache_creation_input_tokens ?? 0),
          cache_read_input_tokens:
            agg.tokenTotals.cache_read_input_tokens +
            (tokenDelta.cache_read_input_tokens ?? 0),
        }
      : agg.tokenTotals,
    // topRules and latency require re-fetch to stay accurate; leave them.
    topRules: agg.topRules,
    latency: agg.latency,
  };
}

// Parse the filter query string into key → value pairs for matching.
function parseFilter(
  query: string,
): { repo?: string; author?: string; prNodeId?: string } {
  const params = new URLSearchParams(query);
  return {
    repo: params.get('repo') ?? undefined,
    author: params.get('author') ?? undefined,
    prNodeId: params.get('pr_node_id') ?? undefined,
  };
}

// Return true when the event matches the current filter spec.
function eventMatchesFilter(
  ev: TerminalReviewEvent,
  filter: ReturnType<typeof parseFilter>,
): boolean {
  if (filter.repo && ev.repo_full_name !== filter.repo) return false;
  if (filter.author && ev.author_login !== filter.author) return false;
  if (filter.prNodeId && ev.pr_node_id !== filter.prNodeId) return false;
  return true;
}

export function AnalyticsLive({
  initialAggregate,
  filterQuery,
  filterBarSlot,
}: AnalyticsLiveProps) {
  const searchParams = useSearchParams();
  const [aggregate, setAggregate] =
    useState<AnalyticsResponse>(initialAggregate);
  const [sseState, setSseState] = useState<SseState>('live');
  const [capReached, setCapReached] = useState(false);

  // Stale-closure guard: always read the current filter from a ref inside
  // the onmessage handler instead of capturing from the enclosing scope.
  const filterRef = useRef<string>(filterQuery);

  // Track whether we've ever had a connection to differentiate "first open"
  // from "reconnect after disconnect."
  const wasDisconnectedRef = useRef(false);

  // Keep a ref to the EventSource so we can close it in cleanup.
  const esRef = useRef<EventSource | null>(null);

  // Synchronise the filter ref when the URL changes.
  useEffect(() => {
    filterRef.current = searchParams.toString();
  }, [searchParams]);

  const onOpen = useCallback(async () => {
    if (wasDisconnectedRef.current) {
      // Reconnected after a prior disconnect: refetch analytics snapshot.
      // Tiles hold stale data until the fetch completes.
      const fresh = await fetchLatestAggregate(filterRef.current);
      if (fresh) {
        setAggregate(fresh);
      }
    }
    setSseState('live');
    wasDisconnectedRef.current = false;
  }, []);

  const onError = useCallback(() => {
    setSseState('reconnecting');
    wasDisconnectedRef.current = true;
  }, []);

  const onMessage = useCallback((ev: MessageEvent) => {
    if (!ev.data) return;
    let parsed: TerminalReviewEvent;
    try {
      parsed = JSON.parse(ev.data as string) as TerminalReviewEvent;
    } catch {
      return;
    }
    // AE2: discard events that don't match the current filter.
    const filter = parseFilter(filterRef.current);
    if (!eventMatchesFilter(parsed, filter)) return;
    setAggregate((prev) => applyDelta(prev, parsed));
  }, []);

  const onCapReached = useCallback(() => {
    esRef.current?.close();
    setCapReached(true);
    setSseState('unavailable');
  }, []);

  useEffect(() => {
    if (capReached) return; // Don't open a new connection after cap.

    const es = new EventSource('/api/dashboard/events');
    esRef.current = es;

    es.onopen = onOpen;
    es.onerror = onError;
    es.onmessage = onMessage;
    es.addEventListener('cap-reached', onCapReached);

    return () => {
      es.onopen = null;
      es.onerror = null;
      es.onmessage = null;
      es.removeEventListener('cap-reached', onCapReached);
      es.close();
      esRef.current = null;
    };
  }, [capReached, onOpen, onError, onMessage, onCapReached]);

  return (
    <div className="space-y-6">
      {/* Filter bar + SSE status badge row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex-1">{filterBarSlot}</div>
        <SseStatusBadge state={sseState} />
      </div>

      {/* Tile grid — receives the live-updated aggregate */}
      <AnalyticsTiles data={aggregate} />
    </div>
  );
}

// Analytics page — Server Component.
// Fetches /analytics and /filters in parallel, renders the tile hierarchy
// plus the client-side SSE subscriber (<AnalyticsLive>).
//
// Tile hierarchy (deliberate, per design principle 4):
//   Primary row  — Volume + Severity rollup (headline, readable at a glance)
//   Secondary row — Latency p50/p95 + Token cost (calmer, smaller, below)
//   Supporting list — Top-N rules table (context, full-width)
import { Suspense } from 'react';
import { fetchDashboard, toURLSearchParams } from '@/lib/api';
import { FilterBar } from '@/components/filter-bar';
import { AnalyticsTiles } from '@/components/analytics-tiles';
import { AnalyticsLive } from '@/components/analytics-live';
import { EmptyState } from '@/components/empty-state';
import type { AnalyticsResponse, FilterOptionsResponse } from '@/lib/api-types';

interface AnalyticsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function scalar(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

// Zero-valued aggregate for total-failure fallback rendering.
const ZERO_AGGREGATE: AnalyticsResponse = {
  volume: 0,
  status_breakdown: { completed: 0, failed: 0, pending: 0, in_progress: 0 },
  severity_rollup: { error: 0, warning: 0, info: 0 },
  top_rules: [],
  latency: { p50: null, p95: null },
  token_totals: {
    total_input_tokens: 0,
    total_output_tokens: 0,
    cached_input_tokens: 0,
  },
};

export default async function AnalyticsPage({
  searchParams,
}: AnalyticsPageProps) {
  const params = await searchParams;

  const repo = scalar(params.repo);
  const author = scalar(params.author);

  const hasActiveFilter = Boolean(repo || author);

  const queryParams = toURLSearchParams({
    ...(repo ? { repo } : {}),
    ...(author ? { author } : {}),
  });

  // Fetch analytics + filter options in parallel; filters are best-effort.
  const [analyticsResult, filterResult] = await Promise.allSettled([
    fetchDashboard<AnalyticsResponse>('/analytics', queryParams),
    fetchDashboard<FilterOptionsResponse>('/filters'),
  ]);

  const aggregate: AnalyticsResponse =
    analyticsResult.status === 'fulfilled'
      ? analyticsResult.value
      : ZERO_AGGREGATE;

  const filtersFailed = filterResult.status === 'rejected';
  const repos = filterResult.status === 'fulfilled' ? filterResult.value.repos : [];
  const authors =
    filterResult.status === 'fulfilled' ? filterResult.value.authors : [];

  // Build the filter query string (without leading '?') for the SSE client.
  const filterQuery = queryParams.toString();

  const showEmpty = aggregate.volume === 0;

  return (
    <div className="space-y-8">
      {/* Page heading */}
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Analytics
        </h1>
        <p className="text-sm text-muted-foreground">
          Review pipeline at a glance.
        </p>
      </header>

      {showEmpty ? (
        <>
          {/* Filter bar still renders even in the empty state */}
          {!filtersFailed && (
            <Suspense fallback={<div className="h-8" />}>
              <FilterBar repos={repos} authors={authors} />
            </Suspense>
          )}
          {filtersFailed && (
            <p className="text-sm text-muted-foreground">
              Filter options unavailable. Refresh to retry.
            </p>
          )}

          {hasActiveFilter ? (
            <EmptyState
              title="No reviews match these filters."
              description="Try clearing the filters or selecting a different repository or author."
            />
          ) : (
            <EmptyState
              title="No reviews yet."
              description={
                <>
                  Run{' '}
                  <code className="rounded bg-muted px-1 font-mono text-xs">
                    npm run seed:dev
                  </code>{' '}
                  from{' '}
                  <code className="rounded bg-muted px-1 font-mono text-xs">
                    apps/api
                  </code>{' '}
                  to populate the database with sample data.
                </>
              }
            />
          )}
        </>
      ) : (
        // AnalyticsLive is a Client Component that:
        //   - Renders the filter bar (passed as a slot to avoid prop-drilling)
        //   - Subscribes to SSE and applies event deltas to tile state
        //   - Shows the SseStatusBadge
        // The <Suspense> wrapper is required because AnalyticsLive uses
        // useSearchParams internally (via the filter bar slot).
        <Suspense fallback={<AnalyticsTiles data={aggregate} />}>
          <AnalyticsLive
            initialAggregate={aggregate}
            filterQuery={filterQuery}
            filterBarSlot={
              filtersFailed ? (
                <p className="text-sm text-muted-foreground">
                  Filter options unavailable. Refresh to retry.
                </p>
              ) : (
                <Suspense fallback={<div className="h-8" />}>
                  <FilterBar repos={repos} authors={authors} />
                </Suspense>
              )
            }
          />
        </Suspense>
      )}
    </div>
  );
}

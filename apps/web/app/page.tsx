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
import { ActiveFilterChips } from '@/components/active-filter-chips';
import { AnalyticsTiles } from '@/components/analytics-tiles';
import { AnalyticsLive } from '@/components/analytics-live';
import { EmptyState } from '@/components/empty-state';
import { ApiFailureAlert } from '@/components/api-failure-alert';
import {
  analyticsVolume,
  type AnalyticsResponse,
  type FilterOptionsResponse,
} from '@/lib/api-types';

interface AnalyticsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function scalar(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

// Zero-valued aggregate for total-failure fallback rendering.
const ZERO_AGGREGATE: AnalyticsResponse = {
  statusBreakdown: { completed: 0, failed: 0, in_progress: 0 },
  severityRollup: { error: 0, warning: 0, info: 0 },
  topRules: [],
  latency: { p50: null, p95: null },
  tokenTotals: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
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

  const analyticsFailed = analyticsResult.status === 'rejected';
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

  // Only show the empty state when the data fetch succeeded and the
  // result is genuinely zero. A failed fetch gets the failure alert,
  // not the seed-the-DB empty state — they mean different things to
  // the operator.
  const showEmpty = !analyticsFailed && analyticsVolume(aggregate) === 0;

  return (
    <div className="space-y-8">
      {/* Page heading */}
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Analytics
        </h1>
      </header>

      {analyticsFailed && (
        <ApiFailureAlert
          endpoint="/dashboard/analytics"
          description="couldn't load aggregate metrics"
        />
      )}

      {showEmpty ? (
        <>
          {/* Filter bar still renders even in the empty state */}
          {!filtersFailed && (
            <Suspense fallback={<div className="h-8" />}>
              <div className="space-y-2">
                <FilterBar repos={repos} authors={authors} />
                <ActiveFilterChips />
              </div>
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
                  <div className="space-y-2">
                    <FilterBar repos={repos} authors={authors} />
                    <ActiveFilterChips />
                  </div>
                </Suspense>
              )
            }
          />
        </Suspense>
      )}
    </div>
  );
}

// Reviews list page — Server Component.
// Reads searchParams for filter spec + pagination, calls the dashboard API,
// renders FilterBar (in Suspense) + ReviewsList + PaginationControls.
import { Suspense } from 'react';
import { fetchDashboard, toURLSearchParams } from '@/lib/api';
import { FilterBar } from '@/components/filter-bar';
import { ReviewsList } from '@/components/reviews-list';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  ReviewListResponse,
  FilterOptionsResponse,
} from '@/lib/api-types';

interface ReviewsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Resolve a scalar from a param that may be a string or string[]
function scalar(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export default async function ReviewsPage({ searchParams }: ReviewsPageProps) {
  const params = await searchParams;

  const repo = scalar(params.repo);
  const author = scalar(params.author);
  const offsetRaw = Number(scalar(params.offset) ?? '0');
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  const limit = 50;

  // Derive filter state for empty-state differentiation
  const hasActiveFilter = Boolean(repo || author);

  const queryParams = toURLSearchParams({
    ...( repo ? { repo } : {}),
    ...( author ? { author } : {}),
    offset: offset > 0 ? String(offset) : undefined,
    limit: String(limit),
  });

  // Fetch list + filter options in parallel; filter options are best-effort.
  const [listResult, filterResult] = await Promise.allSettled([
    fetchDashboard<ReviewListResponse>('/reviews', queryParams),
    fetchDashboard<FilterOptionsResponse>('/filters'),
  ]);

  const list: ReviewListResponse =
    listResult.status === 'fulfilled'
      ? listResult.value
      : { items: [], total: 0, offset, limit };

  const repos =
    filterResult.status === 'fulfilled' ? filterResult.value.repos : [];
  const authors =
    filterResult.status === 'fulfilled' ? filterResult.value.authors : [];

  const showEmpty = list.items.length === 0;

  return (
    <div className="space-y-6">
      {/* Page heading */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Reviews</h1>
        {list.total > 0 && (
          <p className="text-sm text-muted-foreground">
            {list.total} total
          </p>
        )}
      </div>

      {/* Filter bar — Client Component; must be wrapped in Suspense */}
      <Suspense fallback={<div className="h-8" />}>
        <FilterBar repos={repos} authors={authors} />
      </Suspense>

      {/* Main content */}
      {showEmpty ? (
        hasActiveFilter ? (
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
        )
      ) : (
        <>
          <ReviewsList items={list.items} />

          {/* Pagination — Client Component; must be wrapped in Suspense */}
          <Suspense fallback={null}>
            <PaginationControls
              offset={list.offset}
              limit={list.limit}
              total={list.total}
            />
          </Suspense>
        </>
      )}
    </div>
  );
}

// Analytics page — Server Component skeleton.
// The full implementation (live SSE tiles, filter bar, analytics data fetch)
// lands in U8. This skeleton mounts successfully so `next build` passes and
// the nav shell is visible end-to-end with the U6 foundation.
import { Suspense } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';

export default function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review activity overview
        </p>
      </div>

      {/* Filter bar placeholder — wired in U8 */}
      <Suspense fallback={<Skeleton className="h-8 w-64" />}>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-8 w-32" />
        </div>
      </Suspense>

      {/* Primary metric tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard title="Total Reviews" value="—" />
        <MetricCard title="Completed" value="—" />
        <MetricCard title="Failed" value="—" />
        <MetricCard title="In Progress" value="—" />
      </div>

      {/* Secondary metric tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard title="Latency p50" value="—" />
        <MetricCard title="Latency p95" value="—" />
        <MetricCard title="Total Tokens" value="—" />
      </div>

      {/* Empty state — shown until U8 wires real data */}
      <EmptyState
        title="Analytics loading in U8"
        description="Run npm run seed:dev to populate the database with sample reviews."
      />
    </div>
  );
}

function MetricCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}

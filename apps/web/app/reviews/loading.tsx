// Streaming Suspense fallback for the reviews list page.
// Matches the column shape of ReviewsTable so the layout does not shift.
import { Skeleton } from '@/components/ui/skeleton';

export default function ReviewsLoading() {
  return (
    <div className="space-y-6">
      {/* Heading skeleton */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-16" />
      </div>

      {/* Filter bar skeleton */}
      <div className="flex gap-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-8 w-32" />
      </div>

      {/* Table skeleton: header + 8 rows */}
      <div className="space-y-1">
        {/* Header row */}
        <div className="flex gap-4 border-b border-border pb-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-28" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-border py-2.5"
          >
            <Skeleton className="h-5 w-20 rounded-md" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

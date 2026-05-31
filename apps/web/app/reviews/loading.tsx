// Streaming Suspense fallback for the reviews list page.
// Matches the two-line GitHub-issue row shape of ReviewsList so the
// layout does not shift when the real data arrives.
import { Skeleton } from '@/components/ui/skeleton';

const ROW_COUNT = 8;

export default function ReviewsLoading() {
  return (
    <div className="space-y-6">
      {/* Heading row */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-20" />
      </div>

      {/* Filter bar */}
      <div className="flex gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-40" />
      </div>

      {/* List skeleton: status dot + two stacked text bars per row */}
      <ul role="list" className="rounded-md border border-border">
        {Array.from({ length: ROW_COUNT }).map((_, i) => (
          <li
            key={i}
            className="border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="flex items-center gap-2">
              <Skeleton className="h-2 w-2 rounded-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <div className="mt-2 pl-[calc(0.5rem+8px)]">
              <Skeleton className="h-3 w-1/3" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

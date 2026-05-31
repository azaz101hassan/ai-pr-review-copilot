// Streaming Suspense fallback for the review detail page.
// Mirrors the structure of ReviewDetail (metadata strip, findings, chunks).
import { Skeleton } from '@/components/ui/skeleton';

export default function ReviewDetailLoading() {
  return (
    <div className="max-w-4xl space-y-8">
      {/* Metadata strip skeleton */}
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-20 rounded-md" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-7 w-96" />
      </header>

      <div className="h-px bg-border" />

      {/* Findings section skeleton */}
      <section className="space-y-4">
        <Skeleton className="h-5 w-24" />
        <div className="space-y-1">
          {/* Header */}
          <div className="flex gap-4 border-b border-border pb-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-16" />
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-border py-2.5"
            >
              <Skeleton className="h-5 w-16 rounded-md" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
      </section>

      <div className="h-px bg-border" />

      {/* Knowledge chunks skeleton */}
      <section className="space-y-4">
        <Skeleton className="h-5 w-36" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border px-4 py-3">
              <div className="flex gap-4">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-40" />
              </div>
              <Skeleton className="mt-2 h-4 w-full" />
              <Skeleton className="mt-1 h-4 w-3/4" />
            </div>
          ))}
        </div>
      </section>

      <div className="h-px bg-border" />

      {/* Token breakdown skeleton */}
      <section className="space-y-4">
        <Skeleton className="h-4 w-24" />
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-1 h-5 w-16" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

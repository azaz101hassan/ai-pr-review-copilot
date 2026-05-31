// Review detail page — Server Component.
// Fetches a single review with its findings and retrieved chunks.
// 404 from the API renders the sibling not-found.tsx inside <NavShell>.
// All other errors propagate to the nearest error.tsx.
import { notFound } from 'next/navigation';
import { fetchDashboard } from '@/lib/api';
import { FetchDashboardError } from '@/lib/api';
import { ReviewDetail } from '@/components/review-detail';
import type { ReviewDetailResponse } from '@/lib/api-types';

interface ReviewDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ReviewDetailPage({
  params,
}: ReviewDetailPageProps) {
  const { id } = await params;

  let data: ReviewDetailResponse;
  try {
    data = await fetchDashboard<ReviewDetailResponse>(`/reviews/${id}`);
  } catch (err) {
    if (err instanceof FetchDashboardError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  return (
    <div className="max-w-4xl">
      <ReviewDetail review={data.review} />
    </div>
  );
}

// Review detail page — Server Component.
// Fetches a single review with its findings, retrieved chunks, and PR summary.
// 404 from the API renders the sibling not-found.tsx inside <NavShell>.
// All other errors propagate to the nearest error.tsx.
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { fetchDashboard } from '@/lib/api';
import { FetchDashboardError } from '@/lib/api';
import { ReviewDetail } from '@/components/review-detail';
import type { ReviewDetailResponse } from '@/lib/api-types';

interface ReviewDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: ReviewDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  try {
    const data = await fetchDashboard<ReviewDetailResponse>(`/reviews/${id}`);
    if (data.pr) {
      return {
        title: `#${data.pr.number} ${data.pr.title} · ${data.pr.repo_full_name}`,
      };
    }
    return { title: `Review ${id}` };
  } catch {
    return { title: 'Review' };
  }
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
      <ReviewDetail
        review={data.review}
        findings={data.findings}
        retrievedChunks={data.retrievedChunks}
        pr={data.pr}
      />
    </div>
  );
}

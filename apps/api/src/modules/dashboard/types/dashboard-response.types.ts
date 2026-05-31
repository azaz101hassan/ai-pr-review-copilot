import {
  AnalyticsAggregate,
  ReviewListEntry,
} from '@/modules/reviews/types/review.repository';
import { ReviewRecord } from '@/modules/reviews/types/review.types';
import { ReviewFindingRecord } from '@/modules/reviews/types/review-finding.types';
import { PullRequestSummary } from '@/modules/webhooks/types/pull-request.repository';

// ---------------------------------------------------------------------------
// Response envelope types for GET /dashboard/reviews
// ---------------------------------------------------------------------------

// Paginated list of reviews with PR metadata. total enables the frontend
// "showing N–M of TOTAL" affordance and the next-page-disabled state.
export interface ReviewListResponse {
  items: ReviewListEntry[];
  total: number;
  offset: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Response envelope for GET /dashboard/reviews/:id
// ---------------------------------------------------------------------------

// A hydrated chunk: either a real KnowledgeChunkRecord subset or a
// placeholder when the chunk no longer exists in the knowledge_chunks table.
// Uses `body` (not `text`) which is the actual column name in knowledge_chunks.
export type HydratedChunk =
  | {
      id: string;
      missing: false;
      source_id: string;
      rule_id: string;
      title: string;
      body: string;
    }
  | {
      id: string;
      missing: true;
    };

export interface ReviewDetailResponse {
  review: ReviewRecord;
  findings: ReviewFindingRecord[];
  retrievedChunks: HydratedChunk[];
}

// ---------------------------------------------------------------------------
// Response envelope for GET /dashboard/analytics
// ---------------------------------------------------------------------------

// Re-export so consumers only need to import from this module.
export type { AnalyticsAggregate };

// The analytics endpoint returns the aggregate directly.
export type AnalyticsResponse = AnalyticsAggregate;

// ---------------------------------------------------------------------------
// Response envelope for GET /dashboard/filters
// ---------------------------------------------------------------------------

export interface FilterOptionsResponse {
  repos: string[];
  authors: string[];
  recentPrs: PullRequestSummary[];
}

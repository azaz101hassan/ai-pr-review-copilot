import { PullRequestRecord } from './pull-request.types';
import { ReviewFilterSpec } from '@/modules/reviews/types/review.repository';

// Symbol token because TypeScript interfaces don't exist at runtime, so
// NestJS DI cannot bind on the interface itself. The webhooks module
// resolves this token; infrastructure/db provides the SQLite-backed
// implementation. Swapping persistence engines means swapping this
// binding — no changes inside modules/.
export const PULL_REQUEST_REPOSITORY = Symbol('PullRequestRepository');

// Trimmed PR shape for the dashboard filter picker (avoids shipping
// the full raw_payload JSON over the wire).
export interface PullRequestSummary {
  node_id: string;
  repo_full_name: string;
  number: number;
  title: string;
  author_login: string;
  created_at: Date;
}

export interface IPullRequestRepository {
  save(pr: PullRequestRecord): void;
  findByNodeId(nodeId: string): PullRequestRecord | undefined;

  // Day-7 dashboard filter picker. Returns pull requests matching the
  // filter spec (by repo / author) ordered by created_at DESC, bounded
  // by limit. Used to populate the single-PR selection dropdown.
  findRecentMatching(spec: ReviewFilterSpec, limit: number): PullRequestSummary[];
}

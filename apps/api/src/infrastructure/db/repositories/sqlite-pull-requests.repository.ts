import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { pullRequests } from '../schema';
import {
  IPullRequestRepository,
  PullRequestSummary,
} from '@/modules/webhooks/types/pull-request.repository';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';
import { ReviewFilterSpec } from '@/modules/reviews/types/review.repository';

// Drizzle-backed implementation of IPullRequestRepository. The webhooks
// module depends on the interface (via the PULL_REQUEST_REPOSITORY
// token); only this file knows about Drizzle and the `pullRequests`
// table object. Swap the engine by writing a new repository class and
// changing the provider binding in database.module.ts — no consumer
// changes required.
@Injectable()
export class SqlitePullRequestsRepository implements IPullRequestRepository {
  constructor(private readonly db: DatabaseService) {}

  save(pr: PullRequestRecord): void {
    this.db.drizzle
      .insert(pullRequests)
      .values(pr)
      .onConflictDoUpdate({
        target: pullRequests.node_id,
        set: {
          repo_full_name: pr.repo_full_name,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          head_sha: pr.head_sha,
          base_sha: pr.base_sha,
          author_login: pr.author_login,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          raw_payload: pr.raw_payload,
        },
      })
      .run();
  }

  findByNodeId(nodeId: string): PullRequestRecord | undefined {
    return this.db.drizzle
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.node_id, nodeId))
      .get();
  }

  // Dashboard filter picker. Returns a trimmed PR summary matching
  // the filter spec (repo and/or author), ordered by created_at
  // DESC, bounded by limit. Used to populate the single-PR
  // selection dropdown.
  findRecentMatching(spec: ReviewFilterSpec, limit: number): PullRequestSummary[] {
    const conditions = [];

    if (spec.repo) {
      conditions.push(eq(pullRequests.repo_full_name, spec.repo));
    }
    if (spec.author) {
      conditions.push(eq(pullRequests.author_login, spec.author));
    }

    const where = conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

    const rows = this.db.drizzle
      .select({
        node_id: pullRequests.node_id,
        repo_full_name: pullRequests.repo_full_name,
        number: pullRequests.number,
        title: pullRequests.title,
        author_login: pullRequests.author_login,
        created_at: pullRequests.created_at,
      })
      .from(pullRequests)
      .where(where)
      .orderBy(desc(pullRequests.created_at))
      .limit(limit)
      .all();

    return rows;
  }

  setWalkthroughCommentId(prNodeId: string, id: number | null): void {
    const result = this.db.drizzle
      .update(pullRequests)
      .set({ walkthrough_comment_id: id })
      .where(eq(pullRequests.node_id, prNodeId))
      .run();

    // better-sqlite3 exposes `changes` on the run result. Zero means
    // no row matched — fail loudly per the contract.
    if ((result as { changes?: number }).changes === 0) {
      throw new Error(
        `setWalkthroughCommentId: no pull_requests row matches node_id "${prNodeId}"`,
      );
    }
  }

  getWalkthroughCommentId(prNodeId: string): number | null {
    const row = this.db.drizzle
      .select({ id: pullRequests.walkthrough_comment_id })
      .from(pullRequests)
      .where(eq(pullRequests.node_id, prNodeId))
      .get();
    return row?.id ?? null;
  }
}

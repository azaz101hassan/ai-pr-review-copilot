import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { pullRequests } from '../schema';
import { IPullRequestRepository } from '@/modules/webhooks/types/pull-request.repository';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';

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
}

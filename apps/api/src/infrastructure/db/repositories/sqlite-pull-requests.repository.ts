import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { IPullRequestRepository } from '@/modules/webhooks/types/pull-request.repository';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';

// SQLite-backed implementation of IPullRequestRepository. The webhooks
// module depends on the interface (via the PULL_REQUEST_REPOSITORY
// token); only this file knows about better-sqlite3 specifics. Swap the
// engine by writing a new repository class and changing the provider
// binding — no consumer changes required.
@Injectable()
export class SqlitePullRequestsRepository implements IPullRequestRepository {
  constructor(private readonly db: DatabaseService) {}

  save(pr: PullRequestRecord): void {
    this.db
      .getDb()
      .prepare(
        `INSERT INTO pull_requests
         (node_id, repo_full_name, number, title, state, head_sha, base_sha,
          author_login, created_at, updated_at, raw_payload)
         VALUES (@node_id, @repo_full_name, @number, @title, @state, @head_sha,
                 @base_sha, @author_login, @created_at, @updated_at, @raw_payload)
         ON CONFLICT(node_id) DO UPDATE SET
           repo_full_name = excluded.repo_full_name,
           number         = excluded.number,
           title          = excluded.title,
           state          = excluded.state,
           head_sha       = excluded.head_sha,
           base_sha       = excluded.base_sha,
           author_login   = excluded.author_login,
           created_at     = excluded.created_at,
           updated_at     = excluded.updated_at,
           raw_payload    = excluded.raw_payload`,
      )
      .run(pr);
  }

  findByNodeId(nodeId: string): PullRequestRecord | undefined {
    return this.db
      .getDb()
      .prepare('SELECT * FROM pull_requests WHERE node_id = ?')
      .get(nodeId) as PullRequestRecord | undefined;
  }
}

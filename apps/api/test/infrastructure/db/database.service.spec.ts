import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqlitePullRequestsRepository } from '../../../src/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';

function makePr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    node_id: 'PR_kwDOLIFECYCLE',
    repo_full_name: 'octocat/hello-world',
    number: 42,
    title: 'Add greetings',
    state: 'open',
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    author_login: 'octocat',
    created_at: new Date('2026-05-25T10:00:00Z'),
    updated_at: new Date('2026-05-25T10:00:00Z'),
    raw_payload: JSON.stringify({ pull_request: { number: 42 } }),
    walkthrough_comment_id: null,
    ...overrides,
  };
}

describe('DatabaseService (lifecycle)', () => {
  let tmpDir: string;
  let dbPath: string;
  let service: DatabaseService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-copilot-db-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
    service = new DatabaseService();
    service.open(dbPath);
  });

  afterEach(() => {
    service.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('schema bootstrap', () => {
    it('creates the pull_requests and webhook_events tables', () => {
      expect(service.hasTable('pull_requests')).toBe(true);
      expect(service.hasTable('webhook_events')).toBe(true);
    });

    it('applies the schema idempotently across reopens', () => {
      service.onApplicationShutdown();
      service.open(dbPath); // second open against the same file
      expect(service.hasTable('pull_requests')).toBe(true);
      expect(service.hasTable('webhook_events')).toBe(true);
    });

    it('enables foreign_keys', () => {
      const row = service.getDb().pragma('foreign_keys', { simple: true });
      expect(row).toBe(1);
    });
  });

  describe('transaction', () => {
    it('commits all writes on success', () => {
      const prs = new SqlitePullRequestsRepository(service);

      service.transaction(() => {
        prs.save(makePr({ node_id: 'PR_txn_ok' }));
      });

      expect(prs.findByNodeId('PR_txn_ok')).toBeDefined();
    });

    it('rolls back all writes if the wrapped fn throws after the first write', () => {
      const prs = new SqlitePullRequestsRepository(service);

      expect(() => {
        service.transaction(() => {
          prs.save(makePr({ node_id: 'PR_txn_rollback' }));
          throw new Error('boom — should roll back the PR insert');
        });
      }).toThrow('boom');

      expect(prs.findByNodeId('PR_txn_rollback')).toBeUndefined();
    });

    it('returns the wrapped fn return value', () => {
      const prs = new SqlitePullRequestsRepository(service);

      const result = service.transaction(() => {
        prs.save(makePr({ node_id: 'PR_txn_ret' }));
        return 'ok' as const;
      });
      expect(result).toBe('ok');
    });
  });
});

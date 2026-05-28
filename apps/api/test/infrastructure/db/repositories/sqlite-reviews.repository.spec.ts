import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqlitePullRequestsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { SqliteReviewsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-reviews.repository';
import { ReviewInsert } from '@/modules/reviews/types/review.types';

const PR_NODE_ID = 'PR_kwDOEND2END';
const NOW = new Date('2026-05-27T10:00:00Z');

function makeReview(overrides: Partial<ReviewInsert> = {}): ReviewInsert {
  const id = overrides.id ?? 'rev-' + Math.random().toString(36).slice(2, 10);
  return {
    id,
    pr_node_id: PR_NODE_ID,
    created_by: null,
    diff_length: 120,
    model: 'claude-sonnet-4-6',
    prompt_version: 'v1',
    top_k: 10,
    retrieved_chunk_ids: JSON.stringify(['airbnb:no-var', 'airbnb:eqeqeq']),
    retrieved_chunk_ids_hash: 'a'.repeat(64),
    status: 'in_progress',
    error_status: null,
    error_code: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    created_at: NOW,
    completed_at: null,
    ...overrides,
  };
}

describe('SqliteReviewsRepository', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let prs: SqlitePullRequestsRepository;
  let repo: SqliteReviewsRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-repo-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    prs = new SqlitePullRequestsRepository(db);
    repo = new SqliteReviewsRepository(db);

    // FK parent row for the pr_node_id reference (set-null on delete).
    prs.save({
      node_id: PR_NODE_ID,
      repo_full_name: 'owner/repo',
      number: 42,
      title: 'Test PR',
      state: 'open',
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      author_login: 'octocat',
      created_at: NOW,
      updated_at: NOW,
      raw_payload: '{}',
    });
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('insert + findById', () => {
    it('round-trips a fully-populated in_progress row with non-null pr_node_id', () => {
      const record = makeReview({ id: 'r1' });
      repo.insert(record);

      const found = repo.findById('r1');
      expect(found).toBeDefined();
      expect(found?.pr_node_id).toBe(PR_NODE_ID);
      expect(found?.status).toBe('in_progress');
      expect(found?.created_at).toBeInstanceOf(Date);
      expect(found?.completed_at).toBeNull();
      expect(JSON.parse(found!.retrieved_chunk_ids)).toEqual([
        'airbnb:no-var',
        'airbnb:eqeqeq',
      ]);
      expect(found?.created_by).toBeNull();
    });

    it('persists null pr_node_id without error', () => {
      repo.insert(makeReview({ id: 'r2', pr_node_id: null }));
      expect(repo.findById('r2')?.pr_node_id).toBeNull();
    });

    it('rejects duplicate id (primary-key violation)', () => {
      repo.insert(makeReview({ id: 'r3' }));
      expect(() => repo.insert(makeReview({ id: 'r3' }))).toThrow();
    });
  });

  describe('markCompleted', () => {
    it('flips in_progress to completed and populates token columns', () => {
      repo.insert(makeReview({ id: 'rc' }));
      const completedAt = new Date('2026-05-27T10:00:05Z');
      repo.markCompleted('rc', {
        completed_at: completedAt,
        input_tokens: 1500,
        output_tokens: 220,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: 0,
      });

      const row = repo.findById('rc')!;
      expect(row.status).toBe('completed');
      expect(row.input_tokens).toBe(1500);
      expect(row.output_tokens).toBe(220);
      expect(row.cache_creation_input_tokens).toBe(1200);
      expect(row.cache_read_input_tokens).toBe(0);
      expect(row.completed_at?.toISOString()).toBe(completedAt.toISOString());
    });
  });

  describe('markFailed', () => {
    it('flips in_progress to failed and populates error columns', () => {
      repo.insert(makeReview({ id: 'rf' }));
      const completedAt = new Date('2026-05-27T10:00:02Z');
      repo.markFailed('rf', {
        completed_at: completedAt,
        error_status: 429,
        error_code: 'rate_limit_error',
      });

      const row = repo.findById('rf')!;
      expect(row.status).toBe('failed');
      expect(row.error_status).toBe(429);
      expect(row.error_code).toBe('rate_limit_error');
      expect(row.completed_at?.toISOString()).toBe(completedAt.toISOString());
      expect(row.input_tokens).toBeNull();
    });
  });

  describe('FK behavior', () => {
    it('rejects insert with pr_node_id that does not exist in pull_requests', () => {
      expect(() =>
        repo.insert(makeReview({ id: 'rfk', pr_node_id: 'PR_does_not_exist' })),
      ).toThrow(/FOREIGN KEY/);
    });

    it('sets pr_node_id to null when the parent pull_request is deleted', () => {
      repo.insert(makeReview({ id: 'rcas' }));
      // Delete the parent — the FK is onDelete('set null').
      db.getDb().prepare('DELETE FROM pull_requests WHERE node_id = ?').run(PR_NODE_ID);

      expect(repo.findById('rcas')?.pr_node_id).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns rows ordered by created_at desc with a default cap of 100', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert(
          makeReview({
            id: 'rf-' + i,
            created_at: new Date(NOW.getTime() + i * 1000),
          }),
        );
      }
      const found = repo.findAll();
      expect(found).toHaveLength(5);
      // Newest first.
      expect(found[0].id).toBe('rf-4');
      expect(found[4].id).toBe('rf-0');
    });

    it('honors an explicit limit', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert(makeReview({ id: 'rfl-' + i }));
      }
      expect(repo.findAll(2)).toHaveLength(2);
    });
  });

  describe('sweepStaleInProgress', () => {
    it('marks in_progress rows older than the cutoff as failed/process_terminated', () => {
      const tenMinAgo = new Date(Date.now() - 10 * 60_000);
      const oneMinAgo = new Date(Date.now() - 60_000);
      repo.insert(makeReview({ id: 'stale', created_at: tenMinAgo }));
      repo.insert(makeReview({ id: 'fresh', created_at: oneMinAgo }));

      const updated = repo.sweepStaleInProgress({
        olderThanMs: 5 * 60_000,
        errorCode: 'process_terminated',
      });

      expect(updated).toBe(1);
      const stale = repo.findById('stale')!;
      expect(stale.status).toBe('failed');
      expect(stale.error_code).toBe('process_terminated');
      expect(stale.completed_at).toBeInstanceOf(Date);

      const fresh = repo.findById('fresh')!;
      expect(fresh.status).toBe('in_progress');
    });

    it('does not touch completed or failed rows even when stale', () => {
      const tenMinAgo = new Date(Date.now() - 10 * 60_000);
      repo.insert(
        makeReview({ id: 'old-completed', status: 'completed', created_at: tenMinAgo }),
      );
      repo.insert(
        makeReview({ id: 'old-failed', status: 'failed', created_at: tenMinAgo }),
      );

      const updated = repo.sweepStaleInProgress({
        olderThanMs: 5 * 60_000,
        errorCode: 'process_terminated',
      });

      expect(updated).toBe(0);
      expect(repo.findById('old-completed')?.status).toBe('completed');
      expect(repo.findById('old-failed')?.status).toBe('failed');
    });
  });
});

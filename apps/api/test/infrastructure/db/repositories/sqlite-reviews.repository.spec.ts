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

    it('persists turn_count and tool_calls_json when provided (round-trip)', () => {
      repo.insert(makeReview({ id: 'rc-multi' }));
      const completedAt = new Date('2026-05-27T10:00:06Z');
      const toolCalls = [
        {
          turn_idx: 1,
          tool_name: 'fetch_related_file',
          input_hash: 'a'.repeat(16),
          result_bytes: 1024,
          latency_ms: 612,
          stop_reason: 'tool_use',
        },
        {
          turn_idx: 2,
          tool_name: 'fetch_function_definition',
          input_hash: 'b'.repeat(16),
          result_bytes: 384,
          latency_ms: 524,
          stop_reason: 'tool_use',
        },
        {
          turn_idx: 3,
          tool_name: 'emit_finding',
          input_hash: 'c'.repeat(16),
          result_bytes: 220,
          latency_ms: 711,
          stop_reason: 'tool_use',
        },
      ];
      repo.markCompleted('rc-multi', {
        completed_at: completedAt,
        input_tokens: 3000,
        output_tokens: 410,
        cache_creation_input_tokens: 2400,
        cache_read_input_tokens: 600,
        turn_count: 3,
        tool_calls: toolCalls,
      });

      const row = repo.findById('rc-multi')!;
      expect(row.turn_count).toBe(3);
      expect(row.tool_calls_json).toEqual(toolCalls);
    });

    it('leaves turn_count at default 0 and tool_calls_json null when patch omits them', () => {
      repo.insert(makeReview({ id: 'rc-default' }));
      repo.markCompleted('rc-default', {
        completed_at: new Date('2026-05-27T10:00:07Z'),
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      });

      const row = repo.findById('rc-default')!;
      expect(row.turn_count).toBe(0);
      expect(row.tool_calls_json).toBeNull();
    });

    it('persists a large tool_calls_json array (6 entries) without truncation', () => {
      repo.insert(makeReview({ id: 'rc-large' }));
      const calls = Array.from({ length: 6 }, (_, i) => ({
        turn_idx: i + 1,
        tool_name: 'fetch_related_file',
        input_hash: String(i).padStart(16, '0'),
        result_bytes: 8192,
        latency_ms: 500 + i,
        stop_reason: 'tool_use',
      }));
      repo.markCompleted('rc-large', {
        completed_at: new Date('2026-05-27T10:00:08Z'),
        input_tokens: 9000,
        output_tokens: 800,
        cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 3000,
        turn_count: 6,
        tool_calls: calls,
      });

      const row = repo.findById('rc-large')!;
      expect(row.turn_count).toBe(6);
      expect(row.tool_calls_json).toHaveLength(6);
      expect(row.tool_calls_json).toEqual(calls);
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

    it('persists turn_count on turn_cap_exceeded failures', () => {
      repo.insert(makeReview({ id: 'rf-cap' }));
      repo.markFailed('rf-cap', {
        completed_at: new Date('2026-05-27T10:00:09Z'),
        error_status: 200,
        error_code: 'turn_cap_exceeded',
        turn_count: 6,
      });

      const row = repo.findById('rf-cap')!;
      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('turn_cap_exceeded');
      expect(row.turn_count).toBe(6);
    });

    it('persists tool_calls_json on turn_cap_exceeded failures (partial loop trace round-trip)', () => {
      repo.insert(makeReview({ id: 'rf-cap-tool-calls' }));
      const partialToolCalls = [
        {
          turn_idx: 1,
          tool_name: 'fetch_related_file',
          input_hash: 'a'.repeat(16),
          result_bytes: 800,
          latency_ms: 500,
          stop_reason: 'tool_use',
        },
        {
          turn_idx: 2,
          tool_name: 'fetch_function_definition',
          input_hash: 'b'.repeat(16),
          result_bytes: 400,
          latency_ms: 520,
          stop_reason: 'tool_use',
          is_error: true,
        },
      ];
      repo.markFailed('rf-cap-tool-calls', {
        completed_at: new Date('2026-05-27T10:00:11Z'),
        error_status: 200,
        error_code: 'turn_cap_exceeded',
        turn_count: 6,
        tool_calls: partialToolCalls,
      });

      const row = repo.findById('rf-cap-tool-calls')!;
      expect(row.tool_calls_json).toEqual(partialToolCalls);
      // is_error round-trips as a boolean — not stringified.
      const parsed = row.tool_calls_json as unknown as Array<{ is_error?: boolean }>;
      expect(parsed[1].is_error).toBe(true);
    });

    it('leaves tool_calls_json at SQL NULL when patch passes null (not the literal JSON string "null")', () => {
      // Regression: drizzle-orm's `mode: 'json'` text column can
      // serialize null as the four-character string "null" depending
      // on the SET path. Repository now skips the SET on both null
      // AND undefined so the column stays at its schema default.
      // Day-6 eval queries like `WHERE tool_calls_json IS NULL`
      // depend on this distinction.
      repo.insert(makeReview({ id: 'rf-null-tc' }));
      repo.markFailed('rf-null-tc', {
        completed_at: new Date('2026-05-27T10:00:12Z'),
        error_status: 401,
        error_code: 'authentication_error',
        turn_count: 0,
        tool_calls: null,
      });

      // findById returns null when tool_calls_json IS SQL NULL.
      const row = repo.findById('rf-null-tc')!;
      expect(row.tool_calls_json).toBeNull();
      // Raw SQL check — `IS NULL` should match, and `= 'null'`
      // (literal string) should NOT.
      const rawDb = db.getDb();
      const isNullCount = rawDb
        .prepare('SELECT COUNT(*) AS c FROM reviews WHERE id = ? AND tool_calls_json IS NULL')
        .get('rf-null-tc') as { c: number };
      expect(isNullCount.c).toBe(1);
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

  describe('findRecentInProgressForPr', () => {
    it('returns the most recent in_progress row within the window', () => {
      const older = new Date(Date.now() - 3 * 60_000);
      const newer = new Date(Date.now() - 30_000);
      repo.insert(
        makeReview({
          id: 'in-prog-older',
          status: 'in_progress',
          created_at: older,
        }),
      );
      repo.insert(
        makeReview({
          id: 'in-prog-newer',
          status: 'in_progress',
          created_at: newer,
        }),
      );

      const found = repo.findRecentInProgressForPr(PR_NODE_ID, 5 * 60_000);
      expect(found?.id).toBe('in-prog-newer');
    });

    it('returns undefined when no in_progress row exists', () => {
      repo.insert(
        makeReview({
          id: 'completed',
          status: 'completed',
          created_at: new Date(),
        }),
      );
      expect(repo.findRecentInProgressForPr(PR_NODE_ID, 5 * 60_000)).toBeUndefined();
    });

    it('ignores in_progress rows older than the window', () => {
      const twentyMinAgo = new Date(Date.now() - 20 * 60_000);
      repo.insert(
        makeReview({
          id: 'stale',
          status: 'in_progress',
          created_at: twentyMinAgo,
        }),
      );
      expect(repo.findRecentInProgressForPr(PR_NODE_ID, 10 * 60_000)).toBeUndefined();
    });

    it('scopes by pr_node_id (different PR not returned)', () => {
      const otherPr = 'PR_other';
      // Seed second pull_requests parent for FK.
      prs.save({
        node_id: otherPr,
        repo_full_name: 'owner/repo',
        number: 99,
        title: 'Other PR',
        state: 'open',
        head_sha: 'c'.repeat(40),
        base_sha: 'd'.repeat(40),
        author_login: 'someoneelse',
        created_at: NOW,
        updated_at: NOW,
        raw_payload: '{}',
      });
      repo.insert(
        makeReview({
          id: 'other-pr-row',
          pr_node_id: otherPr,
          status: 'in_progress',
          created_at: new Date(),
        }),
      );
      expect(repo.findRecentInProgressForPr(PR_NODE_ID, 5 * 60_000)).toBeUndefined();
      expect(repo.findRecentInProgressForPr(otherPr, 5 * 60_000)?.id).toBe(
        'other-pr-row',
      );
    });
  });
});

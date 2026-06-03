import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqlitePullRequestsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { SqliteReviewFindingsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-review-findings.repository';
import { SqliteReviewsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-reviews.repository';
import { ReviewInsert } from '@/modules/reviews/types/review.types';
import { ReviewFindingInsert } from '@/modules/reviews/types/review-finding.types';
import { ReviewFilterSpec } from '@/modules/reviews/types/review.repository';

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
  let findings: SqliteReviewFindingsRepository;
  let repo: SqliteReviewsRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-repo-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    prs = new SqlitePullRequestsRepository(db);
    findings = new SqliteReviewFindingsRepository(db);
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
      walkthrough_comment_id: null,
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

    // Day-8 observability persistence — confirm both new columns
    // round-trip through markCompleted + findById.
    it('persists hallucinated_finding_count and cache_hit_count when provided', () => {
      repo.insert(makeReview({ id: 'rc-obs' }));
      repo.markCompleted('rc-obs', {
        completed_at: new Date('2026-05-27T10:00:09Z'),
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        hallucinated_finding_count: 2,
        cache_hit_count: 5,
      });

      const row = repo.findById('rc-obs')!;
      expect(row.hallucinated_finding_count).toBe(2);
      expect(row.cache_hit_count).toBe(5);
    });

    it('leaves hallucinated_finding_count and cache_hit_count at default 0 when patch omits them', () => {
      repo.insert(makeReview({ id: 'rc-obs-default' }));
      repo.markCompleted('rc-obs-default', {
        completed_at: new Date('2026-05-27T10:00:10Z'),
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        // Both observability counters intentionally omitted.
      });

      const row = repo.findById('rc-obs-default')!;
      expect(row.hallucinated_finding_count).toBe(0);
      expect(row.cache_hit_count).toBe(0);
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
        walkthrough_comment_id: null,
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

  // ---------------------------------------------------------------------------
  // Dashboard read-side methods (Day 7, R3, R4, R6, R7, R10)
  // ---------------------------------------------------------------------------

  function makeFinding(reviewId: string, overrides: Partial<ReviewFindingInsert> = {}): ReviewFindingInsert {
    return {
      id: 'finding-' + Math.random().toString(36).slice(2, 10),
      review_id: reviewId,
      rule_id: 'no-var',
      severity: 'warning',
      title: 'Replace var',
      message: 'Use let or const.',
      location_hint: null,
      citation: null,
      created_at: NOW,
      ...overrides,
    };
  }

  describe('findFiltered', () => {
    it('returns all reviews newest-first when no filter is active', () => {
      repo.insert(makeReview({ id: 'r-old', created_at: new Date(NOW.getTime() - 10_000) }));
      repo.insert(makeReview({ id: 'r-new', created_at: new Date(NOW.getTime()) }));

      const rows = repo.findFiltered({}, { limit: 50 });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('r-new');
      expect(rows[1].id).toBe('r-old');
    });

    it('filters by repo via LEFT JOIN pull_requests — AE2', () => {
      // Seed a second PR in a different repo
      prs.save({
        node_id: 'PR_other_repo',
        repo_full_name: 'org/other-repo',
        number: 2,
        title: 'Other repo PR',
        state: 'open',
        head_sha: 'e'.repeat(40),
        base_sha: 'f'.repeat(40),
        author_login: 'dev2',
        created_at: NOW,
        updated_at: NOW,
        raw_payload: '{}',
        walkthrough_comment_id: null,
      });
      repo.insert(makeReview({ id: 'r-main', pr_node_id: PR_NODE_ID }));
      repo.insert(makeReview({ id: 'r-other', pr_node_id: 'PR_other_repo' }));

      const rows = repo.findFiltered({ repo: 'owner/repo' }, { limit: 50 });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('r-main');
      expect(rows[0].repo_full_name).toBe('owner/repo');
    });

    it('returns reviews with null pr_node_id with null PR metadata — AE3', () => {
      repo.insert(makeReview({ id: 'r-null-pr', pr_node_id: null }));

      const rows = repo.findFiltered({}, { limit: 50 });
      const nullPrRow = rows.find((r) => r.id === 'r-null-pr');
      expect(nullPrRow).toBeDefined();
      expect(nullPrRow?.pr_node_id).toBeNull();
      expect(nullPrRow?.repo_full_name).toBeNull();
      expect(nullPrRow?.pr_number).toBeNull();
      expect(nullPrRow?.pr_title).toBeNull();
      expect(nullPrRow?.author_login).toBeNull();
    });

    it('returns empty array when filter matches no rows', () => {
      repo.insert(makeReview({ id: 'r1' }));
      const rows = repo.findFiltered({ author: 'nonexistent' }, { limit: 50 });
      expect(rows).toEqual([]);
    });

    it('filters by sinceMs / untilMs inclusive time bounds', () => {
      const t0 = NOW.getTime();
      repo.insert(makeReview({ id: 'r-before', created_at: new Date(t0 - 5_000) }));
      repo.insert(makeReview({ id: 'r-at-since', created_at: new Date(t0) }));
      repo.insert(makeReview({ id: 'r-after', created_at: new Date(t0 + 5_000) }));

      const rows = repo.findFiltered({ sinceMs: t0, untilMs: t0 }, { limit: 50 });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('r-at-since');
    });

    it('respects limit and offset for pagination', () => {
      for (let i = 0; i < 5; i++) {
        repo.insert(makeReview({ id: `r-pg-${i}`, created_at: new Date(NOW.getTime() + i * 1000) }));
      }
      const page1 = repo.findFiltered({}, { limit: 2 });
      expect(page1).toHaveLength(2);
      const page2 = repo.findFiltered({}, { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
      // No overlap
      expect(page1.map((r) => r.id)).not.toEqual(expect.arrayContaining(page2.map((r) => r.id)));
    });

    it('populates finding_count per row from review_findings', () => {
      repo.insert(makeReview({ id: 'r-with-findings' }));
      repo.insert(makeReview({ id: 'r-no-findings' }));
      findings.insertMany([
        makeFinding('r-with-findings', { id: 'f-a' }),
        makeFinding('r-with-findings', { id: 'f-b' }),
        makeFinding('r-with-findings', { id: 'f-c' }),
      ]);

      const rows = repo.findFiltered({}, { limit: 50 });
      const withFindings = rows.find((r) => r.id === 'r-with-findings');
      const noFindings = rows.find((r) => r.id === 'r-no-findings');
      expect(withFindings?.finding_count).toBe(3);
      expect(noFindings?.finding_count).toBe(0);
    });
  });

  describe('countFiltered', () => {
    it('returns total count with no filter', () => {
      repo.insert(makeReview({ id: 'c1' }));
      repo.insert(makeReview({ id: 'c2' }));
      expect(repo.countFiltered({})).toBe(2);
    });

    it('scopes count by filter', () => {
      repo.insert(makeReview({ id: 'c-main', pr_node_id: PR_NODE_ID }));
      repo.insert(makeReview({ id: 'c-null', pr_node_id: null }));
      // Rows with null pr_node_id don't match a repo filter since there's no JOIN value
      expect(repo.countFiltered({ repo: 'owner/repo' })).toBe(1);
    });

    it('includes standalone rows (list page shows them)', () => {
      repo.insert(makeReview({ id: 'c-standalone', prompt_version: 'standalone-failure', pr_node_id: null }));
      repo.insert(makeReview({ id: 'c-normal' }));
      expect(repo.countFiltered({})).toBe(2);
    });
  });

  describe('findByIdWithFindings', () => {
    it('returns review and findings ordered by created_at ASC', () => {
      repo.insert(makeReview({ id: 'rfwf-1', status: 'completed' }));
      findings.insertMany([
        makeFinding('rfwf-1', { id: 'f2', created_at: new Date(NOW.getTime() + 2_000) }),
        makeFinding('rfwf-1', { id: 'f1', created_at: new Date(NOW.getTime() + 1_000) }),
      ]);

      const result = repo.findByIdWithFindings('rfwf-1');
      expect(result).not.toBeNull();
      expect(result?.review.id).toBe('rfwf-1');
      expect(result?.findings).toHaveLength(2);
      expect(result?.findings[0].id).toBe('f1');
      expect(result?.findings[1].id).toBe('f2');
    });

    it('returns null for an unknown id', () => {
      expect(repo.findByIdWithFindings('does-not-exist')).toBeNull();
    });

    it('returns review with empty findings array when review has no findings', () => {
      repo.insert(makeReview({ id: 'rfwf-empty', status: 'failed' }));
      const result = repo.findByIdWithFindings('rfwf-empty');
      expect(result).not.toBeNull();
      expect(result?.findings).toEqual([]);
    });
  });

  describe('aggregateByFilter', () => {
    it('returns all-zero/null aggregate over an empty filter set', () => {
      const agg = repo.aggregateByFilter({});
      expect(agg.statusBreakdown).toEqual({ completed: 0, failed: 0, in_progress: 0 });
      expect(agg.severityRollup).toEqual({ error: 0, warning: 0, info: 0 });
      expect(agg.topRules).toEqual([]);
      expect(agg.tokenTotals).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      expect(agg.latency).toEqual({ p50: null, p95: null });
      expect(agg.skippedCount).toBe(0);
      expect(agg.hallucinatedTotal).toBe(0);
      expect(agg.errorCodeBreakdown).toEqual([]);
      expect(agg.cacheHitTotal).toBe(0);
    });

    it('excludes every standalone prompt_version from the main aggregates', () => {
      // One row per standalone variant: empty-diff, failure, size-skipped.
      // None should contribute to statusBreakdown, severity, tokens, or latency.
      repo.insert(makeReview({
        id: 'standalone-empty',
        prompt_version: 'standalone-empty-diff',
        status: 'completed',
        pr_node_id: null,
        input_tokens: 999,
        output_tokens: 999,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        created_at: new Date(NOW.getTime() - 5_000),
        completed_at: new Date(NOW.getTime()),
      }));
      repo.insert(makeReview({
        id: 'standalone-fail',
        prompt_version: 'standalone-failure',
        status: 'failed',
        pr_node_id: null,
        created_at: new Date(NOW.getTime() - 4_000),
        completed_at: new Date(NOW.getTime() - 1_000),
      }));
      repo.insert(makeReview({
        id: 'standalone-skipped',
        prompt_version: 'standalone-skipped-too-large',
        status: 'completed',
        pr_node_id: null,
        created_at: new Date(NOW.getTime() - 3_000),
        completed_at: new Date(NOW.getTime() - 2_500),
      }));

      const agg = repo.aggregateByFilter({});
      expect(agg.statusBreakdown).toEqual({ completed: 0, failed: 0, in_progress: 0 });
      expect(agg.tokenTotals.input_tokens).toBe(0);
      expect(agg.latency).toEqual({ p50: null, p95: null });
      // size-skipped is the one standalone variant that gets its own count
      expect(agg.skippedCount).toBe(1);
    });

    it('skippedCount counts only standalone-skipped-too-large rows', () => {
      const t0 = NOW.getTime();
      // Two size-skipped rows
      repo.insert(makeReview({
        id: 'sk-1',
        prompt_version: 'standalone-skipped-too-large',
        status: 'completed',
        created_at: new Date(t0 - 1000),
        completed_at: new Date(t0 - 800),
      }));
      repo.insert(makeReview({
        id: 'sk-2',
        prompt_version: 'standalone-skipped-too-large',
        status: 'completed',
        created_at: new Date(t0 - 500),
        completed_at: new Date(t0 - 400),
      }));
      // A non-skipped row — must NOT count
      repo.insert(makeReview({
        id: 'reg-1',
        status: 'completed',
        created_at: new Date(t0),
        completed_at: new Date(t0 + 100),
      }));
      // Another standalone variant — must NOT count toward skippedCount
      repo.insert(makeReview({
        id: 'empty-1',
        prompt_version: 'standalone-empty-diff',
        status: 'completed',
        pr_node_id: null,
        created_at: new Date(t0 + 200),
        completed_at: new Date(t0 + 300),
      }));

      const agg = repo.aggregateByFilter({});
      expect(agg.skippedCount).toBe(2);
      // Sanity: the regular row still hits statusBreakdown.completed
      expect(agg.statusBreakdown.completed).toBe(1);
    });

    it('skippedCount honours the filter spec (repo)', () => {
      prs.save({
        node_id: 'PR_skip_other',
        repo_full_name: 'org/other',
        number: 99,
        title: 'PR-other',
        state: 'open',
        head_sha: 'x'.repeat(40),
        base_sha: 'y'.repeat(40),
        author_login: 'alice',
        created_at: NOW,
        updated_at: NOW,
        raw_payload: '{}',
        walkthrough_comment_id: null,
      });
      repo.insert(makeReview({
        id: 'sk-main',
        pr_node_id: PR_NODE_ID,
        prompt_version: 'standalone-skipped-too-large',
        status: 'completed',
      }));
      repo.insert(makeReview({
        id: 'sk-other',
        pr_node_id: 'PR_skip_other',
        prompt_version: 'standalone-skipped-too-large',
        status: 'completed',
      }));

      const main = repo.aggregateByFilter({ repo: 'owner/repo' });
      const other = repo.aggregateByFilter({ repo: 'org/other' });
      expect(main.skippedCount).toBe(1);
      expect(other.skippedCount).toBe(1);
    });

    it('mixed rows: 3 completed, 1 failed, 1 standalone — volume=4, severity from 3 completed', () => {
      const t0 = NOW.getTime();

      // 3 completed reviews with findings
      for (let i = 0; i < 3; i++) {
        const completedAt = new Date(t0 + (i + 1) * 1_000);
        repo.insert(makeReview({
          id: `agg-c${i}`,
          status: 'completed',
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          created_at: new Date(t0 + i * 100),
          completed_at: completedAt,
        }));
        findings.insertMany([
          makeFinding(`agg-c${i}`, { id: `f-err-${i}`, severity: 'error' }),
          makeFinding(`agg-c${i}`, { id: `f-warn-${i}`, severity: 'warning' }),
        ]);
      }

      // 1 failed review (no findings)
      repo.insert(makeReview({
        id: 'agg-f0',
        status: 'failed',
        created_at: new Date(t0 + 500),
        completed_at: new Date(t0 + 1_500),
      }));

      // 1 standalone row — must be excluded
      repo.insert(makeReview({
        id: 'agg-standalone',
        prompt_version: 'standalone-failure',
        status: 'completed',
        pr_node_id: null,
        created_at: new Date(t0 + 600),
        completed_at: new Date(t0 + 2_000),
      }));

      const agg = repo.aggregateByFilter({});

      // 3 completed + 1 failed = 4 total (standalone excluded)
      expect(agg.statusBreakdown.completed).toBe(3);
      expect(agg.statusBreakdown.failed).toBe(1);
      expect(agg.statusBreakdown.in_progress).toBe(0);

      // Severity from the 3 completed reviews: 3 errors + 3 warnings
      expect(agg.severityRollup.error).toBe(3);
      expect(agg.severityRollup.warning).toBe(3);
      expect(agg.severityRollup.info).toBe(0);

      // Token totals from 3 completed (standalone excluded, failed has nulls → 0)
      expect(agg.tokenTotals.input_tokens).toBe(300);
      expect(agg.tokenTotals.output_tokens).toBe(150);

      // Latency for 3 completed rows (each ~1000ms, ~200ms, ~300ms differences)
      expect(agg.latency.p50).not.toBeNull();
      expect(agg.latency.p95).not.toBeNull();
    });

    it('returns top-10 rules sorted by count desc', () => {
      repo.insert(makeReview({ id: 'r-rules', status: 'completed' }));
      // 3 findings for rule-a, 2 for rule-b, 1 for rule-c
      findings.insertMany([
        makeFinding('r-rules', { id: 'f-a1', rule_id: 'rule-a' }),
        makeFinding('r-rules', { id: 'f-a2', rule_id: 'rule-a' }),
        makeFinding('r-rules', { id: 'f-a3', rule_id: 'rule-a' }),
        makeFinding('r-rules', { id: 'f-b1', rule_id: 'rule-b' }),
        makeFinding('r-rules', { id: 'f-b2', rule_id: 'rule-b' }),
        makeFinding('r-rules', { id: 'f-c1', rule_id: 'rule-c' }),
      ]);

      const agg = repo.aggregateByFilter({});
      expect(agg.topRules[0]).toEqual({ rule_id: 'rule-a', count: 3 });
      expect(agg.topRules[1]).toEqual({ rule_id: 'rule-b', count: 2 });
      expect(agg.topRules[2]).toEqual({ rule_id: 'rule-c', count: 1 });
    });

    it('filters by repo when spec.repo is set', () => {
      prs.save({
        node_id: 'PR_other2',
        repo_full_name: 'org/other2',
        number: 2,
        title: 'PR2',
        state: 'open',
        head_sha: 'g'.repeat(40),
        base_sha: 'h'.repeat(40),
        author_login: 'alice',
        created_at: NOW,
        updated_at: NOW,
        raw_payload: '{}',
        walkthrough_comment_id: null,
      });
      repo.insert(makeReview({ id: 'r-main2', pr_node_id: PR_NODE_ID, status: 'completed', input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));
      repo.insert(makeReview({ id: 'r-other2', pr_node_id: 'PR_other2', status: 'completed', input_tokens: 999, output_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));

      const agg = repo.aggregateByFilter({ repo: 'owner/repo' });
      expect(agg.statusBreakdown.completed).toBe(1);
      expect(agg.tokenTotals.input_tokens).toBe(10);
    });

    // -----------------------------------------------------------------
    // Day-8 observability fields
    // -----------------------------------------------------------------

    it('hallucinatedTotal sums hallucinated_finding_count across non-standalone rows', () => {
      const t0 = NOW.getTime();
      repo.insert(makeReview({
        id: 'h-1',
        status: 'completed',
        hallucinated_finding_count: 1,
        created_at: new Date(t0),
        completed_at: new Date(t0 + 100),
      }));
      repo.insert(makeReview({
        id: 'h-2',
        status: 'completed',
        hallucinated_finding_count: 2,
        created_at: new Date(t0 + 200),
        completed_at: new Date(t0 + 300),
      }));
      repo.insert(makeReview({
        id: 'h-3',
        status: 'completed',
        hallucinated_finding_count: 0,
        created_at: new Date(t0 + 400),
        completed_at: new Date(t0 + 500),
      }));

      const agg = repo.aggregateByFilter({});
      expect(agg.hallucinatedTotal).toBe(3);
    });

    it('hallucinatedTotal honours the time-window filter (sinceMs)', () => {
      const t0 = NOW.getTime();
      // Inside the window
      repo.insert(makeReview({
        id: 'h-in',
        status: 'completed',
        hallucinated_finding_count: 2,
        created_at: new Date(t0),
        completed_at: new Date(t0 + 100),
      }));
      // Outside the window — created before sinceMs
      repo.insert(makeReview({
        id: 'h-out',
        status: 'completed',
        hallucinated_finding_count: 5,
        created_at: new Date(t0 - 10_000),
        completed_at: new Date(t0 - 9_000),
      }));

      const agg = repo.aggregateByFilter({ sinceMs: t0 - 5_000 });
      expect(agg.hallucinatedTotal).toBe(2);
    });

    it('errorCodeBreakdown returns top-N by count for reviewer-loop failures', () => {
      const t0 = NOW.getTime();
      const failed = (id: string, code: string, offsetMs: number) =>
        repo.insert(makeReview({
          id,
          status: 'failed',
          error_status: 200,
          error_code: code,
          created_at: new Date(t0 + offsetMs),
          completed_at: new Date(t0 + offsetMs + 50),
        }));

      failed('f-1', 'turn_cap_exceeded', 0);
      failed('f-2', 'turn_cap_exceeded', 100);
      failed('f-3', 'turn_cap_exceeded', 200);
      failed('f-4', 'rate_limit_error', 300);
      failed('f-5', 'malformed_emit_finding', 400);

      const agg = repo.aggregateByFilter({});
      expect(agg.errorCodeBreakdown[0]).toEqual({
        error_code: 'turn_cap_exceeded',
        count: 3,
      });
      // The other two share count=1; order between them is implementation-
      // defined (SQLite does not stabilise equal-count ties), but both must
      // appear and neither must be at the head.
      const tail = agg.errorCodeBreakdown.slice(1).map((e) => e.error_code).sort();
      expect(tail).toEqual(['malformed_emit_finding', 'rate_limit_error']);
    });

    it('errorCodeBreakdown returns [] when no failed reviews match the filter', () => {
      // Only completed rows in the dataset
      repo.insert(makeReview({
        id: 'ok-1',
        status: 'completed',
      }));
      const agg = repo.aggregateByFilter({});
      expect(agg.errorCodeBreakdown).toEqual([]);
    });

    it('errorCodeBreakdown excludes POST-side error codes', () => {
      const t0 = NOW.getTime();
      const failed = (id: string, code: string, offsetMs: number) =>
        repo.insert(makeReview({
          id,
          status: 'failed',
          error_status: 200,
          error_code: code,
          created_at: new Date(t0 + offsetMs),
          completed_at: new Date(t0 + offsetMs + 50),
        }));

      // POST-side / orchestration codes — must be excluded
      failed('p-1', 'comment_post_failed', 0);
      failed('p-2', 'inline_post_failed', 100);
      failed('p-3', 'pr_closed_during_review', 200);
      failed('p-4', 'process_terminated', 300);
      // One real reviewer-loop failure — must be included
      failed('r-1', 'turn_cap_exceeded', 400);

      const agg = repo.aggregateByFilter({});
      expect(agg.errorCodeBreakdown).toEqual([
        { error_code: 'turn_cap_exceeded', count: 1 },
      ]);
    });

    it('errorCodeBreakdown also excludes standalone-failure rows', () => {
      const t0 = NOW.getTime();
      // Two standalone-failure rows with the same "synthetic" code — must
      // be excluded by baseWhere alongside the POST-side exclusion.
      repo.insert(makeReview({
        id: 's-1',
        status: 'failed',
        prompt_version: 'standalone-failure',
        pr_node_id: null,
        error_status: 500,
        error_code: 'turn_cap_exceeded',
        created_at: new Date(t0),
        completed_at: new Date(t0 + 100),
      }));
      // One genuine reviewer-loop failure for the same code
      repo.insert(makeReview({
        id: 'r-1',
        status: 'failed',
        error_status: 200,
        error_code: 'turn_cap_exceeded',
        created_at: new Date(t0 + 200),
        completed_at: new Date(t0 + 300),
      }));

      const agg = repo.aggregateByFilter({});
      // Only the non-standalone row contributes
      expect(agg.errorCodeBreakdown).toEqual([
        { error_code: 'turn_cap_exceeded', count: 1 },
      ]);
    });

    it('cacheHitTotal sums cache_hit_count across matching rows', () => {
      const t0 = NOW.getTime();
      repo.insert(makeReview({
        id: 'c-1',
        status: 'completed',
        cache_hit_count: 0,
        created_at: new Date(t0),
        completed_at: new Date(t0 + 100),
      }));
      repo.insert(makeReview({
        id: 'c-2',
        status: 'completed',
        cache_hit_count: 2,
        created_at: new Date(t0 + 200),
        completed_at: new Date(t0 + 300),
      }));
      repo.insert(makeReview({
        id: 'c-3',
        status: 'completed',
        cache_hit_count: 3,
        created_at: new Date(t0 + 400),
        completed_at: new Date(t0 + 500),
      }));
      repo.insert(makeReview({
        id: 'c-4',
        status: 'completed',
        cache_hit_count: 1,
        created_at: new Date(t0 + 600),
        completed_at: new Date(t0 + 700),
      }));

      const agg = repo.aggregateByFilter({});
      expect(agg.cacheHitTotal).toBe(6);
    });

    it('new fields honour the repo filter consistently with token totals', () => {
      prs.save({
        node_id: 'PR_obs_other',
        repo_full_name: 'org/other-obs',
        number: 7,
        title: 'obs-other',
        state: 'open',
        head_sha: 'p'.repeat(40),
        base_sha: 'q'.repeat(40),
        author_login: 'alice',
        created_at: NOW,
        updated_at: NOW,
        raw_payload: '{}',
        walkthrough_comment_id: null,
      });
      repo.insert(makeReview({
        id: 'obs-main',
        pr_node_id: PR_NODE_ID,
        status: 'completed',
        hallucinated_finding_count: 4,
        cache_hit_count: 7,
      }));
      repo.insert(makeReview({
        id: 'obs-other',
        pr_node_id: 'PR_obs_other',
        status: 'completed',
        hallucinated_finding_count: 99,
        cache_hit_count: 99,
      }));

      const main = repo.aggregateByFilter({ repo: 'owner/repo' });
      const other = repo.aggregateByFilter({ repo: 'org/other-obs' });
      expect(main.hallucinatedTotal).toBe(4);
      expect(main.cacheHitTotal).toBe(7);
      expect(other.hallucinatedTotal).toBe(99);
      expect(other.cacheHitTotal).toBe(99);
    });
  });

  describe('distinctRepos', () => {
    it('returns sorted distinct repo_full_name values', () => {
      prs.save({
        node_id: 'PR_beta',
        repo_full_name: 'org/beta',
        number: 2,
        title: 'PR',
        state: 'open',
        head_sha: 'i'.repeat(40),
        base_sha: 'j'.repeat(40),
        author_login: 'user1',
        created_at: NOW,
        updated_at: NOW,
        raw_payload: '{}',
        walkthrough_comment_id: null,
      });
      repo.insert(makeReview({ id: 'dr-1', pr_node_id: PR_NODE_ID }));
      repo.insert(makeReview({ id: 'dr-2', pr_node_id: 'PR_beta' }));
      // Duplicate — same repo
      repo.insert(makeReview({ id: 'dr-3', pr_node_id: PR_NODE_ID }));

      const repos = repo.distinctRepos({}, 100);
      expect(repos).toEqual(['org/beta', 'owner/repo']);
    });

    it('reviews with null pr_node_id do not surface a null entry', () => {
      repo.insert(makeReview({ id: 'dr-null', pr_node_id: null }));
      const repos = repo.distinctRepos({}, 100);
      expect(repos).not.toContain(null);
    });
  });

  describe('distinctAuthors', () => {
    it('returns sorted distinct author_login values', () => {
      prs.save({
        node_id: 'PR_alice',
        repo_full_name: 'owner/repo',
        number: 3,
        title: 'PR',
        state: 'open',
        head_sha: 'k'.repeat(40),
        base_sha: 'l'.repeat(40),
        author_login: 'alice',
        created_at: NOW,
        updated_at: NOW,
        raw_payload: '{}',
        walkthrough_comment_id: null,
      });
      repo.insert(makeReview({ id: 'da-1', pr_node_id: PR_NODE_ID })); // octocat
      repo.insert(makeReview({ id: 'da-2', pr_node_id: 'PR_alice' })); // alice
      repo.insert(makeReview({ id: 'da-3', pr_node_id: PR_NODE_ID })); // octocat again

      const authors = repo.distinctAuthors({}, 100);
      expect(authors).toEqual(['alice', 'octocat']);
    });

    it('reviews with null pr_node_id do not surface a null entry', () => {
      repo.insert(makeReview({ id: 'da-null', pr_node_id: null }));
      const authors = repo.distinctAuthors({}, 100);
      expect(authors).not.toContain(null);
    });

    it('returns empty array when no PRs exist', () => {
      repo.insert(makeReview({ id: 'da-only-null', pr_node_id: null }));
      const authors = repo.distinctAuthors({}, 100);
      expect(authors).toEqual([]);
    });
  });
});

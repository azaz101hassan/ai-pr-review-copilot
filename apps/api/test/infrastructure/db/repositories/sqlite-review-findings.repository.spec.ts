import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '@/infrastructure/db';
import { SqliteReviewsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-reviews.repository';
import { SqliteReviewFindingsRepository } from '../../../../src/infrastructure/db/repositories/sqlite-review-findings.repository';
import { ReviewFindingInsert } from '@/modules/reviews/types/review-finding.types';
import { ReviewInsert } from '@/modules/reviews/types/review.types';

const REVIEW_ID = 'rev-parent-1';
const NOW = new Date('2026-05-27T10:00:00Z');

function makeReview(): ReviewInsert {
  return {
    id: REVIEW_ID,
    pr_node_id: null,
    created_by: null,
    diff_length: 100,
    model: 'claude-sonnet-4-6',
    prompt_version: 'v1',
    top_k: 10,
    retrieved_chunk_ids: '[]',
    retrieved_chunk_ids_hash: 'a'.repeat(64),
    status: 'completed',
    error_status: null,
    error_code: null,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    created_at: NOW,
    completed_at: NOW,
  };
}

function makeFinding(
  overrides: Partial<ReviewFindingInsert> = {},
): ReviewFindingInsert {
  return {
    id: overrides.id ?? 'find-' + Math.random().toString(36).slice(2, 10),
    review_id: REVIEW_ID,
    rule_id: 'no-var',
    severity: 'error',
    title: 'Disallow var',
    message: 'Use let or const.',
    location_hint: null,
    citation: null,
    created_at: NOW,
    ...overrides,
  };
}

describe('SqliteReviewFindingsRepository', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let reviews: SqliteReviewsRepository;
  let repo: SqliteReviewFindingsRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-find-repo-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    reviews = new SqliteReviewsRepository(db);
    repo = new SqliteReviewFindingsRepository(db);
    reviews.insert(makeReview());
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts a batch and reads back in insertion order', () => {
    const records: ReviewFindingInsert[] = [
      makeFinding({
        id: 'f1',
        created_at: new Date(NOW.getTime() + 1),
        rule_id: 'no-var',
      }),
      makeFinding({
        id: 'f2',
        created_at: new Date(NOW.getTime() + 2),
        rule_id: 'eqeqeq',
      }),
      makeFinding({
        id: 'f3',
        created_at: new Date(NOW.getTime() + 3),
        rule_id: 'max-lines-per-function',
      }),
    ];
    repo.insertMany(records);

    const found = repo.findByReviewId(REVIEW_ID);
    expect(found.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(found.map((f) => f.rule_id)).toEqual([
      'no-var',
      'eqeqeq',
      'max-lines-per-function',
    ]);
  });

  it('insertMany([]) is a no-op and does not throw', () => {
    expect(() => repo.insertMany([])).not.toThrow();
    expect(repo.findByReviewId(REVIEW_ID)).toEqual([]);
  });

  it('cascade-deletes findings when the parent review is removed', () => {
    repo.insertMany([
      makeFinding({ id: 'cf1' }),
      makeFinding({ id: 'cf2' }),
      makeFinding({ id: 'cf3' }),
    ]);
    expect(repo.findByReviewId(REVIEW_ID)).toHaveLength(3);

    db.getDb().prepare('DELETE FROM reviews WHERE id = ?').run(REVIEW_ID);
    expect(repo.findByReviewId(REVIEW_ID)).toEqual([]);
  });

  it('rejects orphan finding (review_id does not exist in reviews)', () => {
    expect(() =>
      repo.insertMany([makeFinding({ id: 'orph', review_id: 'does-not-exist' })]),
    ).toThrow(/FOREIGN KEY/);
  });

  it('persists null location_hint and citation as null (not empty string)', () => {
    repo.insertMany([
      makeFinding({ id: 'nl', location_hint: null, citation: null }),
    ]);
    const row = repo.findByReviewId(REVIEW_ID)[0];
    expect(row.location_hint).toBeNull();
    expect(row.citation).toBeNull();
  });

  // Joined SQL surfacing prior findings for a PR.
  describe('findByPrNodeIdForPriorReview', () => {
    const PR_NODE = 'PR_kwDOIVj1A85vRcDe';
    const OTHER_PR_NODE = 'PR_someoneelse';

    function makeReviewFor(
      overrides: Partial<ReviewInsert> & { id: string },
    ): ReviewInsert {
      return {
        ...makeReview(),
        pr_node_id: PR_NODE,
        ...overrides,
      };
    }

    // pr_node_id on reviews is a FK to pull_requests.node_id. Seed
    // both PR rows we'll reference so the FK constraint is satisfied
    // and we exercise the real-world shape (every review row in
    // production points at an existing PR audit row).
    beforeEach(() => {
      const seedPr = (node: string) =>
        db.getDb()
          .prepare(
            `INSERT INTO pull_requests
              (node_id, repo_full_name, number, title, state,
               head_sha, base_sha, author_login, created_at, updated_at, raw_payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            node,
            'octocat/demo',
            42,
            'demo PR',
            'open',
            'abc123',
            'def456',
            'octocat',
            NOW.getTime(),
            NOW.getTime(),
            '{}',
          );
      seedPr(PR_NODE);
      seedPr(OTHER_PR_NODE);
    });

    it('returns [] when no prior runs exist for the PR', () => {
      expect(repo.findByPrNodeIdForPriorReview(PR_NODE)).toEqual([]);
    });

    it('returns findings from a single completed prior run', () => {
      reviews.insert(
        makeReviewFor({
          id: 'rev-prev-1',
          status: 'completed',
          error_code: null,
        }),
      );
      repo.insertMany([
        makeFinding({
          id: 'pf-1',
          review_id: 'rev-prev-1',
          rule_id: 'no-console',
          location_hint: 'src/a.ts:10',
          message: 'avoid console.log',
        }),
      ]);

      const found = repo.findByPrNodeIdForPriorReview(PR_NODE);
      expect(found).toHaveLength(1);
      expect(found[0].rule_id).toBe('no-console');
      // file_path is the file portion sliced from
      // location_hint (everything before the first ':'). The raw
      // hint is preserved on location_hint for callers that want it.
      expect(found[0].file_path).toBe('src/a.ts');
      expect(found[0].location_hint).toBe('src/a.ts:10');
      expect(found[0].dismissed_at).toBeNull();
    });

    it('extracts the file portion from a line-range location_hint (F8)', () => {
      reviews.insert(
        makeReviewFor({
          id: 'rev-range',
          status: 'completed',
          error_code: null,
        }),
      );
      repo.insertMany([
        makeFinding({
          id: 'pf-range',
          review_id: 'rev-range',
          rule_id: 'no-console',
          location_hint: 'src/utils/format.ts:42-50',
        }),
      ]);

      const found = repo.findByPrNodeIdForPriorReview(PR_NODE);
      expect(found).toHaveLength(1);
      expect(found[0].file_path).toBe('src/utils/format.ts');
      expect(found[0].location_hint).toBe('src/utils/format.ts:42-50');
    });

    it('passes a hint without a colon through verbatim into file_path (F8)', () => {
      reviews.insert(
        makeReviewFor({
          id: 'rev-no-colon',
          status: 'completed',
          error_code: null,
        }),
      );
      repo.insertMany([
        makeFinding({
          id: 'pf-no-colon',
          review_id: 'rev-no-colon',
          rule_id: 'no-console',
          location_hint: 'README.md',
        }),
      ]);

      const found = repo.findByPrNodeIdForPriorReview(PR_NODE);
      expect(found[0].file_path).toBe('README.md');
    });

    it('excludes failed prior runs from the join', () => {
      reviews.insert(
        makeReviewFor({
          id: 'rev-good',
          status: 'completed',
          error_code: null,
        }),
      );
      reviews.insert(
        makeReviewFor({
          id: 'rev-bad',
          status: 'failed',
          error_code: 'github_api_error',
        }),
      );
      repo.insertMany([
        makeFinding({ id: 'g1', review_id: 'rev-good' }),
        makeFinding({ id: 'b1', review_id: 'rev-bad' }),
      ]);

      const found = repo.findByPrNodeIdForPriorReview(PR_NODE);
      expect(found).toHaveLength(1);
      expect(found[0].finding_id).toBe('g1');
    });

    it('excludes completed-with-error_code prior runs', () => {
      // Defensive — even a status='completed' row with a non-null
      // error_code (shouldn't happen by contract but the SQL filter
      // is the second layer of defense) is filtered out.
      reviews.insert(
        makeReviewFor({
          id: 'rev-completed-dirty',
          status: 'completed',
          error_code: 'late_audit_flagged',
        }),
      );
      repo.insertMany([
        makeFinding({ id: 'dirty', review_id: 'rev-completed-dirty' }),
      ]);

      expect(repo.findByPrNodeIdForPriorReview(PR_NODE)).toEqual([]);
    });

    it('orders by reviews.completed_at DESC then finding insertion order', () => {
      // Older completed run.
      reviews.insert(
        makeReviewFor({
          id: 'rev-old',
          status: 'completed',
          error_code: null,
          completed_at: new Date(NOW.getTime() - 60_000),
        }),
      );
      // Newer completed run.
      reviews.insert(
        makeReviewFor({
          id: 'rev-new',
          status: 'completed',
          error_code: null,
          completed_at: new Date(NOW.getTime() + 60_000),
        }),
      );
      repo.insertMany([
        makeFinding({
          id: 'old-f1',
          review_id: 'rev-old',
          created_at: new Date(NOW.getTime() - 50_000),
        }),
        makeFinding({
          id: 'new-f1',
          review_id: 'rev-new',
          created_at: new Date(NOW.getTime() + 70_000),
        }),
        makeFinding({
          id: 'new-f2',
          review_id: 'rev-new',
          created_at: new Date(NOW.getTime() + 71_000),
        }),
      ]);

      const found = repo.findByPrNodeIdForPriorReview(PR_NODE);
      expect(found.map((f) => f.finding_id)).toEqual([
        'new-f1',
        'new-f2',
        'old-f1',
      ]);
    });

    it('ignores findings whose parent review is for a different PR', () => {
      reviews.insert(
        makeReviewFor({
          id: 'rev-mine',
          status: 'completed',
          error_code: null,
        }),
      );
      reviews.insert(
        makeReviewFor({
          id: 'rev-other',
          pr_node_id: OTHER_PR_NODE,
          status: 'completed',
          error_code: null,
        }),
      );
      repo.insertMany([
        makeFinding({ id: 'm1', review_id: 'rev-mine' }),
        makeFinding({ id: 'o1', review_id: 'rev-other' }),
      ]);

      const found = repo.findByPrNodeIdForPriorReview(PR_NODE);
      expect(found.map((f) => f.finding_id)).toEqual(['m1']);
    });

    it('maps a null location_hint to empty string in file_path / location_hint', () => {
      reviews.insert(
        makeReviewFor({
          id: 'rev-no-hint',
          status: 'completed',
          error_code: null,
        }),
      );
      repo.insertMany([
        makeFinding({
          id: 'nh1',
          review_id: 'rev-no-hint',
          location_hint: null,
        }),
      ]);

      const found = repo.findByPrNodeIdForPriorReview(PR_NODE);
      expect(found[0].file_path).toBe('');
      expect(found[0].location_hint).toBe('');
    });
  });
});

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
});

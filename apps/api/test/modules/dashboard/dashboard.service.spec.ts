import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/infrastructure/db/database.service';
import { SqliteReviewsRepository } from '@/infrastructure/db/repositories/sqlite-reviews.repository';
import { SqlitePullRequestsRepository } from '@/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { SqliteKnowledgeChunksRepository } from '@/infrastructure/db/repositories/sqlite-knowledge-chunks.repository';
import { SqliteKnowledgeSourcesRepository } from '@/infrastructure/db/repositories/sqlite-knowledge-sources.repository';
import { SqliteReviewFindingsRepository } from '@/infrastructure/db/repositories/sqlite-review-findings.repository';
import { ConfigService } from '@/config';
import { DashboardService } from '@/modules/dashboard/dashboard.service';
import { FilterSpecDto } from '@/modules/dashboard/types/dto/filter-spec.dto';
import { ReviewInsert } from '@/modules/reviews/types/review.types';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';
import { KnowledgeSourceInsert } from '@/modules/embeddings/types/knowledge-source.types';
import { KnowledgeChunkInsert } from '@/modules/embeddings/types/knowledge-chunk.types';
import { ReviewFindingInsert } from '@/modules/reviews/types/review-finding.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let reviewCounter = 0;

function makeReview(overrides: Partial<ReviewInsert> = {}): ReviewInsert {
  reviewCounter++;
  return {
    id: `rev-${reviewCounter}`,
    pr_node_id: overrides.pr_node_id !== undefined ? overrides.pr_node_id : null,
    created_by: null,
    diff_length: 100,
    model: 'claude-haiku',
    prompt_version: overrides.prompt_version ?? 'v1',
    top_k: 10,
    retrieved_chunk_ids: overrides.retrieved_chunk_ids ?? '[]',
    retrieved_chunk_ids_hash: 'abc',
    status: overrides.status ?? 'completed',
    error_status: null,
    error_code: null,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    created_at: overrides.created_at ?? new Date('2024-01-01T10:00:00Z'),
    completed_at: overrides.completed_at ?? new Date('2024-01-01T10:01:00Z'),
    ...overrides,
  };
}

function makePr(overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    node_id: overrides.node_id ?? 'PR_node_1',
    repo_full_name: overrides.repo_full_name ?? 'org/repo',
    number: overrides.number ?? 1,
    title: overrides.title ?? 'Test PR',
    state: 'open',
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    author_login: overrides.author_login ?? 'octocat',
    created_at: overrides.created_at ?? new Date('2024-01-01'),
    updated_at: overrides.updated_at ?? new Date('2024-01-01'),
    raw_payload: '{}',
    ...overrides,
  };
}

function makeSource(overrides: Partial<KnowledgeSourceInsert> = {}): KnowledgeSourceInsert {
  return {
    id: 'test-source',
    name: 'Test Source',
    description: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeChunk(overrides: Partial<KnowledgeChunkInsert> = {}): KnowledgeChunkInsert {
  return {
    id: `chunk-${Math.random().toString(36).slice(2, 8)}`,
    source_id: 'test-source',
    rule_id: 'no-var',
    title: 'No var',
    body: 'Do not use var.',
    severity: 'warning',
    language: 'javascript',
    category: null,
    embedding_model: 'voyage-code-3',
    embedding_dim: 1024,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeFinding(reviewId: string, overrides: Partial<ReviewFindingInsert> = {}): ReviewFindingInsert {
  return {
    id: `f-${Math.random().toString(36).slice(2, 8)}`,
    review_id: reviewId,
    rule_id: 'no-var',
    title: 'No var violation',
    message: 'Found var',
    severity: 'warning',
    location_hint: null,
    citation: null,
    created_at: new Date(),
    ...overrides,
  };
}

// Opens a fresh isolated SQLite database.
function openFreshDb(): { db: DatabaseService; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-svc-'));
  const db = new DatabaseService();
  db.open(path.join(tmpDir, 'test.sqlite'));
  return { db, tmpDir };
}

function closeDb(db: DatabaseService, tmpDir: string): void {
  db.onApplicationShutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeDashboardService(db: DatabaseService): {
  service: DashboardService;
  reviewRepo: SqliteReviewsRepository;
  prRepo: SqlitePullRequestsRepository;
  chunkRepo: SqliteKnowledgeChunksRepository;
  sourceRepo: SqliteKnowledgeSourcesRepository;
  findingRepo: SqliteReviewFindingsRepository;
} {
  const reviewRepo = new SqliteReviewsRepository(db);
  const prRepo = new SqlitePullRequestsRepository(db);
  const chunkRepo = new SqliteKnowledgeChunksRepository(db);
  const sourceRepo = new SqliteKnowledgeSourcesRepository(db);
  const findingRepo = new SqliteReviewFindingsRepository(db);

  const service = new DashboardService(
    reviewRepo,
    prRepo,
    chunkRepo,
    sourceRepo,
    {
      anthropicModel: 'claude-haiku-4-5',
      embeddingModel: 'voyage-code-3',
      chromaCollection: 'code-style-rules',
    } as ConfigService,
  );

  return { service, reviewRepo, prRepo, chunkRepo, sourceRepo, findingRepo };
}

// ---------------------------------------------------------------------------
// getReviews
// ---------------------------------------------------------------------------

describe('DashboardService.getReviews', () => {
  let db: DatabaseService;
  let tmpDir: string;
  let service: DashboardService;
  let reviewRepo: SqliteReviewsRepository;

  beforeAll(() => {
    ({ db, tmpDir } = openFreshDb());
    ({ service, reviewRepo } = makeDashboardService(db));
  });

  afterAll(() => closeDb(db, tmpDir));

  it('returns paginated list with default limit=50 and offset=0 when no filter', () => {
    reviewRepo.insert(makeReview({ pr_node_id: null }));

    const dto = new FilterSpecDto();
    const result = service.getReviews(dto);

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(50);
  });

  it('returns items in descending created_at order', () => {
    const now = Date.now();
    const older = makeReview({ pr_node_id: null, created_at: new Date(now - 5000) });
    const newer = makeReview({ pr_node_id: null, created_at: new Date(now - 1000) });
    reviewRepo.insert(older);
    reviewRepo.insert(newer);

    const dto = new FilterSpecDto();
    const result = service.getReviews(dto);

    const ids = result.items.map((i) => i.id);
    const idxNewer = ids.indexOf(newer.id);
    const idxOlder = ids.indexOf(older.id);
    expect(idxNewer).toBeLessThan(idxOlder);
  });

  it('respects custom offset and limit', () => {
    const { db: db2, tmpDir: tmp2 } = openFreshDb();
    const { service: svc2, reviewRepo: rr2 } = makeDashboardService(db2);
    try {
      for (let i = 0; i < 5; i++) {
        rr2.insert(makeReview({ pr_node_id: null, created_at: new Date(Date.now() - i * 1000) }));
      }

      const dto = new FilterSpecDto();
      dto.offset = 2;
      dto.limit = 2;

      const result = svc2.getReviews(dto);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.offset).toBe(2);
      expect(result.limit).toBe(2);
    } finally {
      closeDb(db2, tmp2);
    }
  });

  it('includes reviews with null pr_node_id with null PR metadata (AE3)', () => {
    const { db: db2, tmpDir: tmp2 } = openFreshDb();
    const { service: svc2, reviewRepo: rr2 } = makeDashboardService(db2);
    try {
      rr2.insert(makeReview({ pr_node_id: null }));

      const dto = new FilterSpecDto();
      const result = svc2.getReviews(dto);

      expect(result.items[0].pr_node_id).toBeNull();
      expect(result.items[0].repo_full_name).toBeNull();
      expect(result.items[0].author_login).toBeNull();
    } finally {
      closeDb(db2, tmp2);
    }
  });

  it('returns empty list without erroring when filter matches nothing', () => {
    const { db: db2, tmpDir: tmp2 } = openFreshDb();
    const { service: svc2, reviewRepo: rr2 } = makeDashboardService(db2);
    try {
      rr2.insert(makeReview({ pr_node_id: null }));

      const dto = new FilterSpecDto();
      dto.repo = 'org/nonexistent';

      const result = svc2.getReviews(dto);
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    } finally {
      closeDb(db2, tmp2);
    }
  });
});

// ---------------------------------------------------------------------------
// getReviewDetail
// ---------------------------------------------------------------------------

describe('DashboardService.getReviewDetail', () => {
  let db: DatabaseService;
  let tmpDir: string;
  let service: DashboardService;
  let reviewRepo: SqliteReviewsRepository;
  let chunkRepo: SqliteKnowledgeChunksRepository;
  let sourceRepo: SqliteKnowledgeSourcesRepository;
  let findingRepo: SqliteReviewFindingsRepository;

  beforeAll(() => {
    ({ db, tmpDir } = openFreshDb());
    ({ service, reviewRepo, chunkRepo, sourceRepo, findingRepo } = makeDashboardService(db));

    // Seed a knowledge source + chunk
    sourceRepo.upsert(makeSource({ id: 'detail-src' }));
  });

  afterAll(() => closeDb(db, tmpDir));

  it('throws NotFoundException for unknown review id', () => {
    expect(() => service.getReviewDetail('does-not-exist')).toThrow(NotFoundException);
  });

  it('returns review + findings + hydrated chunks for a known review', () => {
    chunkRepo.upsertMany([makeChunk({ id: 'detail-chunk-1', source_id: 'detail-src' })]);

    const review = makeReview({
      id: 'detail-happy',
      pr_node_id: null,
      retrieved_chunk_ids: JSON.stringify(['detail-chunk-1']),
    });
    reviewRepo.insert(review);
    findingRepo.insertMany([makeFinding('detail-happy')]);

    const result = service.getReviewDetail('detail-happy');

    expect(result.review.id).toBe('detail-happy');
    expect(result.findings).toHaveLength(1);
    expect(result.retrievedChunks).toHaveLength(1);
    expect(result.retrievedChunks[0]).toMatchObject({
      id: 'detail-chunk-1',
      missing: false,
      rule_id: 'no-var',
      body: 'Do not use var.',
    });
  });

  it('returns missing placeholder when chunk is not in knowledge_chunks', () => {
    const review = makeReview({
      id: 'orphan-review',
      pr_node_id: null,
      retrieved_chunk_ids: JSON.stringify(['ghost-chunk-99']),
    });
    reviewRepo.insert(review);

    const result = service.getReviewDetail('orphan-review');

    expect(result.retrievedChunks).toHaveLength(1);
    expect(result.retrievedChunks[0]).toEqual({ id: 'ghost-chunk-99', missing: true });
  });

  it('returns review with null PR metadata when pr_node_id is null (AE3)', () => {
    const review = makeReview({ id: 'null-pr-detail', pr_node_id: null });
    reviewRepo.insert(review);

    const result = service.getReviewDetail('null-pr-detail');
    expect(result.review.pr_node_id).toBeNull();
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAnalytics
// ---------------------------------------------------------------------------

describe('DashboardService.getAnalytics', () => {
  it('returns zero-everywhere for empty filter window (no matching rows)', () => {
    const { db, tmpDir } = openFreshDb();
    const { service } = makeDashboardService(db);
    try {
      const dto = new FilterSpecDto();
      dto.repo = 'org/truly-nonexistent-' + Date.now();

      const result = service.getAnalytics(dto);

      expect(result.statusBreakdown.completed).toBe(0);
      expect(result.statusBreakdown.failed).toBe(0);
      expect(result.statusBreakdown.in_progress).toBe(0);
      expect(result.severityRollup.error).toBe(0);
      expect(result.severityRollup.warning).toBe(0);
      expect(result.severityRollup.info).toBe(0);
      expect(result.topRules).toHaveLength(0);
      expect(result.latency.p50).toBeNull();
      expect(result.latency.p95).toBeNull();
    } finally {
      closeDb(db, tmpDir);
    }
  });

  it('excludes standalone rows from every metric', () => {
    const { db, tmpDir } = openFreshDb();
    const { service, reviewRepo } = makeDashboardService(db);
    try {
      reviewRepo.insert(makeReview({
        pr_node_id: null,
        prompt_version: 'standalone-failure',
        status: 'failed',
      }));
      reviewRepo.insert(makeReview({
        pr_node_id: null,
        prompt_version: 'standalone-empty-diff',
        status: 'completed',
      }));

      const dto = new FilterSpecDto();
      const result = service.getAnalytics(dto);

      // Standalone rows must NOT appear in the aggregate
      expect(result.statusBreakdown.failed).toBe(0);
      expect(result.statusBreakdown.completed).toBe(0);
    } finally {
      closeDb(db, tmpDir);
    }
  });

  it('aggregates real completed and failed rows correctly', () => {
    const { db, tmpDir } = openFreshDb();
    const { service, reviewRepo, findingRepo } = makeDashboardService(db);
    try {
      const r1 = makeReview({ pr_node_id: null, status: 'completed' });
      const r2 = makeReview({ pr_node_id: null, status: 'failed' });
      reviewRepo.insert(r1);
      reviewRepo.insert(r2);

      findingRepo.insertMany([makeFinding(r1.id, { rule_id: 'no-var', severity: 'warning' })]);

      const dto = new FilterSpecDto();
      const result = service.getAnalytics(dto);

      expect(result.statusBreakdown.completed).toBe(1);
      expect(result.statusBreakdown.failed).toBe(1);
      expect(result.severityRollup.warning).toBe(1);
      expect(result.topRules).toHaveLength(1);
      expect(result.topRules[0].rule_id).toBe('no-var');
    } finally {
      closeDb(db, tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// getFilterOptions
// ---------------------------------------------------------------------------

describe('DashboardService.getFilterOptions', () => {
  let db: DatabaseService;
  let tmpDir: string;
  let service: DashboardService;

  beforeAll(() => {
    ({ db, tmpDir } = openFreshDb());
    const { service: svc, prRepo, reviewRepo } = makeDashboardService(db);
    service = svc;

    prRepo.save(makePr({ node_id: 'PR_f1', repo_full_name: 'org/filter-repo', author_login: 'filter-user' }));
    reviewRepo.insert(makeReview({ pr_node_id: 'PR_f1' }));
  });

  afterAll(() => closeDb(db, tmpDir));

  it('returns distinct repos from the joined pull_requests', () => {
    const dto = new FilterSpecDto();
    const result = service.getFilterOptions(dto);
    expect(result.repos).toContain('org/filter-repo');
  });

  it('returns distinct authors from the joined pull_requests', () => {
    const dto = new FilterSpecDto();
    const result = service.getFilterOptions(dto);
    expect(result.authors).toContain('filter-user');
  });

  it('returns recentPrs from the pull_requests table', () => {
    const dto = new FilterSpecDto();
    const result = service.getFilterOptions(dto);
    expect(result.recentPrs.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// getSettings
// ---------------------------------------------------------------------------

describe('DashboardService.getSettings', () => {
  let db: DatabaseService;
  let tmpDir: string;
  let service: DashboardService;

  beforeAll(() => {
    ({ db, tmpDir } = openFreshDb());
    ({ service } = makeDashboardService(db));
  });

  afterAll(() => closeDb(db, tmpDir));

  it('returns positive allowlist fields', async () => {
    const result = await service.getSettings();

    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.embeddingModel).toBe('voyage-code-3');
    expect(result.chromaCollection).toBe('code-style-rules');
    expect(Array.isArray(result.knowledgeSources)).toBe(true);
    expect(result.severityGate).toMatchObject({
      allowed: expect.arrayContaining(['error', 'warning', 'info']),
      default: 'warning',
    });
  });
});

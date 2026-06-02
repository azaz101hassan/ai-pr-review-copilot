import { DynamicModule, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { ConfigModule, ConfigService } from '@/config';
import { DatabaseModule } from '@/infrastructure/db';
import { EmbeddingsModule } from '@/modules/embeddings';
import {
  EMBEDDING_PROVIDER,
  IEmbeddingProvider,
} from '@/modules/embeddings/types/embedding-provider';
import {
  VECTOR_STORE,
  IVectorStore,
  VectorStoreItem,
  VectorStoreQueryOptions,
  VectorStoreHit,
} from '@/modules/embeddings/types/vector-store';
import {
  AnalyzeDiffResult,
  ILlmReviewer,
  LLM_REVIEWER,
  PROMPT_AND_TOOL_VERSION,
} from '@/modules/reviews/types/llm-reviewer';
import { ReviewsModule } from '@/modules/reviews/reviews.module';
import { DashboardModule } from '@/modules/dashboard';
import { HealthController } from '@/system';
import { REVIEW_REPOSITORY } from '@/modules/reviews/types/review.repository';
import { SqliteReviewsRepository } from '@/infrastructure/db/repositories/sqlite-reviews.repository';
import { SqlitePullRequestsRepository } from '@/infrastructure/db/repositories/sqlite-pull-requests.repository';
import { PULL_REQUEST_REPOSITORY } from '@/modules/webhooks/types/pull-request.repository';
import { ReviewInsert } from '@/modules/reviews/types/review.types';

// ---------------------------------------------------------------------------
// Test module factory
// ---------------------------------------------------------------------------

function makeTestModule(): DynamicModule {
  return {
    module: class TestAppModule {},
    imports: [
      ConfigModule,
      DatabaseModule,
      ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 30 }]),
      EmbeddingsModule,
      ReviewsModule.forRoot(),
      DashboardModule,
    ],
    controllers: [HealthController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  };
}

// ---------------------------------------------------------------------------
// Minimal stubs for LLM + vector store (so the full AppModule boots offline)
// ---------------------------------------------------------------------------

class StubEmbeddingProvider implements IEmbeddingProvider {
  readonly modelName = 'stub-embedding';
  readonly dimension = 64;
  async embedDocuments(texts: string[]) {
    return { vectors: texts.map(() => new Array(64).fill(0) as number[]), tokensUsed: 0 };
  }
  async embedQuery() {
    return { vector: new Array(64).fill(0) as number[], tokensUsed: 0 };
  }
}

class StubVectorStore implements IVectorStore {
  async ensureCollection() { /* no-op */ }
  async upsert() { /* no-op */ }
  async query(_opts: VectorStoreQueryOptions): Promise<VectorStoreHit[]> { return []; }
  async deleteAll() { /* no-op */ }
}

class StubLlmReviewer implements ILlmReviewer {
  async analyzeDiff(): Promise<AnalyzeDiffResult> {
    return {
      findings: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      model: 'stub',
      promptVersion: PROMPT_AND_TOOL_VERSION,
      turnCount: 1,
      toolCalls: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Env snapshot helpers
// ---------------------------------------------------------------------------

type EnvState = Record<string, string | undefined>;
function snapshotEnv(keys: string[]): EnvState {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}
function restoreEnv(snapshot: EnvState): void {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Review seed helper
// ---------------------------------------------------------------------------

function makeReviewInsert(overrides: Partial<ReviewInsert> = {}): ReviewInsert {
  return {
    id: `e2e-rev-${Math.random().toString(36).slice(2, 8)}`,
    pr_node_id: null,
    created_by: null,
    diff_length: 100,
    model: 'claude-haiku',
    prompt_version: 'v1',
    top_k: 10,
    retrieved_chunk_ids: '[]',
    retrieved_chunk_ids_hash: 'abc',
    status: 'completed',
    error_status: null,
    error_code: null,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    created_at: new Date(),
    completed_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Dashboard REST e2e tests
// ---------------------------------------------------------------------------

describe('Dashboard REST endpoints (e2e)', () => {
  let app: INestApplication;
  let tmpDir: string;
  let envSnapshot: EnvState;
  let reviewsRepo: SqliteReviewsRepository;
  let prRepo: SqlitePullRequestsRepository;
  let config: ConfigService;

  const SNAPSHOT_KEYS = [
    'GITHUB_WEBHOOK_SECRET',
    'VOYAGE_API_KEY',
    'ANTHROPIC_API_KEY',
    'DATABASE_PATH',
    'ENABLE_DRY_RUN',
    'NODE_ENV',
  ];

  beforeAll(async () => {
    envSnapshot = snapshotEnv(SNAPSHOT_KEYS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-e2e-'));

    process.env.GITHUB_WEBHOOK_SECRET = 'dashboard-e2e-secret-0123456789';
    process.env.VOYAGE_API_KEY = 'voyage-e2e-key-0123456789abcdef';
    process.env.ANTHROPIC_API_KEY = 'anthropic-e2e-key-0123456789abcdef';
    process.env.DATABASE_PATH = path.join(tmpDir, 'dashboard-e2e.sqlite');
    process.env.ENABLE_DRY_RUN = 'false';
    process.env.NODE_ENV = 'development';

    const moduleRef = await Test.createTestingModule({ imports: [makeTestModule()] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(new StubEmbeddingProvider())
      .overrideProvider(VECTOR_STORE)
      .useValue(new StubVectorStore())
      .overrideProvider(LLM_REVIEWER)
      .useValue(new StubLlmReviewer())
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    reviewsRepo = moduleRef.get(REVIEW_REPOSITORY) as SqliteReviewsRepository;
    prRepo = moduleRef.get(PULL_REQUEST_REPOSITORY) as SqlitePullRequestsRepository;
    config = moduleRef.get(ConfigService);

    // Seed a pull request and a review for list / detail tests
    prRepo.save({
      node_id: 'PR_e2e_1',
      repo_full_name: 'org/e2e-repo',
      number: 1,
      title: 'E2E Test PR',
      state: 'open',
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      author_login: 'e2e-author',
      created_at: new Date('2024-01-01'),
      updated_at: new Date('2024-01-01'),
      raw_payload: '{}',
      walkthrough_comment_id: null,
    });

    reviewsRepo.insert(makeReviewInsert({
      id: 'e2e-rev-seeded',
      pr_node_id: 'PR_e2e_1',
      status: 'completed',
    }));

    // Also insert a standalone-failure row to verify analytics exclusion
    reviewsRepo.insert(makeReviewInsert({
      id: 'e2e-standalone',
      pr_node_id: null,
      prompt_version: 'standalone-failure',
      status: 'failed',
    }));
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  // ---------------------------------------------------------------------------
  // GET /dashboard/reviews — happy path
  // ---------------------------------------------------------------------------

  describe('GET /dashboard/reviews', () => {
    it('returns paginated review list with expected envelope shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/reviews')
        .expect(200);

      expect(res.body).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        offset: 0,
        limit: 50,
      });
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });

    it('accepts and applies repo filter', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/reviews?repo=org%2Fe2e-repo')
        .expect(200);

      expect(res.body.items.every((i: { repo_full_name: string }) => i.repo_full_name === 'org/e2e-repo')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /dashboard/reviews/:id — happy path and 404
  // ---------------------------------------------------------------------------

  describe('GET /dashboard/reviews/:id', () => {
    it('returns review + findings + retrievedChunks for known review', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/reviews/e2e-rev-seeded')
        .expect(200);

      expect(res.body).toMatchObject({
        review: { id: 'e2e-rev-seeded' },
        findings: expect.any(Array),
        retrievedChunks: expect.any(Array),
      });
    });

    it('returns 404 for unknown review id', async () => {
      await request(app.getHttpServer())
        .get('/dashboard/reviews/not-a-real-id')
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /dashboard/analytics
  // ---------------------------------------------------------------------------

  describe('GET /dashboard/analytics', () => {
    it('returns analytics aggregate without erroring', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/analytics')
        .expect(200);

      expect(res.body).toMatchObject({
        statusBreakdown: expect.any(Object),
        severityRollup: expect.any(Object),
        topRules: expect.any(Array),
        tokenTotals: expect.any(Object),
        latency: expect.any(Object),
      });
    });

    it('returns zero-everywhere for a filter that matches nothing', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/analytics?repo=no-such-org%2Fno-such-repo')
        .expect(200);

      expect(res.body.statusBreakdown.completed).toBe(0);
      expect(res.body.statusBreakdown.failed).toBe(0);
      expect(res.body.latency.p50).toBeNull();
      expect(res.body.latency.p95).toBeNull();
    });

    it('excludes standalone rows from analytics (the seeded standalone-failure row must not appear in completed/failed counts)', async () => {
      // The standalone-failure row should NOT appear in the aggregate
      const res = await request(app.getHttpServer())
        .get('/dashboard/analytics')
        .expect(200);

      // The e2e-standalone row has prompt_version=standalone-failure and
      // status=failed — if it were included, failed would be >= 1.
      // The only real rows are the seeded completed review. So the
      // standalone row should NOT bump the failed count beyond the real rows.
      const standaloneRow = reviewsRepo.findById('e2e-standalone');
      expect(standaloneRow?.prompt_version).toBe('standalone-failure');
      // Analytics must exclude it — the only "real" review is completed
      expect(res.body.statusBreakdown.completed).toBeGreaterThanOrEqual(1);
      // failed count should be 0 (only the standalone row was failed, and it's excluded)
      expect(res.body.statusBreakdown.failed).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /dashboard/filters
  // ---------------------------------------------------------------------------

  describe('GET /dashboard/filters', () => {
    it('returns repos, authors, recentPrs', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/filters')
        .expect(200);

      expect(res.body).toMatchObject({
        repos: expect.any(Array),
        authors: expect.any(Array),
        recentPrs: expect.any(Array),
      });
      expect(res.body.repos).toContain('org/e2e-repo');
      expect(res.body.authors).toContain('e2e-author');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /dashboard/settings — AE4 secret-leak check (CRITICAL)
  // ---------------------------------------------------------------------------

  describe('GET /dashboard/settings', () => {
    it('returns the positive allowlist (model, embeddingModel, chromaCollection, knowledgeSources, severityGate)', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/settings')
        .expect(200);

      expect(res.body).toMatchObject({
        model: expect.any(String),
        embeddingModel: expect.any(String),
        chromaCollection: expect.any(String),
        knowledgeSources: expect.any(Array),
        severityGate: {
          allowed: expect.arrayContaining(['error', 'warning', 'info']),
          default: 'warning',
        },
      });
    });

    // AE4: the response body must NOT contain the runtime values of any secret field.
    // This test uses the real ConfigService (via the full test module) so value
    // mis-wiring (e.g. model: this.config.anthropicApiKey) fails this assertion.
    it('AE4: response body contains none of the secret field values', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/settings')
        .expect(200);

      const body = JSON.stringify(res.body);

      // Each assertion is a separate expect so the failure message identifies
      // which secret leaked.
      expect(body).not.toContain(config.appId);
      expect(body).not.toContain(config.redisUrl);
      expect(body).not.toContain(config.anthropicApiKey);
      expect(body).not.toContain(config.voyageApiKey);
      expect(body).not.toContain(config.githubWebhookSecret);
      expect(body).not.toContain(config.databasePath);

      // appPrivateKey may contain newlines that don't survive JSON round-trip exactly;
      // test for the PEM start marker which would definitely appear if leaked.
      expect(body).not.toContain('-----BEGIN');

      // dogfoodRepos is a Set — join to a string for substring check.
      const dogfoodStr = [...config.dogfoodRepos].join(',');
      if (dogfoodStr.length > 0) {
        expect(body).not.toContain(dogfoodStr);
      }
    });

    it('response shape contains exactly the allowlisted fields (no extra secrets)', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/settings')
        .expect(200);

      const keys = Object.keys(res.body);
      // Only these five keys should be in the response
      const ALLOWED_KEYS = ['model', 'embeddingModel', 'chromaCollection', 'knowledgeSources', 'severityGate'];
      for (const key of keys) {
        expect(ALLOWED_KEYS).toContain(key);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // FilterSpecDto validation via real ValidationPipe
  // ---------------------------------------------------------------------------

  describe('ValidationPipe enforcement (AE5)', () => {
    it('rejects invalid repo with SQL-injection-like chars with 400', async () => {
      // The %3B is a semicolon which is not in [a-zA-Z0-9_\-./@]
      await request(app.getHttpServer())
        .get('/dashboard/reviews?repo=org%3BDROP')
        .expect(400);
    });

    it('rejects limit=99999 (over @Max(200)) with 400', async () => {
      await request(app.getHttpServer())
        .get('/dashboard/reviews?limit=99999')
        .expect(400);
    });

    it('rejects limit=0 (below @Min(1)) with 400', async () => {
      await request(app.getHttpServer())
        .get('/dashboard/reviews?limit=0')
        .expect(400);
    });

    it('accepts valid filter params with 200', async () => {
      await request(app.getHttpServer())
        .get('/dashboard/reviews?repo=org%2Frepo&limit=10&offset=0')
        .expect(200);
    });
  });
});

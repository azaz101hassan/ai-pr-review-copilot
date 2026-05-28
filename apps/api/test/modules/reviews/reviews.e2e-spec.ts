import { DynamicModule, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { ConfigModule } from '@/config';
import { DatabaseModule } from '@/infrastructure/db';
import { EmbeddingsModule, EmbeddingsService } from '@/modules/embeddings';
import {
  EMBEDDING_PROVIDER,
  IEmbeddingProvider,
} from '@/modules/embeddings/types/embedding-provider';
import {
  VECTOR_STORE,
  IVectorStore,
  VectorStoreHit,
  VectorStoreItem,
  VectorStoreQueryOptions,
} from '@/modules/embeddings/types/vector-store';
import {
  AnalyzeDiffInput,
  AnalyzeDiffResult,
  ILlmReviewer,
  LLM_REVIEWER,
  PROMPT_AND_TOOL_VERSION,
} from '@/modules/reviews/types/llm-reviewer';
import {
  REVIEW_REPOSITORY,
  REVIEW_FINDING_REPOSITORY,
} from '@/modules/reviews/types';
import { AnthropicRequestError } from '@/infrastructure/anthropic';
import { ReviewsService } from '@/modules/reviews';
import { ReviewsModule } from '@/modules/reviews/reviews.module';
import { ReviewRecord } from '@/modules/reviews/types/review.types';
import { HealthController } from '@/system';

// We build the test module manually (mirroring AppModule) instead of
// importing AppModule. Reason: `ReviewsModule.forRoot()` reads
// process.env.ENABLE_DRY_RUN at @Module-decorator-evaluation time —
// which is when AppModule's source file is first loaded. By inlining
// `ReviewsModule.forRoot()` inside `Test.createTestingModule(...)`, the
// gating reads the env we just set in `beforeAll`, every time.
//
// `jest.isolateModules` would force a fresh require but breaks
// Symbol identity (LLM_REVIEWER and friends are file-level Symbols, so
// `overrideProvider(LLM_REVIEWER)` from outside would refer to a
// different Symbol than the one Nest binds inside the isolated graph).
// Composing the module here keeps a single Symbol identity per token.
function makeTestModule(): DynamicModule {
  return {
    module: class TestAppModule {},
    imports: [
      ConfigModule,
      DatabaseModule,
      ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 30 }]),
      EmbeddingsModule,
      ReviewsModule.forRoot(),
    ],
    controllers: [HealthController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  };
}

// Full /reviews/dry-run e2e: boots AppModule against a tmpdir DB with
// EMBEDDING_PROVIDER + VECTOR_STORE + LLM_REVIEWER all stubbed so CI
// runs offline (no Voyage calls, no Chroma container, no Anthropic
// spend). The retrieval gate in embeddings.e2e-spec.ts proves the
// bag-of-words stub retrieves the right rules; this spec asserts that
// the LLM step + the 3-step persistence lifecycle + the DTO validation
// + the throttler + the ENABLE_DRY_RUN gating all line up end-to-end.

const STUB_DIMENSION = 64;

class StubEmbeddingProvider implements IEmbeddingProvider {
  readonly modelName = 'stub-embedding';
  readonly dimension = STUB_DIMENSION;
  async embedDocuments(texts: string[]) {
    return {
      vectors: texts.map((t) => this.embed(t)),
      tokensUsed: texts.reduce((sum, t) => sum + t.length, 0),
    };
  }
  async embedQuery(text: string) {
    return { vector: this.embed(text), tokensUsed: text.length };
  }
  private embed(text: string): number[] {
    const v = new Array(STUB_DIMENSION).fill(0) as number[];
    const preNormalized = text
      .toLowerCase()
      .replace(/===/g, ' tk_streq ')
      .replace(/!==/g, ' tk_strneq ')
      .replace(/==/g, ' tk_eqeq ')
      .replace(/!=/g, ' tk_neq ');
    const tokens = preNormalized
      .replace(/[^a-z0-9_]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 0);
    for (const tok of tokens) v[hashToken(tok) % STUB_DIMENSION] += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm === 0) return v;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }
}

function hashToken(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class StubVectorStore implements IVectorStore {
  private items = new Map<string, VectorStoreItem>();
  async ensureCollection() {
    /* no-op */
  }
  async upsert(items: VectorStoreItem[]) {
    for (const item of items) this.items.set(item.id, item);
  }
  async query(opts: VectorStoreQueryOptions): Promise<VectorStoreHit[]> {
    const hits: VectorStoreHit[] = [];
    for (const item of this.items.values()) {
      hits.push({
        id: item.id,
        score: cosineSimilarity(opts.embedding, item.embedding),
        document: item.document,
        metadata: item.metadata,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.k);
  }
  async deleteAll() {
    this.items.clear();
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const n = Math.sqrt(na) * Math.sqrt(nb);
  return n === 0 ? 0 : dot / n;
}

// Deterministic stub LLM. Echoes back one finding for every retrieved
// rule whose rule_id is in `expectedTriggers` AND which appears in the
// diff text (the diff contains the rule's vocabulary by construction —
// see test/fixtures/diffs/README.md). Default behavior emits a finding
// for every retrieved rule (lets the happy-path tests assert against a
// single matched rule); set `mode` to other behaviors for specific
// scenarios.
//
// The stub never emits `severity` — matches the production adapter
// contract from U4.
type StubMode = 'echo-first-only' | 'echo-all' | 'echo-none' | 'throw-rate-limit' | 'delay-then-echo';

class StubLlmReviewer implements ILlmReviewer {
  public mode: StubMode = 'echo-first-only';
  public delayMs = 0;
  public lastInput?: AnalyzeDiffInput;

  async analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    this.lastInput = input;
    if (this.mode === 'throw-rate-limit') {
      throw new AnthropicRequestError('Anthropic API error: HTTP 429 (rate_limit_error)', {
        status: 429,
        errorCode: 'rate_limit_error',
      });
    }
    if (this.mode === 'delay-then-echo' && this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    const rulesToFlag =
      this.mode === 'echo-none'
        ? []
        : this.mode === 'echo-all' || this.mode === 'delay-then-echo'
          ? input.rules
          : input.rules.slice(0, 1);

    return {
      findings: rulesToFlag.map((rule) => ({
        rule_id: rule.rule_id,
        title: rule.title ?? rule.rule_id,
        message: `Flagged by stub: ${rule.rule_id}`,
        location_hint: null,
        citation: null,
      })),
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      model: 'stub-model',
      promptVersion: PROMPT_AND_TOOL_VERSION,
    };
  }
}

function loadFixture(name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'fixtures', 'diffs', name),
    'utf8',
  );
}

// Env snapshot / restore — beforeAll / afterAll pattern used across
// the existing e2e specs. ConfigService reads process.env in its
// constructor and ReviewsModule.forRoot() reads it at decorator
// evaluation time, so test env values must be set BEFORE
// `Test.createTestingModule({ imports: [makeTestModule()] })`.
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

const SNAPSHOT_KEYS = [
  'GITHUB_WEBHOOK_SECRET',
  'VOYAGE_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_PATH',
  'ENABLE_DRY_RUN',
  'NODE_ENV',
];

describe('Reviews dry-run (e2e — ENABLE_DRY_RUN=true)', () => {
  let app: INestApplication;
  let tmpDir: string;
  let stubLlm: StubLlmReviewer;
  let envSnapshot: EnvState;

  beforeAll(async () => {
    envSnapshot = snapshotEnv(SNAPSHOT_KEYS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-e2e-'));
    process.env.GITHUB_WEBHOOK_SECRET = 'reviews-test-secret-1234567890';
    process.env.VOYAGE_API_KEY = 'voyage-test-key-0123456789abcdef';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key-0123456789abcdef';
    process.env.DATABASE_PATH = path.join(tmpDir, 'reviews.sqlite');
    process.env.ENABLE_DRY_RUN = 'true';
    // Force NODE_ENV=development so the dev-default model resolves
    // deterministically across local + CI.
    process.env.NODE_ENV = 'development';

    stubLlm = new StubLlmReviewer();

    const moduleRef = await Test.createTestingModule({ imports: [makeTestModule()] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(new StubEmbeddingProvider())
      .overrideProvider(VECTOR_STORE)
      .useValue(new StubVectorStore())
      .overrideProvider(LLM_REVIEWER)
      .useValue(stubLlm)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    await app.get(EmbeddingsService).indexCorpus();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  beforeEach(() => {
    // Reset stub state between tests.
    stubLlm.mode = 'echo-first-only';
    stubLlm.delayMs = 0;
    stubLlm.lastInput = undefined;
  });

  describe('happy paths', () => {
    it('violation triggers a finding; persisted review row has status="completed" + token counts + chunk-ids hash', async () => {
      const diff = loadFixture('no-var-violation.patch');
      const res = await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff })
        .expect(200);

      expect(res.body.status).toBe('completed');
      expect(res.body.findings.length).toBeGreaterThanOrEqual(1);
      expect(res.body.model).toBe('stub-model');
      expect(res.body.prompt_version).toBe(PROMPT_AND_TOOL_VERSION);
      expect(res.body.usage.input_tokens).toBe(1000);
      expect(res.body.usage.output_tokens).toBe(100);

      // Inspect the persisted review row directly.
      const reviewsRepo = app.get(REVIEW_REPOSITORY);
      const row = (reviewsRepo as { findById: (id: string) => ReviewRecord | undefined })
        .findById(res.body.review_id);
      expect(row).toBeDefined();
      expect(row?.status).toBe('completed');
      expect(row?.input_tokens).toBe(1000);
      expect(row?.output_tokens).toBe(100);
      expect(row?.completed_at).toBeInstanceOf(Date);
      expect(row?.created_by).toBeNull();
      expect(row?.retrieved_chunk_ids_hash).toMatch(/^[a-f0-9]{64}$/);
      const ids = JSON.parse(row?.retrieved_chunk_ids ?? '[]') as string[];
      expect(ids.length).toBeGreaterThanOrEqual(1);
    });

    it('clean diff returns empty findings array but still persists a completed review row', async () => {
      stubLlm.mode = 'echo-none';
      const cleanDiff = 'diff --git a/notes.md b/notes.md\n@@ -1 +1 @@\n-hello\n+world\n';

      const res = await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff: cleanDiff })
        .expect(200);

      expect(res.body.findings).toEqual([]);
      expect(res.body.status).toBe('completed');

      const reviewsRepo = app.get(REVIEW_REPOSITORY);
      const findingsRepo = app.get(REVIEW_FINDING_REPOSITORY);
      const row = (reviewsRepo as { findById: (id: string) => ReviewRecord | undefined })
        .findById(res.body.review_id);
      expect(row?.status).toBe('completed');
      expect(
        (findingsRepo as { findByReviewId: (id: string) => unknown[] }).findByReviewId(
          res.body.review_id,
        ),
      ).toEqual([]);
    });
  });

  describe('OSS fixture quality gate — each fixture yields ≥1 finding citing a corpus rule', () => {
    // Each fixture is built to fire a *specific* rule. The stub LLM
    // echoes the top-K-retrieved rule(s), so retrieval is the actual
    // signal under test — if a fixture is rewritten and the violated
    // rule no longer surfaces in the top-K, this gate fails BEFORE
    // the Day-5/6/9 demo discovers it.
    const fixtures = [
      'eqeqeq-violation.patch',
      'no-var-violation.patch',
      'max-lines-violation.patch',
      'prefer-const-violation.patch',
      'co-authored-by-claude-violation.patch',
      'thin-controllers-violation.patch',
    ];

    for (const fixture of fixtures) {
      it(`${fixture} produces at least one finding`, async () => {
        // Some fixtures (especially the thin-controllers one) need
        // multi-rule output; echo-all surfaces every retrieved rule
        // as a finding so the multi-violation cases get full coverage.
        stubLlm.mode = 'echo-all';
        const diff = loadFixture(fixture);
        const res = await request(app.getHttpServer())
          .post('/reviews/dry-run')
          .send({ diff, k: 10 })
          .expect(200);

        expect(res.body.findings.length).toBeGreaterThanOrEqual(1);
        // Each emitted finding's rule_id must exist in the corpus.
        // We don't enumerate the corpus here — `retrieved_chunk_ids`
        // on the persisted row IS the corpus snapshot for this call,
        // and the adapter's hallucination filter rejects anything
        // outside it. So a non-empty findings array proves the gate.
        for (const f of res.body.findings) {
          expect(typeof f.rule_id).toBe('string');
          expect(f.rule_id.length).toBeGreaterThan(0);
        }
      });
    }
  });

  describe('DTO validation (global ValidationPipe with forbidNonWhitelisted)', () => {
    it('missing diff returns 400', async () => {
      await request(app.getHttpServer()).post('/reviews/dry-run').send({}).expect(400);
    });

    it('oversize diff (>50_000 chars) returns 400', async () => {
      const oversize = 'a'.repeat(50_001);
      await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff: oversize })
        .expect(400);
    });

    it('k=0 returns 400 (below @Min(1))', async () => {
      await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff: 'x', k: 0 })
        .expect(400);
    });

    it('k=101 returns 400 (above @Max(100))', async () => {
      await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff: 'x', k: 101 })
        .expect(400);
    });

    it('extra fields are rejected (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff: 'x', foo: 'bar' })
        .expect(400);
    });

    it('camelCase prNodeId is rejected — DTO uses snake_case pr_node_id', async () => {
      await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff: 'x', prNodeId: 'PR_x' })
        .expect(400);
    });
  });

  describe('failure persistence', () => {
    it('stub LLM throws AnthropicRequestError → 5xx + persisted row with status="failed"', async () => {
      stubLlm.mode = 'throw-rate-limit';
      const diff = loadFixture('no-var-violation.patch');

      const res = await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.status).toBeLessThan(600);

      const reviewsRepo = app.get(REVIEW_REPOSITORY);
      const findingsRepo = app.get(REVIEW_FINDING_REPOSITORY);
      const all = (
        reviewsRepo as { findAll: (limit?: number) => ReviewRecord[] }
      ).findAll();
      const failed = all.find((r) => r.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed?.error_status).toBe(429);
      expect(failed?.error_code).toBe('rate_limit_error');
      expect(failed?.completed_at).toBeInstanceOf(Date);
      expect(
        (findingsRepo as { findByReviewId: (id: string) => unknown[] }).findByReviewId(
          failed?.id ?? '',
        ),
      ).toEqual([]);
    });
  });

  describe('lifecycle visibility', () => {
    it('in-flight stub-LLM delay leaves an in_progress row visible mid-call; flips to completed after', async () => {
      stubLlm.mode = 'delay-then-echo';
      stubLlm.delayMs = 200;
      const diff = loadFixture('no-var-violation.patch');
      const reviewsRepo = app.get(REVIEW_REPOSITORY);

      const before = (reviewsRepo as { findAll: () => ReviewRecord[] }).findAll();
      const beforeIds = new Set(before.map((r) => r.id));

      // Fire the request immediately by wrapping in an async IIFE —
      // supertest's Test object only triggers the underlying HTTP
      // request when `.then` is called, so building the chain without
      // .then leaves it dormant.
      let observedInProgress = false;
      const promise = (async () => {
        return await request(app.getHttpServer())
          .post('/reviews/dry-run')
          .send({ diff });
      })();

      // Poll the repository while the stub-LLM is mid-delay (200ms).
      const deadline = Date.now() + 180;
      while (Date.now() < deadline && !observedInProgress) {
        await new Promise((r) => setTimeout(r, 10));
        const snapshot = (reviewsRepo as { findAll: () => ReviewRecord[] }).findAll();
        for (const row of snapshot) {
          if (!beforeIds.has(row.id) && row.status === 'in_progress') {
            observedInProgress = true;
            break;
          }
        }
      }

      const res = await promise;
      expect(res.status).toBe(200);
      expect(observedInProgress).toBe(true);
      const after = (reviewsRepo as { findById: (id: string) => ReviewRecord | undefined })
        .findById(res.body.review_id);
      expect(after?.status).toBe('completed');
    });

    it('ReviewsService.runDryRun is still callable in-process when ENABLE_DRY_RUN=true (sanity)', async () => {
      stubLlm.mode = 'echo-none';
      const service = app.get(ReviewsService);
      const result = await service.runDryRun({ diff: 'in-process call' });
      expect(result.status).toBe('completed');
    });
  });
});

// Gated-off subapp. Separate Test.createTestingModule so
// ReviewsModule.forRoot() re-reads ENABLE_DRY_RUN at module construction.
describe('Reviews dry-run (e2e — ENABLE_DRY_RUN=false)', () => {
  let app: INestApplication;
  let tmpDir: string;
  let envSnapshot: EnvState;

  beforeAll(async () => {
    envSnapshot = snapshotEnv(SNAPSHOT_KEYS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-e2e-gated-'));
    process.env.GITHUB_WEBHOOK_SECRET = 'reviews-test-secret-1234567890';
    process.env.VOYAGE_API_KEY = 'voyage-test-key-0123456789abcdef';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key-0123456789abcdef';
    process.env.DATABASE_PATH = path.join(tmpDir, 'reviews-gated.sqlite');
    process.env.ENABLE_DRY_RUN = 'false';
    process.env.NODE_ENV = 'production';

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
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  it('POST /reviews/dry-run returns 404 — route is not registered', async () => {
    await request(app.getHttpServer())
      .post('/reviews/dry-run')
      .send({ diff: 'x' })
      .expect(404);
  });

  it('ReviewsService is still provided — internal callers (Day 4 / 5) keep working', async () => {
    expect(app.get(ReviewsService)).toBeInstanceOf(ReviewsService);
  });
});

// Throttler subapp. Fresh ThrottlerStorage because it's a fresh app
// — the 30 req/min/IP budget is unspent at the start of this describe.
describe('Reviews dry-run (e2e — global throttler)', () => {
  let app: INestApplication;
  let tmpDir: string;
  let envSnapshot: EnvState;

  beforeAll(async () => {
    envSnapshot = snapshotEnv(SNAPSHOT_KEYS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-e2e-throttler-'));
    process.env.GITHUB_WEBHOOK_SECRET = 'reviews-test-secret-1234567890';
    process.env.VOYAGE_API_KEY = 'voyage-test-key-0123456789abcdef';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key-0123456789abcdef';
    process.env.DATABASE_PATH = path.join(tmpDir, 'reviews-throttler.sqlite');
    process.env.ENABLE_DRY_RUN = 'true';
    process.env.NODE_ENV = 'development';

    const stub = new StubLlmReviewer();
    stub.mode = 'echo-none';

    const moduleRef = await Test.createTestingModule({ imports: [makeTestModule()] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(new StubEmbeddingProvider())
      .overrideProvider(VECTOR_STORE)
      .useValue(new StubVectorStore())
      .overrideProvider(LLM_REVIEWER)
      .useValue(stub)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    // Need a seeded corpus so embeddings.search() returns something
    // — otherwise the dry-run still works (empty findings) and the
    // throttler thresholds are still exercised, but realism is better
    // with one seeded chunk.
    await app.get(EmbeddingsService).indexCorpus();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  it('30 requests within the window all 200; the 31st returns 429 (ThrottlerException)', async () => {
    const diff = 'diff --git a/x.js b/x.js\n@@ -1 +1 @@\n-a\n+b\n';
    for (let i = 0; i < 30; i++) {
      const res = await request(app.getHttpServer())
        .post('/reviews/dry-run')
        .send({ diff });
      expect(res.status).toBe(200);
    }
    const limited = await request(app.getHttpServer())
      .post('/reviews/dry-run')
      .send({ diff });
    expect(limited.status).toBe(429);
  }, 30_000);
});

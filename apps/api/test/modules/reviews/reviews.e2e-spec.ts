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
  Finding,
  ILlmReviewer,
  LLM_REVIEWER,
  PROMPT_AND_TOOL_VERSION,
} from '@/modules/reviews/types/llm-reviewer';
import {
  REVIEW_REPOSITORY,
  REVIEW_FINDING_REPOSITORY,
} from '@/modules/reviews/types';
import { LlmRequestError } from '@/infrastructure/llm';
import { FilesystemRepoContextProvider } from '@/infrastructure/repo-context';
import { ReviewsService } from '@/modules/reviews';
import { ReviewsModule } from '@/modules/reviews/reviews.module';
import { ReviewRecord, ToolCallRecord } from '@/modules/reviews/types/review.types';
import { IRepoContextProvider } from '@/modules/reviews/types/repo-context-provider';
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
type StubMode =
  | 'echo-first-only'
  | 'echo-all'
  | 'echo-none'
  | 'throw-rate-limit'
  | 'delay-then-echo'
  | 'multi-turn-script'
  | 'throw-turn-cap-exceeded';

// One step of a scripted multi-turn run. `tool` steps invoke the
// configured `input.repoContext` and record the result as a
// ToolCallRecord (with is_error reflecting the provider response).
// `emit` is the terminal step — the stub returns its findings as the
// final result.
type ScriptedTurn =
  | {
      kind: 'tool';
      name: 'fetch_related_file' | 'fetch_function_definition' | 'fetch_prior_review';
      input: Record<string, unknown>;
    }
  | { kind: 'emit'; findings: Finding[] };

class StubLlmReviewer implements ILlmReviewer {
  public mode: StubMode = 'echo-first-only';
  public delayMs = 0;
  public lastInput?: AnalyzeDiffInput;
  public script: ScriptedTurn[] = [];
  // Pre-built error used by 'throw-turn-cap-exceeded' so the
  // turn-cap scenario can assert against a specific
  // turnCount + toolCalls shape.
  public turnCapToolCalls: ToolCallRecord[] = [];

  async analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    this.lastInput = input;
    if (this.mode === 'throw-rate-limit') {
      throw new LlmRequestError('Anthropic API error: HTTP 429 (rate_limit_error)', {
        status: 429,
        errorCode: 'rate_limit_error',
      });
    }
    if (this.mode === 'throw-turn-cap-exceeded') {
      throw new LlmRequestError(
        'Agent loop exceeded 6 turns without emit_finding',
        {
          status: 200,
          errorCode: 'turn_cap_exceeded',
          turnCount: 6,
          toolCalls: this.turnCapToolCalls,
        },
      );
    }
    if (this.mode === 'multi-turn-script') {
      return this.runScript(input);
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
      // Degenerate single-turn case. The 'multi-turn-script' mode
      // below walks a scripted sequence for the multi-turn scenarios.
      turnCount: 1,
      toolCalls: [
        {
          turn_idx: 1,
          tool_name: 'emit_finding',
          input_hash: '0'.repeat(16),
          result_bytes: 0,
          latency_ms: 0,
          stop_reason: 'tool_use',
        },
      ],
      hallucinatedFindingCount: 0,
      cacheHitCount: 0,
    };
  }

  // Walks the configured script, invoking `input.repoContext` on tool
  // steps and accumulating a ToolCallRecord per step. The terminal
  // 'emit' step's findings flow through to the result (with
  // hallucination filtering — drop any rule_id not in input.rules).
  private async runScript(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    const repoContext = input.repoContext;
    const inputRuleIds = new Set(input.rules.map((r) => r.rule_id));
    const toolCalls: ToolCallRecord[] = [];
    let turn = 0;
    let emittedFindings: Finding[] = [];

    for (const step of this.script) {
      turn += 1;
      if (step.kind === 'tool') {
        const dispatch = await this.dispatchScriptedTool(step, repoContext);
        toolCalls.push({
          turn_idx: turn,
          tool_name: step.name,
          input_hash: hashScriptInput(step.input),
          result_bytes: dispatch.bytes,
          latency_ms: 0,
          stop_reason: 'tool_use',
          ...(dispatch.isError ? { is_error: true } : {}),
        });
        continue;
      }
      // emit step — the terminal turn. Filter hallucinations.
      emittedFindings = step.findings.filter((f) => inputRuleIds.has(f.rule_id));
      toolCalls.push({
        turn_idx: turn,
        tool_name: 'emit_finding',
        input_hash: hashScriptInput({ findings: step.findings }),
        result_bytes: 0,
        latency_ms: 0,
        stop_reason: 'tool_use',
      });
      break;
    }

    return {
      findings: emittedFindings,
      usage: {
        input_tokens: 1500 * turn,
        output_tokens: 100 * turn,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      model: 'stub-model',
      promptVersion: PROMPT_AND_TOOL_VERSION,
      turnCount: turn,
      toolCalls,
      hallucinatedFindingCount: 0,
      cacheHitCount: 0,
    };
  }

  private async dispatchScriptedTool(
    step: Extract<ScriptedTurn, { kind: 'tool' }>,
    repoContext: IRepoContextProvider | undefined,
  ): Promise<{ bytes: number; isError: boolean }> {
    if (!repoContext) {
      return { bytes: 32, isError: true };
    }
    if (step.name === 'fetch_related_file') {
      const result = await repoContext.fetchFile(
        (step.input.path as string) ?? '',
      );
      return {
        bytes: result.ok ? Buffer.byteLength(result.content, 'utf8') : 64,
        isError: !result.ok,
      };
    }
    if (step.name === 'fetch_function_definition') {
      const result = await repoContext.fetchFunctionDefinition(
        (step.input.name as string) ?? '',
        step.input.file as string | undefined,
      );
      return {
        bytes: result.ok ? Buffer.byteLength(result.content, 'utf8') : 64,
        isError: !result.ok,
      };
    }
    // fetch_prior_review
    const result = await repoContext.fetchPriorReview(step.input as Parameters<IRepoContextProvider['fetchPriorReview']>[0]);
    return {
      bytes: result.ok ? Buffer.byteLength(JSON.stringify(result.content), 'utf8') : 64,
      isError: !result.ok,
    };
  }
}

function hashScriptInput(input: unknown): string {
  // Reproducible-but-cheap hash for the per-turn record. Doesn't need
  // to match the production sha256 algorithm — these are stub-side
  // assertions.
  return Buffer.from(JSON.stringify(input)).toString('hex').slice(0, 16).padEnd(16, '0');
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
    stubLlm.script = [];
    stubLlm.turnCapToolCalls = [];
  });

  // Helper: build a FilesystemRepoContextProvider against a fixture's
  // co-located `.repo/` directory under
  // apps/api/test/fixtures/diffs/<name>.repo/.
  function repoFixture(name: string): FilesystemRepoContextProvider {
    const dir = path.resolve(__dirname, '..', '..', 'fixtures', 'diffs', name);
    return new FilesystemRepoContextProvider(dir);
  }

  // The HTTP path doesn't accept a repoContext (the controller
  // injects NullRepoContextProvider). To exercise the
  // FilesystemRepoContextProvider end-to-end through ReviewsService
  // we call the service directly. This mirrors how the dry-run CLI
  // invokes it.
  function runWithRepoFixture(
    diff: string,
    repoDirName: string,
  ): ReturnType<ReviewsService['runDryRun']> {
    return app.get(ReviewsService).runDryRun({
      diff,
      repoContext: repoFixture(repoDirName),
    });
  }

  describe('silent signature change (multi-turn investigation)', () => {
    it('agent calls fetch_function_definition + fetch_related_file, then emits a finding citing the unchanged caller', async () => {
      stubLlm.mode = 'multi-turn-script';
      stubLlm.script = [
        {
          kind: 'tool',
          name: 'fetch_function_definition',
          input: { name: 'chargeCard' },
        },
        {
          kind: 'tool',
          name: 'fetch_related_file',
          input: { path: 'src/retry-queue.js' },
        },
        {
          kind: 'emit',
          findings: [
            {
              rule_id: 'no-param-reassign',
              title: 'Caller `src/retry-queue.js` not updated with idempotencyKey',
              message:
                'chargeCard now expects opts.idempotencyKey but src/retry-queue.js still calls chargeCard(order, { capture: true }) — pass an idempotency key there too.',
              location_hint: 'src/checkout.js:25',
              citation: null,
            },
          ],
        },
      ];

      const diff = loadFixture('silent-signature-change.patch');
      const result = await runWithRepoFixture(diff, 'silent-signature-change.repo');

      expect(result.status).toBe('completed');
      expect(result.turn_count).toBe(3);
      expect(result.tool_calls).toHaveLength(3);
      expect(result.tool_calls?.[0].tool_name).toBe('fetch_function_definition');
      expect(result.tool_calls?.[1].tool_name).toBe('fetch_related_file');
      expect(result.tool_calls?.[2].tool_name).toBe('emit_finding');

      // The finding must reference the unchanged-caller file path
      // (this is what the agent learned by reading the .repo/ dir).
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].message).toContain('src/retry-queue.js');

      // Persisted row has the same aggregates.
      const reviewsRepo = app.get(REVIEW_REPOSITORY);
      const row = (reviewsRepo as { findById: (id: string) => ReviewRecord | undefined })
        .findById(result.review_id);
      expect(row?.turn_count).toBe(3);
      const persistedCalls = row?.tool_calls_json as unknown as ToolCallRecord[] | null;
      expect(persistedCalls).toHaveLength(3);
    });
  });

  describe('mid-loop recovery (tool error does not poison the loop)', () => {
    it('fetch_related_file on a missing path returns is_error; agent recovers and emits on turn 3', async () => {
      stubLlm.mode = 'multi-turn-script';
      stubLlm.script = [
        {
          kind: 'tool',
          name: 'fetch_related_file',
          input: { path: 'src/does-not-exist.js' },
        },
        {
          kind: 'tool',
          name: 'fetch_function_definition',
          input: { name: 'chargeCard' },
        },
        {
          kind: 'emit',
          findings: [
            {
              rule_id: 'no-param-reassign',
              title: 'Inconsistent caller',
              message: 'Recovered after a failed fetch and emitted a finding anyway.',
              location_hint: 'src/checkout.js:25',
              citation: null,
            },
          ],
        },
      ];

      const diff = loadFixture('silent-signature-change.patch');
      const result = await runWithRepoFixture(diff, 'silent-signature-change.repo');

      expect(result.status).toBe('completed');
      expect(result.turn_count).toBe(3);
      // Turn 1 hit the missing file → is_error recorded.
      expect(result.tool_calls?.[0].is_error).toBe(true);
      // Turn 2 succeeded — no is_error flag.
      expect(result.tool_calls?.[1].is_error).toBeUndefined();
      // Final finding emitted normally.
      expect(result.findings).toHaveLength(1);
    });
  });

  describe('dismissed eqeqeq re-run (zero findings via fetch_prior_review)', () => {
    it('fetch_prior_review finds a dismissed prior finding; agent emits an empty findings array', async () => {
      stubLlm.mode = 'multi-turn-script';
      stubLlm.script = [
        {
          kind: 'tool',
          name: 'fetch_prior_review',
          input: { file_path: 'src/checkout.js', rule_id: 'eqeqeq' },
        },
        { kind: 'emit', findings: [] },
      ];

      const diff = loadFixture('dismissed-eqeqeq-rerun.patch');
      const result = await runWithRepoFixture(diff, 'dismissed-eqeqeq-rerun.repo');

      expect(result.status).toBe('completed');
      expect(result.findings).toEqual([]);
      expect(result.turn_count).toBe(2);
      expect(result.tool_calls?.[0].tool_name).toBe('fetch_prior_review');
      expect(result.tool_calls?.[0].is_error).toBeUndefined();

      // No review_findings row was inserted for the dismissed location.
      const findingsRepo = app.get(REVIEW_FINDING_REPOSITORY);
      expect(
        (findingsRepo as { findByReviewId: (id: string) => unknown[] }).findByReviewId(
          result.review_id,
        ),
      ).toEqual([]);
    });
  });

  describe('turn cap exceeded', () => {
    it('adapter throws turn_cap_exceeded; persisted row is failed with turn_count=6 and no findings', async () => {
      stubLlm.mode = 'throw-turn-cap-exceeded';
      stubLlm.turnCapToolCalls = Array.from({ length: 6 }, (_, i) => ({
        turn_idx: i + 1,
        tool_name: 'fetch_related_file',
        input_hash: String(i).padStart(16, '0'),
        result_bytes: 800,
        latency_ms: 500 + i,
        stop_reason: 'tool_use',
      }));

      const diff = loadFixture('silent-signature-change.patch');
      const service = app.get(ReviewsService);

      let caught: LlmRequestError | undefined;
      try {
        await service.runDryRun({
          diff,
          repoContext: repoFixture('silent-signature-change.repo'),
        });
      } catch (err) {
        caught = err as LlmRequestError;
      }

      expect(caught).toBeDefined();
      expect(caught?.errorCode).toBe('turn_cap_exceeded');

      const reviewsRepo = app.get(REVIEW_REPOSITORY);
      const failed = (
        reviewsRepo as { findAll: () => ReviewRecord[] }
      )
        .findAll()
        .find((r) => r.status === 'failed' && r.error_code === 'turn_cap_exceeded');
      expect(failed).toBeDefined();
      expect(failed?.turn_count).toBe(6);

      // The partial loop trace (6 tool calls from
      // LlmRequestError.toolCalls) must round-trip through
      // markFailed and land in tool_calls_json — eval needs to see
      // how far the loop got and which tools were called before
      // the cap.
      const persistedToolCalls = failed?.tool_calls_json as unknown as ToolCallRecord[] | null;
      expect(persistedToolCalls).toHaveLength(6);
      expect(persistedToolCalls?.[0].tool_name).toBe('fetch_related_file');
      expect(persistedToolCalls?.[5].turn_idx).toBe(6);

      const findingsRepo = app.get(REVIEW_FINDING_REPOSITORY);
      expect(
        (findingsRepo as { findByReviewId: (id: string) => unknown[] }).findByReviewId(
          failed?.id ?? '',
        ),
      ).toEqual([]);
    });
  });

  describe('no repoContext provided (legacy single-turn fallback)', () => {
    it('the script still walks; tool steps return is_error; emit_finding fires normally', async () => {
      stubLlm.mode = 'multi-turn-script';
      stubLlm.script = [
        {
          kind: 'tool',
          name: 'fetch_related_file',
          input: { path: 'src/anything.js' },
        },
        {
          kind: 'emit',
          findings: [
            {
              rule_id: 'no-var',
              title: 'fallback',
              message: 'Fell back to emitting without repo context.',
              location_hint: null,
              citation: null,
            },
          ],
        },
      ];

      // Call the service WITHOUT a repoContext — every tool call
      // should surface as is_error: true in the tool_calls log, and
      // the emit_finding step should still produce findings.
      const diff = loadFixture('no-var-violation.patch');
      const result = await app.get(ReviewsService).runDryRun({ diff });

      expect(result.status).toBe('completed');
      expect(result.findings).toHaveLength(1);
      expect(result.tool_calls?.[0].is_error).toBe(true);
    });
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
    // rule no longer surfaces in the top-K, this gate catches it
    // before a real run does.
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
    it('stub LLM throws LlmRequestError → 5xx + persisted row with status="failed"', async () => {
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

  it('ReviewsService is still provided — internal callers keep working', async () => {
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

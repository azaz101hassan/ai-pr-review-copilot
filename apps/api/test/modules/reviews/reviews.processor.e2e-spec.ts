import { DynamicModule, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Job } from 'bullmq';
import type { Octokit } from 'octokit';
import { ConfigModule, ConfigService } from '@/config';
import { DatabaseModule } from '@/infrastructure/db';
import { EmbeddingsModule, EmbeddingsService } from '@/modules/embeddings';
import { EMBEDDING_PROVIDER } from '@/modules/embeddings/types/embedding-provider';
import { VECTOR_STORE } from '@/modules/embeddings/types/vector-store';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';
import {
  GITHUB_AUTH_PROVIDER,
  IGithubAuthProvider,
} from '@/modules/reviews/types/github-auth-provider';
import {
  WALKTHROUGH_SUMMARIZER,
  IWalkthroughSummarizer,
} from '@/modules/reviews/types/walkthrough-summarizer';
import {
  REVIEW_REPOSITORY,
  REVIEW_FINDING_REPOSITORY,
  IReviewRepository,
  IReviewFindingRepository,
} from '@/modules/reviews/types';
import { PULL_REQUEST_REPOSITORY } from '@/modules/webhooks/types/pull-request.repository';
import type { IPullRequestRepository } from '@/modules/webhooks/types/pull-request.repository';
import type { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';
import { ReviewsService } from '@/modules/reviews';
import { ReviewsModule } from '@/modules/reviews/reviews.module';
import { ReviewsProcessor } from '@/modules/reviews/reviews.processor';
import type { ReviewJobData } from '@/modules/reviews/types/review-queue';
import { HealthController } from '@/system';
import {
  EnvState,
  StubEmbeddingProvider,
  StubLlmReviewer,
  StubVectorStore,
  loadFixture,
  restoreEnv,
  snapshotEnv,
} from './support/reviews-e2e-stubs';

// Processor worker-lifecycle e2e. The sibling UNIT spec
// (reviews.processor.spec.ts) already covers the octokit-surface
// behavior with FULLY-MOCKED repositories. The net-new value HERE is
// REAL persistence + REAL DI wiring: every test asserts at least one
// fact about the live SQLite repositories that the unit spec cannot —
// that the row actually round-trips through insertInProgress /
// setCheckRunId / markCompleted, that the GitHub check-run id lands on
// the real reviews row, etc.
//
// We boot the same module the dry-run e2e builds (mirroring AppModule),
// but with SKIP_REDIS_PROBE=true so the BullMQ explorer never tries to
// construct a Worker against the no-op queue. That means ReviewsProcessor
// is NOT registered as a provider, so we construct it MANUALLY from the
// booted app's real providers (the same manual-construction pattern the
// unit spec's drainGracefully tests use). The processor's process() path
// never touches `this.worker`, so no BullMQ handles leak.

// Stable test ids returned by the recording mock octokit.
const TEST_CHECK_RUN_ID = 4242;
const TEST_WALKTHROUGH_COMMENT_ID = 555;

function makeTestModule(): DynamicModule {
  return {
    module: class TestProcessorAppModule {},
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

// Recording mock Octokit. Each method is a jest.fn() with a sensible
// default so the full success path runs; tests reach into specific
// fns (e.g. checks.create) and read `.mock.invocationCallOrder` to
// assert cross-surface ordering. Defaults:
//   - pulls.get → an OPEN PR
//   - request (the diff fetch) → a real no-var fixture so retrieval
//     surfaces the no-var rule and the default echo-first-only stub
//     LLM emits exactly one finding (full success path).
//   - issues.createComment → a stable comment id
//   - issues.listComments → empty (cold walkthrough thread)
//   - checks.create → a stable check-run id
//   - pulls.createReview → a stub review URL
interface MakeOctokitOpts {
  diff?: string;
  prState?: string;
  checkRunId?: number;
  commentId?: number;
}
function makeOctokit(opts: MakeOctokitOpts = {}): Octokit {
  const diff = opts.diff ?? loadFixture('no-var-violation.patch');
  const prState = opts.prState ?? 'open';
  const checkRunId = opts.checkRunId ?? TEST_CHECK_RUN_ID;
  const commentId = opts.commentId ?? TEST_WALKTHROUGH_COMMENT_ID;
  return {
    rest: {
      pulls: {
        get: jest.fn().mockResolvedValue({ data: { state: prState } }),
        createReview: jest
          .fn()
          .mockResolvedValue({ data: { html_url: 'https://example.test/r/1' } }),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({ data: { id: commentId } }),
        updateComment: jest.fn().mockResolvedValue({ data: {} }),
        listComments: jest.fn().mockResolvedValue({ data: [] }),
      },
      checks: {
        create: jest.fn().mockResolvedValue({ data: { id: checkRunId } }),
        update: jest.fn().mockResolvedValue({ data: {} }),
      },
    },
    request: jest.fn().mockResolvedValue({ data: diff }),
  } as unknown as Octokit;
}

// Controllable stub auth provider. forInstallation returns whatever
// octokit the current test installed; the checks-permission flags are
// per-installation booleans that markChecksPermissionMissing flips off
// and invalidateInstallation clears. All resettable in beforeEach.
class StubGithubAuthProvider implements IGithubAuthProvider {
  public octokit: Octokit = makeOctokit();
  // installation_id -> hasChecksPermission. Absent means default true.
  private readonly missingChecks = new Set<number>();

  forInstallation(): Octokit {
    return this.octokit;
  }
  invalidateInstallation(installationId: number): void {
    this.missingChecks.delete(installationId);
  }
  markChecksPermissionMissing(installationId: number): void {
    this.missingChecks.add(installationId);
  }
  hasChecksPermission(installationId: number): boolean {
    return !this.missingChecks.has(installationId);
  }
  reset(octokit: Octokit): void {
    this.octokit = octokit;
    this.missingChecks.clear();
  }
}

const SNAPSHOT_KEYS = [
  'GITHUB_WEBHOOK_SECRET',
  'VOYAGE_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_PATH',
  'ENABLE_DRY_RUN',
  'NODE_ENV',
  'SKIP_REDIS_PROBE',
];

describe('ReviewsProcessor (e2e — real SQLite repositories)', () => {
  let app: INestApplication;
  let tmpDir: string;
  let envSnapshot: EnvState;

  let processor: ReviewsProcessor;
  let reviewsRepo: IReviewRepository;
  let findingsRepo: IReviewFindingRepository;
  let pullRequestsRepo: IPullRequestRepository;
  let authProvider: StubGithubAuthProvider;
  // The default summarizer returns a deterministic prose intro; later
  // tasks reassign the mock to return null (failure path). Typed with a
  // jest.Mock summarize so tests can drive it without re-casting.
  let summarizer: IWalkthroughSummarizer & { summarize: jest.Mock };

  // Per-test unique PR identity. Each test gets a fresh pr_node_id +
  // head_sha so the persisted reviews rows and the walkthrough-comment-id
  // cache do not bleed across tests in this single describe (the real DB
  // persists). Re-review tests reuse one id within a single test.
  let prCounter = 0;

  beforeAll(async () => {
    envSnapshot = snapshotEnv(SNAPSHOT_KEYS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-processor-e2e-'));
    process.env.GITHUB_WEBHOOK_SECRET = 'reviews-test-secret-1234567890';
    process.env.VOYAGE_API_KEY = 'voyage-test-key-0123456789abcdef';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key-0123456789abcdef';
    process.env.DATABASE_PATH = path.join(tmpDir, 'reviews-processor.sqlite');
    // We call the processor directly — no HTTP route needed.
    process.env.ENABLE_DRY_RUN = 'false';
    // Force NODE_ENV=development so the dev-default model resolves
    // deterministically across local + CI.
    process.env.NODE_ENV = 'development';
    // CRITICAL: keep the BullMQ worker explorer OFF so the processor is
    // not auto-registered against the no-op queue. We construct it by hand.
    process.env.SKIP_REDIS_PROBE = 'true';

    authProvider = new StubGithubAuthProvider();
    summarizer = {
      summarize: jest.fn().mockResolvedValue({ intro: 'A concise summary.' }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [makeTestModule()],
    })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(new StubEmbeddingProvider())
      .overrideProvider(VECTOR_STORE)
      .useValue(new StubVectorStore())
      .overrideProvider(LLM_REVIEWER)
      .useValue(new StubLlmReviewer())
      .overrideProvider(GITHUB_AUTH_PROVIDER)
      .useValue(authProvider)
      .overrideProvider(WALKTHROUGH_SUMMARIZER)
      .useValue(summarizer)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    await app.get(EmbeddingsService).indexCorpus();

    reviewsRepo = app.get(REVIEW_REPOSITORY);
    findingsRepo = app.get(REVIEW_FINDING_REPOSITORY);
    pullRequestsRepo = app.get(PULL_REQUEST_REPOSITORY);

    // Construct the processor MANUALLY from the real providers —
    // app.get(ReviewsProcessor) would throw because the worker explorer
    // is disabled (SKIP_REDIS_PROBE=true), so the processor is not a
    // registered provider. The constructor order mirrors the source.
    processor = new ReviewsProcessor(
      authProvider,
      app.get(ReviewsService),
      reviewsRepo,
      findingsRepo,
      pullRequestsRepo,
      app.get(ConfigService),
      summarizer,
    );
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(envSnapshot);
  });

  beforeEach(() => {
    // Reset the auth provider's octokit + permission state, and restore
    // the default happy-path summarizer for any test that flipped it.
    authProvider.reset(makeOctokit());
    (summarizer.summarize as jest.Mock).mockReset();
    (summarizer.summarize as jest.Mock).mockResolvedValue({
      intro: 'A concise summary.',
    });
  });

  // Restore any jest.spyOn installed on the shared (booted-once)
  // repositories so a spy can never leak across tests in this describe.
  // jest.config has no global restoreMocks, and the repos persist for the
  // whole describe — without this, a test that throws mid-assertion would
  // leave its spy installed and corrupt later tests' invocationCallOrder /
  // call-count assertions. restoreAllMocks only touches spyOn-created
  // spies; the standalone jest.fn() summarizer + per-test octokit are
  // untouched.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Mint a fresh PR identity and seed a real pull_requests row for it.
  // The processor's walkthrough upsert calls
  // pullRequestsRepo.setWalkthroughCommentId, whose real SQLite
  // implementation THROWS when no pull_requests row exists (the row is
  // upserted on webhook ingestion before any worker code runs in prod).
  // So a real row must exist first.
  function seedPr(): { prNodeId: string; headSha: string; prNumber: number } {
    prCounter += 1;
    const prNodeId = `PR_e2e_${prCounter}`;
    const headSha = prCounter.toString(16).padStart(40, '0');
    const prNumber = 100 + prCounter;
    const now = new Date();
    const record: PullRequestRecord = {
      node_id: prNodeId,
      repo_full_name: 'octocat/demo',
      number: prNumber,
      title: `Test PR ${prCounter}`,
      state: 'open',
      head_sha: headSha,
      base_sha: 'b'.repeat(40),
      author_login: 'octocat',
      created_at: now,
      updated_at: now,
      raw_payload: '{}',
      walkthrough_comment_id: null,
    };
    pullRequestsRepo.save(record);
    return { prNodeId, headSha, prNumber };
  }

  function makeJob(
    data: Partial<ReviewJobData> & Pick<ReviewJobData, 'pr_node_id' | 'head_sha' | 'pr_number'>,
    id = `bullmq-job-${prCounter}`,
  ): Job<ReviewJobData> {
    const full: ReviewJobData = {
      owner: 'octocat',
      repo: 'demo',
      installation_id: 12345,
      ...data,
    };
    return { id, data: full } as unknown as Job<ReviewJobData>;
  }

  it('inserts the review row in the DB before posting the in-progress check-run and walkthrough, and persists the check-run id', async () => {
    const { prNodeId, headSha, prNumber } = seedPr();

    // Spy on the REAL repo to capture call order WITHOUT breaking it —
    // jest.spyOn calls through by default, so the row is still really
    // inserted into SQLite.
    const insertSpy = jest.spyOn(reviewsRepo, 'insertInProgress');

    const octokit = authProvider.octokit;
    const checksCreate = octokit.rest.checks.create as unknown as jest.Mock;
    const issuesCreateComment = octokit.rest.issues.createComment as unknown as jest.Mock;

    await processor.process(
      makeJob({ pr_node_id: prNodeId, head_sha: headSha, pr_number: prNumber }),
    );

    // Ordering via the global monotonic invocation counter: the row is
    // reserved (insertInProgress) BEFORE the in-progress check-run POST
    // (checks.create) AND before the in-progress walkthrough comment POST
    // (issues.createComment).
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(checksCreate).toHaveBeenCalled();
    expect(issuesCreateComment).toHaveBeenCalled();

    const insertOrder = insertSpy.mock.invocationCallOrder[0];
    const checksCreateOrder = checksCreate.mock.invocationCallOrder[0];
    const createCommentOrder = issuesCreateComment.mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(checksCreateOrder);
    expect(checksCreateOrder).toBeLessThan(createCommentOrder);

    // REAL persistence: read the row back out of SQLite by the
    // worker-allocated id and prove the GitHub check-run id round-tripped
    // onto the reviews row. This is the net-new fact the unit spec (which
    // mocks setCheckRunId) cannot assert.
    const reservedId = insertSpy.mock.calls[0][0].id;
    const row = reviewsRepo.findById(reservedId);
    expect(row).toBeDefined();
    expect(row?.check_run_id).toBe(TEST_CHECK_RUN_ID);
    // Happy path completes terminally.
    expect(row?.status).toBe('completed');

    // Real review_findings round-trip: the echo-first-only stub LLM emits
    // exactly one finding for the no-var fixture, and the real
    // runRealReview transaction persists it — the unit spec (insertMany is
    // a jest.fn) cannot prove this.
    expect(findingsRepo.findByReviewId(reservedId)).toHaveLength(1);
    // Real walkthrough-comment-id cache round-trip on the pull_requests
    // row: Step 8 created the in-progress comment (cold cache) and cached
    // its id. The next review's terminal post PATCHes this same comment.
    expect(pullRequestsRepo.getWalkthroughCommentId(prNodeId)).toBe(
      TEST_WALKTHROUGH_COMMENT_ID,
    );

    // The afterEach restoreAllMocks() restores insertSpy — no explicit
    // mockRestore needed (and none here, so a thrown assertion above can
    // never leak the spy onto the shared repo).
  });

  it('success path posts in order walkthrough(PATCH) -> review -> check-run(PATCH success), and persists a completed row with summary + findings', async () => {
    const { prNodeId, headSha, prNumber } = seedPr();

    // Capture the worker-allocated review id by spying on insertInProgress
    // with callThrough so the row is still really written to SQLite.
    const insertSpy = jest.spyOn(reviewsRepo, 'insertInProgress');

    const octokit = authProvider.octokit;
    const issuesUpdateComment = octokit.rest.issues.updateComment as unknown as jest.Mock;
    const pullsCreateReview = octokit.rest.pulls.createReview as unknown as jest.Mock;
    const checksUpdate = octokit.rest.checks.update as unknown as jest.Mock;

    await processor.process(
      makeJob({ pr_node_id: prNodeId, head_sha: headSha, pr_number: prNumber }),
    );

    // --- Assertion 1: POST ordering via the global monotonic counter ---
    // Step 8 created the in-progress comment (cold cache -> createComment).
    // Step 13a then PATCHes it to the terminal walkthrough body (updateComment).
    // Step 13b posts the inlined Review (createReview).
    // Step 13c PATCHes the check-run to its terminal success state (checks.update).
    // Each fires exactly once on a first-review success (no Step 4b sweep on a
    // fresh PR id), so checks.update calls[0] below is unambiguously the success
    // PATCH rather than a stray neutral sweep.
    expect(issuesUpdateComment).toHaveBeenCalledTimes(1);
    expect(pullsCreateReview).toHaveBeenCalledTimes(1);
    expect(checksUpdate).toHaveBeenCalledTimes(1);

    const updateCommentOrder = issuesUpdateComment.mock.invocationCallOrder[0];
    const createReviewOrder = pullsCreateReview.mock.invocationCallOrder[0];
    const checksUpdateOrder = checksUpdate.mock.invocationCallOrder[0];

    expect(updateCommentOrder).toBeLessThan(createReviewOrder);
    expect(createReviewOrder).toBeLessThan(checksUpdateOrder);

    // --- Assertion 2: check-run conclusion = 'success' ---
    const checksUpdateArg = checksUpdate.mock.calls[0][0] as {
      status: string;
      conclusion: string;
      check_run_id: number;
    };
    expect(checksUpdateArg.status).toBe('completed');
    expect(checksUpdateArg.conclusion).toBe('success');
    expect(checksUpdateArg.check_run_id).toBe(TEST_CHECK_RUN_ID);

    // --- Assertion 3: real-DB completion with check_run_id + walkthrough_summary ---
    const reservedId = insertSpy.mock.calls[0][0].id;
    const row = reviewsRepo.findById(reservedId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('completed');
    expect(row?.check_run_id).toBe(TEST_CHECK_RUN_ID);
    // The stub summarizer returns { intro: 'A concise summary.' }; the worker
    // calls setWalkthroughSummary with summary.intro. Assert the value
    // round-tripped through REAL SQLite (the unit spec cannot prove this).
    expect(row?.walkthrough_summary).toBe('A concise summary.');

    // --- Assertion 4: real findings persisted ---
    // The echo-first-only stub LLM emits exactly one finding for the no-var
    // fixture; runRealReview persists it via the REAL findingsRepo.insertMany.
    expect(findingsRepo.findByReviewId(reservedId)).toHaveLength(1);
  });

  it('sweep: PATCHes a prior completed review\'s check-run to neutral before posting the new check-run (real findMostRecentPriorCheckRun query)', async () => {
    const { prNodeId, headSha, prNumber } = seedPr();

    // Seed TWO prior completed reviews sharing this prNodeId, each with a
    // distinct check-run id and created_at. markCompleted flips them out of
    // 'in_progress' so the per-PR guard (which filters on status='in_progress')
    // does not block the new job. findMostRecentPriorCheckRun orders by
    // created_at DESC limit 1, so only the NEWER prior (999) may be retired;
    // the OLDER prior (888) must be left untouched. Seeding both makes the
    // real query's recency ordering + single-row selection load-bearing here
    // (a single prior row could not catch an asc/desc ordering regression).
    const olderPriorId = randomUUID();
    reviewsRepo.insertInProgress({
      id: olderPriorId,
      pr_node_id: prNodeId,
      model: 'stub-model',
      created_at: new Date(Date.now() - 120_000),
    });
    reviewsRepo.markCompleted(olderPriorId, {
      completed_at: new Date(Date.now() - 115_000),
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
    reviewsRepo.setCheckRunId(olderPriorId, 888);

    const priorId = randomUUID();
    reviewsRepo.insertInProgress({
      id: priorId,
      pr_node_id: prNodeId,
      model: 'stub-model',
      created_at: new Date(Date.now() - 60_000),
    });
    reviewsRepo.markCompleted(priorId, {
      completed_at: new Date(Date.now() - 55_000),
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
    // Tag the newer prior row with a distinct check-run id (999) so we can
    // assert the sweep PATCH targets it specifically, not TEST_CHECK_RUN_ID
    // and not the older prior's 888.
    reviewsRepo.setCheckRunId(priorId, 999);

    // Confirm the prior row was written correctly before running the job.
    const priorRow = reviewsRepo.findById(priorId);
    expect(priorRow?.status).toBe('completed');
    expect(priorRow?.check_run_id).toBe(999);

    const octokit = authProvider.octokit;
    const checksUpdate = octokit.rest.checks.update as unknown as jest.Mock;
    const checksCreate = octokit.rest.checks.create as unknown as jest.Mock;

    await processor.process(makeJob({ pr_node_id: prNodeId, head_sha: headSha, pr_number: prNumber }));

    // The sweep fires ONCE (for the prior check-run id=999). The new
    // review's success PATCH fires ONCE (for TEST_CHECK_RUN_ID). Total: 2
    // calls to checks.update.
    expect(checksUpdate).toHaveBeenCalledTimes(2);

    // Locate the sweep PATCH by check_run_id=999 among all update calls.
    const sweepCall = checksUpdate.mock.calls.find(
      (args: [{ check_run_id: number }]) => args[0].check_run_id === 999,
    ) as [{ check_run_id: number; status: string; conclusion: string; output: { title: string; summary: string } }] | undefined;
    expect(sweepCall).toBeDefined();
    const sweepArg = sweepCall![0];
    expect(sweepArg.status).toBe('completed');
    expect(sweepArg.conclusion).toBe('neutral');
    expect(sweepArg.output.title).toBe('Superseded by newer review on this PR.');

    // The OLDER prior (888) must NOT be swept — only the most recent prior
    // check-run is retired (orderBy created_at DESC limit 1). Its absence
    // among the update calls (combined with the called-twice assertion above)
    // proves the real query selected the newer row, not the older.
    const olderSweepCall = checksUpdate.mock.calls.find(
      (args: [{ check_run_id: number }]) => args[0].check_run_id === 888,
    );
    expect(olderSweepCall).toBeUndefined();

    // Locate the success PATCH by check_run_id=TEST_CHECK_RUN_ID.
    const successCall = checksUpdate.mock.calls.find(
      (args: [{ check_run_id: number }]) => args[0].check_run_id === TEST_CHECK_RUN_ID,
    ) as [{ check_run_id: number; status: string; conclusion: string }] | undefined;
    expect(successCall).toBeDefined();
    const successArg = successCall![0];
    expect(successArg.status).toBe('completed');
    expect(successArg.conclusion).toBe('success');

    // The sweep PATCH (Step 4b) must fire BEFORE the new check-run POST
    // (Step 7's checks.create). Verified via the global monotonic
    // invocation-call-order counter.
    const sweepCallIdx = checksUpdate.mock.calls.indexOf(sweepCall!);
    const sweepOrder = checksUpdate.mock.invocationCallOrder[sweepCallIdx];
    const createOrder = checksCreate.mock.invocationCallOrder[0];
    expect(sweepOrder).toBeLessThan(createOrder);
  });

  it('403 on the in-progress check-run POST degrades gracefully: marks the installation missing-Checks, the walkthrough carries the permission-pending note, no check-run id is persisted, and the job does not throw', async () => {
    const { prNodeId, headSha, prNumber } = seedPr();

    // Use a distinct installation_id so the missing-permission flag we
    // assert is scoped to this test and cannot bleed from/into the
    // shared authProvider state (which uses installation_id 12345).
    const installationId = 999;

    // Make the in-progress check-run POST reject with 403 Forbidden.
    const err403 = Object.assign(new Error('Forbidden'), { status: 403 });
    (authProvider.octokit.rest.checks.create as unknown as jest.Mock).mockRejectedValue(err403);

    // Spy on insertInProgress (callThrough) to recover the worker-allocated
    // review id so we can read the real SQLite row back after process().
    const insertSpy = jest.spyOn(reviewsRepo, 'insertInProgress');

    // The job must NOT throw even though checks.create returns 403 --
    // tryPostInProgressCheckRun is best-effort and handles 403 internally.
    await expect(
      processor.process(
        makeJob({ pr_node_id: prNodeId, head_sha: headSha, pr_number: prNumber, installation_id: installationId }),
      ),
    ).resolves.not.toThrow();

    // --- Assertion 1: permission flag flipped ---
    // Step 7's 403 handler calls markChecksPermissionMissing(999) on the
    // real StubGithubAuthProvider. hasChecksPermission must now return false.
    expect(authProvider.hasChecksPermission(installationId)).toBe(false);

    // --- Assertion 2: in-progress walkthrough body carried the note ---
    // Step 8 runs AFTER Step 7 flipped the flag. The in-progress body is
    // built with missingChecksPermission: true, so it must contain the
    // unavailable-badge copy. issues.createComment[0] is the in-progress
    // POST (cold cache -- fresh PR id, no prior walkthrough comment).
    const createComment = authProvider.octokit.rest.issues.createComment as unknown as jest.Mock;
    expect(createComment).toHaveBeenCalled();
    const inProgressBody = createComment.mock.calls[0][0].body as string;
    expect(inProgressBody).toContain('merge-box status badge is unavailable');
    // Pin the in-progress body specifically — the missing-permission copy is
    // shared by the empty/success formatters too, so the mode marker proves
    // this is the Step 8 in-progress walkthrough, not some other body.
    expect(inProgressBody).toContain('mode=in-progress');

    // --- Assertion 3: real-DB -- check_run_id IS NULL ---
    // setCheckRunId was never called (checkRunId === null after the 403),
    // so the real SQLite row must still have check_run_id = null. This is
    // the net-new fact over the unit spec (which mocks setCheckRunId).
    const reservedId = insertSpy.mock.calls[0][0].id;
    const row = reviewsRepo.findById(reservedId);
    expect(row).toBeDefined();
    expect(row?.check_run_id).toBeNull();
    // The review agent loop ran normally and completed -- only the check-run
    // badge is absent; the row itself must be completed.
    expect(row?.status).toBe('completed');

    // --- Assertion 4: no terminal check-run PATCH ---
    // Step 13c is guarded by `if (checkRunId !== null)`. With checkRunId
    // null there is no success PATCH. No prior leaked check-run exists for
    // this fresh PR id (no Step 4b sweep either). Total checks.update calls
    // must be zero.
    const checksUpdate = authProvider.octokit.rest.checks.update as unknown as jest.Mock;
    expect(checksUpdate).not.toHaveBeenCalled();

    // --- Assertion 5: checks.create was attempted exactly once (the 403) ---
    const checksCreate = authProvider.octokit.rest.checks.create as unknown as jest.Mock;
    expect(checksCreate).toHaveBeenCalledTimes(1);
  });
});

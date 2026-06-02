import { ConfigService } from '@/config';
import { ReviewsProcessor } from '@/modules/reviews/reviews.processor';
import type { ReviewJobData } from '@/modules/reviews/types/review-queue';
import type { IGithubAuthProvider } from '@/modules/reviews/types/github-auth-provider';
import type { IReviewRepository } from '@/modules/reviews/types/review.repository';
import type { IReviewFindingRepository } from '@/modules/reviews/types/review-finding.repository';
import type { IPullRequestRepository } from '@/modules/webhooks/types/pull-request.repository';
import type { ReviewsService } from '@/modules/reviews/reviews.service';
import type { Job } from 'bullmq';
import type { Octokit } from 'octokit';

// Stub builders. Each test composes the minimum surface — the
// processor's narrow contract makes overriding individual methods
// per scenario cheap.

interface OctokitOpts {
  prsGet?: jest.Mock;
  request?: jest.Mock;
  createReview?: jest.Mock;
}
function makeOctokit(opts: OctokitOpts = {}): Octokit {
  return {
    rest: {
      pulls: {
        get:
          opts.prsGet ??
          jest.fn().mockResolvedValue({ data: { state: 'open' } }),
        createReview:
          opts.createReview ??
          jest
            .fn()
            .mockResolvedValue({ data: { html_url: 'https://example.test/review/1' } }),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({ data: { id: 1 } }),
        updateComment: jest.fn().mockResolvedValue({ data: {} }),
        listComments: jest.fn().mockResolvedValue({ data: [] }),
      },
    },
    request:
      opts.request ??
      jest.fn().mockResolvedValue({ data: 'diff --git a/x b/x\n+hi\n' }),
  } as unknown as Octokit;
}

const baseData: ReviewJobData = {
  pr_node_id: 'PR_node_test',
  owner: 'octocat',
  repo: 'demo',
  pr_number: 7,
  head_sha: 'a'.repeat(40),
  installation_id: 12345,
};

function makeJob(data: ReviewJobData = baseData, id = 'bullmq-job-1') {
  return { id, data } as unknown as Job<ReviewJobData>;
}

// Day-5 F2: the processor now pre-allocates the review_id and
// passes it into runRealReview. Tests of the happy path build the
// service result around that worker-allocated id by reading
// `input.reviewId` in mockImplementation. The `reviewId` parameter
// here is the OVERRIDE — set it to a non-UUID / mismatched value
// to exercise the defense-in-depth UUID-mismatch branch.
function happyServiceResult(reviewId?: string) {
  return {
    review_id: reviewId ?? '01234567-89ab-4cde-8fed-cba987654321',
    status: 'completed' as const,
    findings: [
      {
        id: 'f1',
        review_id: reviewId,
        rule_id: 'rule.test',
        severity: 'warning' as const,
        title: 'A finding',
        message: 'An explanation.',
        location_hint: 'src/a.ts:1',
        citation: 'code line',
        created_at: new Date(),
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    model: 'claude-haiku-4-5-20251001',
    prompt_version: 'v1',
    turn_count: 1,
    tool_calls: [],
  };
}

interface ProcessorParts {
  authProvider: IGithubAuthProvider;
  reviewsService: ReviewsService;
  reviewsRepo: IReviewRepository;
  findingsRepo: IReviewFindingRepository;
  octokit: Octokit;
  runRealReview: jest.Mock;
  findRecentInProgressForPr: jest.Mock;
  markFailed: jest.Mock;
  insert: jest.Mock;
}

function makeProcessor(
  overrides: Partial<{
    octokit: Octokit;
    runRealReview: ReturnType<typeof happyServiceResult>;
    runRealReviewError: unknown;
    findRecentInProgressForPr: ReturnType<
      IReviewRepository['findRecentInProgressForPr']
    >;
  }> = {},
): { processor: ReviewsProcessor } & ProcessorParts {
  const octokit = overrides.octokit ?? makeOctokit();

  const authProvider: IGithubAuthProvider = {
    forInstallation: jest.fn().mockReturnValue(octokit),
    invalidateInstallation: jest.fn(),
  };

  const runRealReview = jest.fn();
  if (overrides.runRealReviewError) {
    runRealReview.mockRejectedValue(overrides.runRealReviewError);
  } else if (overrides.runRealReview) {
    // Explicit override — return verbatim. Used by the UUID-mismatch
    // test which wants a specific review_id in the result.
    runRealReview.mockResolvedValue(overrides.runRealReview);
  } else {
    // Default happy path — forward the worker-allocated review_id so
    // the post-runRealReview UUID-match check passes.
    runRealReview.mockImplementation(async (input: { reviewId?: string }) =>
      happyServiceResult(input.reviewId),
    );
  }
  const reviewsService = {
    runRealReview,
  } as unknown as ReviewsService;

  const findRecentInProgressForPr = jest
    .fn()
    .mockReturnValue(overrides.findRecentInProgressForPr ?? undefined);
  const markFailed = jest.fn();
  const insert = jest.fn();
  const reviewsRepo: IReviewRepository = {
    insert,
    findById: jest.fn(),
    findAll: jest.fn().mockReturnValue([]),
    markCompleted: jest.fn(),
    markFailed,
    markFailedIfInProgress: jest.fn().mockReturnValue(1),
    sweepStaleInProgress: jest.fn().mockReturnValue(0),
    findRecentInProgressForPr,
    findFiltered: jest.fn().mockReturnValue([]),
    countFiltered: jest.fn().mockReturnValue(0),
    findByIdWithFindings: jest.fn().mockReturnValue(null),
    aggregateByFilter: jest.fn().mockReturnValue({
      statusBreakdown: { completed: 0, failed: 0, in_progress: 0 },
      severityRollup: { error: 0, warning: 0, info: 0 },
      topRules: [],
      tokenTotals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      latency: { p50: null, p95: null },
    }),
    distinctRepos: jest.fn().mockReturnValue([]),
    distinctAuthors: jest.fn().mockReturnValue([]),
  };

  const findingsRepo: IReviewFindingRepository = {
    insertMany: jest.fn(),
    findByReviewId: jest.fn().mockReturnValue([]),
    findByPrNodeIdForPriorReview: jest.fn().mockReturnValue([]),
  };

  const pullRequestsRepo: IPullRequestRepository = {
    save: jest.fn(),
    findByNodeId: jest.fn(),
    findRecentMatching: jest.fn().mockReturnValue([]),
    getWalkthroughCommentId: jest.fn().mockReturnValue(null),
    setWalkthroughCommentId: jest.fn(),
  };

  const config = new ConfigService();
  const processor = new ReviewsProcessor(
    authProvider,
    reviewsService,
    reviewsRepo,
    findingsRepo,
    pullRequestsRepo,
    config,
  );

  return {
    processor,
    authProvider,
    reviewsService,
    reviewsRepo,
    findingsRepo,
    octokit,
    runRealReview,
    findRecentInProgressForPr,
    markFailed,
    insert,
  };
}

describe('ReviewsProcessor.process — happy path', () => {
  it('mints Octokit per installation, fetches PR + diff, runs the service, posts the Review', async () => {
    const parts = makeProcessor();
    await parts.processor.process(makeJob());

    expect(parts.authProvider.forInstallation).toHaveBeenCalledWith(12345);
    // pulls.get and pulls.createReview both fired with the right shape.
    expect(parts.octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'demo',
      pull_number: 7,
    });
    expect(parts.runRealReview).toHaveBeenCalledTimes(1);
    expect(parts.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    const reviewArgs = (parts.octokit.rest.pulls.createReview as unknown as jest.Mock).mock
      .calls[0][0];
    expect(reviewArgs.owner).toBe('octocat');
    expect(reviewArgs.repo).toBe('demo');
    expect(reviewArgs.pull_number).toBe(7);
    expect(reviewArgs.event).toBe('COMMENT');
    // commit_id intentionally OMITTED so GitHub defaults to PR's tip.
    expect(reviewArgs.commit_id).toBeUndefined();
    // body has the marker.
    expect(reviewArgs.body).toContain('ai-pr-review-copilot:v1:review-id=');
    // retries: 0 sent through the request options.
    expect(reviewArgs.request).toEqual({ retries: 0 });
  });
});

describe('ReviewsProcessor.process — guards', () => {
  it('skips when a recent in_progress row already exists for the PR', async () => {
    const parts = makeProcessor({
      findRecentInProgressForPr: {
        id: 'existing',
        pr_node_id: baseData.pr_node_id,
        created_by: null,
        diff_length: 0,
        model: 'haiku',
        prompt_version: 'v1',
        top_k: 0,
        retrieved_chunk_ids: '[]',
        retrieved_chunk_ids_hash: '0'.repeat(64),
        status: 'in_progress',
        error_status: null,
        error_code: null,
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        turn_count: 0,
        tool_calls_json: null,
        created_at: new Date(),
        completed_at: null,
      },
    });

    await parts.processor.process(makeJob());
    // None of Octokit / runRealReview ran.
    expect(parts.octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(parts.runRealReview).not.toHaveBeenCalled();
    expect(parts.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('marks failed/pr_closed_during_review when state !== open', async () => {
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet: jest
          .fn()
          .mockResolvedValue({ data: { state: 'closed' } }),
      }),
    });

    await parts.processor.process(makeJob());

    expect(parts.runRealReview).not.toHaveBeenCalled();
    expect(parts.insert).toHaveBeenCalledTimes(1);
    expect(parts.insert.mock.calls[0][0].error_code).toBe(
      'pr_closed_during_review',
    );
    expect(parts.insert.mock.calls[0][0].status).toBe('failed');
  });

  it('marks failed/pr_closed_during_review and re-throws UnrecoverableError when pulls.get 404s', async () => {
    const err: Error & { status?: number } = new Error('Not Found');
    err.status = 404;
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet: jest.fn().mockRejectedValue(err),
      }),
    });

    // 404 on pulls.get is terminal — the PR (or repo) is gone. We
    // record the attempt, throw UnrecoverableError, and rely on
    // BullMQ to skip the retry attempts entirely.
    await expect(parts.processor.process(makeJob())).rejects.toThrow(/Not Found/);
    expect(parts.insert).toHaveBeenCalledTimes(1);
    expect(parts.insert.mock.calls[0][0].error_code).toBe(
      'pr_closed_during_review',
    );
    expect(parts.insert.mock.calls[0][0].error_status).toBe(404);
  });

  it('marks failed/github_api_error and re-throws on non-terminal pulls.get failures', async () => {
    const err: Error & { status?: number } = new Error('Bad Gateway');
    err.status = 502;
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet: jest.fn().mockRejectedValue(err),
      }),
    });

    await expect(parts.processor.process(makeJob())).rejects.toThrow(/Bad Gateway/);
    expect(parts.insert.mock.calls[0][0].error_code).toBe('github_api_error');
    expect(parts.insert.mock.calls[0][0].error_status).toBe(502);
  });

  it('marks failed/diff_too_large when diff exceeds MAX_DIFF_BYTES', async () => {
    const prevCap = process.env.MAX_DIFF_BYTES;
    process.env.MAX_DIFF_BYTES = '10';
    try {
      const parts = makeProcessor({
        octokit: makeOctokit({
          request: jest
            .fn()
            .mockResolvedValue({ data: 'this diff is way more than ten bytes' }),
        }),
      });
      await parts.processor.process(makeJob());
      expect(parts.runRealReview).not.toHaveBeenCalled();
      expect(parts.insert).toHaveBeenCalledTimes(1);
      expect(parts.insert.mock.calls[0][0].error_code).toBe('diff_too_large');
    } finally {
      if (prevCap === undefined) delete process.env.MAX_DIFF_BYTES;
      else process.env.MAX_DIFF_BYTES = prevCap;
    }
  });

  describe('size gate (MAX_REVIEW_DIFF_LINES)', () => {
    // A diff with 5 changed lines (3 added + 2 removed). Each "+" or
    // "-" content line counts; +++/---/@@ headers do not.
    const FIVE_LINE_DIFF = [
      'diff --git a/x.js b/x.js',
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,3 +1,4 @@',
      ' context',
      '+added one',
      '+added two',
      '+added three',
      '-removed one',
      '-removed two',
    ].join('\n');

    function withSizeCap<T>(cap: string, fn: () => Promise<T>): Promise<T> {
      const prev = process.env.MAX_REVIEW_DIFF_LINES;
      process.env.MAX_REVIEW_DIFF_LINES = cap;
      return fn().finally(() => {
        if (prev === undefined) delete process.env.MAX_REVIEW_DIFF_LINES;
        else process.env.MAX_REVIEW_DIFF_LINES = prev;
      });
    }

    it('posts skip-walkthrough + inserts standalone-skipped row + does NOT call runRealReview when changed lines > cap', async () => {
      await withSizeCap('2', async () => {
        const parts = makeProcessor({
          octokit: makeOctokit({
            request: jest.fn().mockResolvedValue({ data: FIVE_LINE_DIFF }),
          }),
        });

        await parts.processor.process(makeJob());

        // No agent loop ran.
        expect(parts.runRealReview).not.toHaveBeenCalled();
        // No formal Review POST either.
        expect(parts.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
        // Walkthrough comment was created (cold cache → createComment).
        expect(parts.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        const commentArgs = (parts.octokit.rest.issues.createComment as unknown as jest.Mock).mock.calls[0][0];
        expect(commentArgs.body).toContain('review skipped');
      });
    });

    it('quotes the actual changed-line count and the configured cap in the skip comment', async () => {
      await withSizeCap('2', async () => {
        const parts = makeProcessor({
          octokit: makeOctokit({
            request: jest.fn().mockResolvedValue({ data: FIVE_LINE_DIFF }),
          }),
        });

        await parts.processor.process(makeJob());

        const commentArgs = (parts.octokit.rest.issues.createComment as unknown as jest.Mock).mock.calls[0][0];
        // 5 changed lines (3 added + 2 removed), cap of 2.
        expect(commentArgs.body).toContain('5 changed lines');
        expect(commentArgs.body).toContain('limit of **2**');
      });
    });

    it('persists a completed standalone-skipped-too-large row carrying the diff_length', async () => {
      await withSizeCap('2', async () => {
        const parts = makeProcessor({
          octokit: makeOctokit({
            request: jest.fn().mockResolvedValue({ data: FIVE_LINE_DIFF }),
          }),
        });

        await parts.processor.process(makeJob());

        expect(parts.insert).toHaveBeenCalledTimes(1);
        const row = parts.insert.mock.calls[0][0];
        expect(row.status).toBe('completed');
        expect(row.prompt_version).toBe('standalone-skipped-too-large');
        expect(row.error_code).toBeNull();
        expect(row.error_status).toBeNull();
        expect(row.diff_length).toBe(Buffer.byteLength(FIVE_LINE_DIFF, 'utf8'));
        expect(row.top_k).toBe(0);
      });
    });

    it('still persists the standalone-skipped row when the walkthrough POST fails (best-effort)', async () => {
      await withSizeCap('2', async () => {
        const createCommentErr: Error & { status?: number } =
          new Error('Bad Gateway');
        createCommentErr.status = 502;
        const octokit = makeOctokit({
          request: jest.fn().mockResolvedValue({ data: FIVE_LINE_DIFF }),
        });
        (octokit.rest.issues.createComment as unknown as jest.Mock).mockRejectedValue(
          createCommentErr,
        );
        const parts = makeProcessor({ octokit });

        await expect(parts.processor.process(makeJob())).resolves.toBeUndefined();

        // No agent loop, no Review POST.
        expect(parts.runRealReview).not.toHaveBeenCalled();
        // The audit row landed despite the comment failure.
        expect(parts.insert).toHaveBeenCalledTimes(1);
        expect(parts.insert.mock.calls[0][0].prompt_version).toBe(
          'standalone-skipped-too-large',
        );
      });
    });

    it('does NOT skip when changed-line count is at or below the cap (boundary)', async () => {
      // 5 changed lines, cap of 5 → strict `>` check means this runs normally.
      await withSizeCap('5', async () => {
        const parts = makeProcessor({
          octokit: makeOctokit({
            request: jest.fn().mockResolvedValue({ data: FIVE_LINE_DIFF }),
          }),
        });

        await parts.processor.process(makeJob());

        // Agent loop ran — the gate did not fire.
        expect(parts.runRealReview).toHaveBeenCalledTimes(1);
        // No size-skip comment.
        const createCalls = (parts.octokit.rest.issues.createComment as unknown as jest.Mock).mock.calls;
        for (const args of createCalls) {
          expect(args[0].body).not.toContain('review skipped');
        }
      });
    });
  });

  it('exits clean on empty diff without calling Anthropic or posting, and inserts a standalone completion row', async () => {
    const parts = makeProcessor({
      octokit: makeOctokit({
        request: jest.fn().mockResolvedValue({ data: '   \n  ' }),
      }),
    });

    await parts.processor.process(makeJob());
    expect(parts.runRealReview).not.toHaveBeenCalled();
    expect(parts.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    // F1 closure: the audit row exists with status='completed',
    // error_code=null, and the dedicated prompt_version so Day-6
    // eval can filter standalone empty diffs out cleanly.
    expect(parts.insert).toHaveBeenCalledTimes(1);
    const row = parts.insert.mock.calls[0][0];
    expect(row.status).toBe('completed');
    expect(row.error_code).toBeNull();
    expect(row.prompt_version).toBe('standalone-empty-diff');
    expect(row.diff_length).toBe(0);
  });
});

describe('ReviewsProcessor.process — Review POST failure', () => {
  it('marks failed/inline_post_failed and throws UnrecoverableError when createReview throws (F3)', async () => {
    const err: Error & { status?: number } = new Error('Bad Gateway');
    err.status = 502;
    const parts = makeProcessor({
      octokit: makeOctokit({
        createReview: jest.fn().mockRejectedValue(err),
      }),
    });

    // F3: POST failures are terminal — a retry reruns the agent
    // loop AND POSTs again (3× duplicate Reviews + 3× Anthropic
    // spend on a flaky 5xx). UnrecoverableError tells BullMQ to
    // skip remaining attempts.
    const { UnrecoverableError } = jest.requireActual('bullmq');
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(parts.markFailed).toHaveBeenCalledTimes(1);
    const [reviewId, patch] = parts.markFailed.mock.calls[0];
    expect(typeof reviewId).toBe('string');
    expect(patch.error_code).toBe('inline_post_failed');
    expect(patch.error_status).toBe(502);
  });

  it('reclassifies a 422 createReview as pr_closed_during_review when the PR closed mid-run (F5)', async () => {
    const err: Error & { status?: number } = new Error('Unprocessable Entity');
    err.status = 422;
    // pulls.get is called TWICE: once at step 4 (state='open') and
    // once again from the F5 catch (state='closed' — the PR closed
    // during runRealReview).
    const prsGet = jest
      .fn()
      .mockResolvedValueOnce({ data: { state: 'open' } })
      .mockResolvedValueOnce({ data: { state: 'closed' } });
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet,
        createReview: jest.fn().mockRejectedValue(err),
      }),
    });

    const { UnrecoverableError } = jest.requireActual('bullmq');
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(prsGet).toHaveBeenCalledTimes(2);
    expect(parts.markFailed).toHaveBeenCalledTimes(1);
    expect(parts.markFailed.mock.calls[0][1].error_code).toBe(
      'pr_closed_during_review',
    );
    expect(parts.markFailed.mock.calls[0][1].error_status).toBe(422);
  });

  it('keeps inline_post_failed on a 422 when the recheck still shows the PR open (F5 fallback)', async () => {
    const err: Error & { status?: number } = new Error('Unprocessable Entity');
    err.status = 422;
    const prsGet = jest
      .fn()
      .mockResolvedValueOnce({ data: { state: 'open' } })
      .mockResolvedValueOnce({ data: { state: 'open' } });
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet,
        createReview: jest.fn().mockRejectedValue(err),
      }),
    });

    const { UnrecoverableError } = jest.requireActual('bullmq');
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(parts.markFailed.mock.calls[0][1].error_code).toBe(
      'inline_post_failed',
    );
  });
});

describe('ReviewsProcessor.process — Anthropic retry classification (F4)', () => {
  // Pull AnthropicRequestError from the real impl — the spec only
  // cares about errorCode/retryAfterMs surface shapes.
  const {
    AnthropicRequestError,
  } = jest.requireActual('@/infrastructure/anthropic');

  it('wraps credit_balance_too_low in UnrecoverableError (terminal — no retry)', async () => {
    const err = new AnthropicRequestError('credit too low', {
      status: 400,
      errorCode: 'credit_balance_too_low',
    });
    const parts = makeProcessor({ runRealReviewError: err });

    const { UnrecoverableError } = jest.requireActual('bullmq');
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(parts.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('wraps invalid_request_error in UnrecoverableError (terminal)', async () => {
    const err = new AnthropicRequestError('bad request', {
      status: 400,
      errorCode: 'invalid_request_error',
    });
    const parts = makeProcessor({ runRealReviewError: err });
    const { UnrecoverableError } = jest.requireActual('bullmq');
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('re-throws Anthropic 429 untouched so BullMQ honours retry-after via the custom backoff', async () => {
    const err = new AnthropicRequestError('rate limited', {
      status: 429,
      errorCode: 'rate_limit_error',
      retryAfterMs: 5000,
    });
    const parts = makeProcessor({ runRealReviewError: err });
    const { UnrecoverableError } = jest.requireActual('bullmq');
    // Should be the original AnthropicRequestError, NOT UnrecoverableError.
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      AnthropicRequestError,
    );
    await expect(parts.processor.process(makeJob())).rejects.not.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});

describe('reviewBackoffStrategy (F4)', () => {
  // Custom backoffStrategy that pairs with backoff: { type: 'custom' }
  // on the queue. Returns Anthropic retry-after when present;
  // exponential 1s/2s/4s otherwise.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    reviewBackoffStrategy,
  } = require('@/modules/reviews/reviews.processor');

  it('honours retryAfterMs on the error when present', () => {
    const err = Object.assign(new Error('rate limited'), {
      retryAfterMs: 7500,
    });
    expect(reviewBackoffStrategy(1, 'custom', err)).toBe(7500);
  });

  it('clamps a malicious / huge retryAfterMs to 60s', () => {
    const err = Object.assign(new Error('rate limited'), {
      retryAfterMs: 10 * 60 * 1000,
    });
    expect(reviewBackoffStrategy(1, 'custom', err)).toBe(60_000);
  });

  it('falls back to exponential 1s/2s/4s when retryAfterMs is absent', () => {
    const err = new Error('5xx');
    expect(reviewBackoffStrategy(1, 'custom', err)).toBe(1000);
    expect(reviewBackoffStrategy(2, 'custom', err)).toBe(2000);
    expect(reviewBackoffStrategy(3, 'custom', err)).toBe(4000);
  });

  it('survives an undefined error object (BullMQ sometimes passes undefined)', () => {
    expect(reviewBackoffStrategy(1, 'custom', undefined)).toBe(1000);
  });
});

describe('ReviewsProcessor.process — runRealReview failure', () => {
  it('re-throws runRealReview errors so BullMQ schedules a retry', async () => {
    const err = new Error('Anthropic 429');
    const parts = makeProcessor({ runRealReviewError: err });

    await expect(parts.processor.process(makeJob())).rejects.toThrow(/Anthropic/);
    // POST never happened.
    expect(parts.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    // We do NOT write a duplicate standalone failure row — runRealReview
    // already wrote its own.
    expect(parts.insert).not.toHaveBeenCalled();
  });
});

describe('ReviewsProcessor.process — UUID validation', () => {
  it('throws and marks failed when runRealReview returns a review_id that does not match the worker-allocated id', async () => {
    // Day-5 F2: the worker pre-allocates the review_id and passes it
    // into runRealReview. A drift between what we passed in and what
    // came back signals an internal-logic bug; we fail terminally
    // (UnrecoverableError — no retry) and mark the row failed/internal_error.
    const parts = makeProcessor({
      runRealReview: happyServiceResult('not-a-uuid'),
    });
    await expect(parts.processor.process(makeJob())).rejects.toThrow(
      /did not match worker-allocated id/,
    );
    expect(parts.markFailed).toHaveBeenCalledTimes(1);
    expect(parts.markFailed.mock.calls[0][1].error_code).toBe('internal_error');
    // POST never fired (the format-review-body check ran before it).
    expect(parts.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });
});

describe('ReviewsProcessor.drainGracefully', () => {
  // Subclass exposes the activeReviewIds set so tests can seed
  // in-flight reviews without running the full process() path. Also
  // stubs the `worker` getter so the drain can exercise its happy
  // path without a real BullMQ worker instance.
  class TestProcessor extends ReviewsProcessor {
    public stubWorker: {
      pause: jest.Mock;
      close: jest.Mock;
    } = {
      pause: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    public seedInFlight(ids: string[]): void {
      for (const id of ids) {
        (this as unknown as { activeReviewIds: Set<string> }).activeReviewIds.add(
          id,
        );
      }
    }

    // Override the WorkerHost getter to return our stub.
    override get worker(): never {
      return this.stubWorker as unknown as never;
    }
  }

  function makeTestProcessor() {
    const authProvider: IGithubAuthProvider = {
      forInstallation: jest.fn(),
      invalidateInstallation: jest.fn(),
    };
    const markRowsFailedByIdSet = jest.fn();
    const reviewsService = {
      runRealReview: jest.fn(),
      markRowsFailedByIdSet,
    } as unknown as ReviewsService;

    const reviewsRepo: IReviewRepository = {
      insert: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn().mockReturnValue([]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
      markFailedIfInProgress: jest.fn().mockReturnValue(1),
      sweepStaleInProgress: jest.fn().mockReturnValue(0),
      findRecentInProgressForPr: jest.fn(),
      findFiltered: jest.fn().mockReturnValue([]),
      countFiltered: jest.fn().mockReturnValue(0),
      findByIdWithFindings: jest.fn().mockReturnValue(null),
      aggregateByFilter: jest.fn().mockReturnValue({
        statusBreakdown: { completed: 0, failed: 0, in_progress: 0 },
        severityRollup: { error: 0, warning: 0, info: 0 },
        topRules: [],
        tokenTotals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        latency: { p50: null, p95: null },
      }),
      distinctRepos: jest.fn().mockReturnValue([]),
      distinctAuthors: jest.fn().mockReturnValue([]),
    };
    const findingsRepo: IReviewFindingRepository = {
      insertMany: jest.fn(),
      findByReviewId: jest.fn(),
      findByPrNodeIdForPriorReview: jest.fn(),
    };
    const pullRequestsRepo: IPullRequestRepository = {
      save: jest.fn(),
      findByNodeId: jest.fn(),
      findRecentMatching: jest.fn().mockReturnValue([]),
      getWalkthroughCommentId: jest.fn().mockReturnValue(null),
      setWalkthroughCommentId: jest.fn(),
    };
    const config = new ConfigService();
    const processor = new TestProcessor(
      authProvider,
      reviewsService,
      reviewsRepo,
      findingsRepo,
      pullRequestsRepo,
      config,
    );
    return { processor, markRowsFailedByIdSet };
  }

  it('completes cleanly when no jobs are in-flight', async () => {
    const { processor, markRowsFailedByIdSet } = makeTestProcessor();
    await processor.drainGracefully(5_000);
    expect(processor.stubWorker.pause).toHaveBeenCalledTimes(1);
    expect(processor.stubWorker.close).toHaveBeenCalledTimes(1);
    // Close was called with `false` (graceful), not the forced variant.
    expect(processor.stubWorker.close).toHaveBeenCalledWith(false);
    expect(markRowsFailedByIdSet).not.toHaveBeenCalled();
  });

  it('completes cleanly when the in-flight job finishes inside the timeout', async () => {
    const { processor, markRowsFailedByIdSet } = makeTestProcessor();
    processor.seedInFlight(['rev-a']);
    // Close resolves quickly — simulates BullMQ finishing the job
    // before the timeout fires.
    processor.stubWorker.close.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5).unref()),
    );

    await processor.drainGracefully(200);
    // Drain succeeded — no rows were marked failed.
    expect(markRowsFailedByIdSet).not.toHaveBeenCalled();
  });

  it('marks every in-flight row failed/process_terminated on timeout', async () => {
    const { processor, markRowsFailedByIdSet } = makeTestProcessor();
    processor.seedInFlight(['rev-1', 'rev-2', 'rev-3']);
    // Graceful close (false) hangs past the drain timeout; forced
    // close (true) returns immediately — mirrors BullMQ's real
    // contract where `close(true)` aborts in-flight work and
    // resolves promptly.
    processor.stubWorker.close.mockImplementation((force: boolean) =>
      force ? Promise.resolve() : new Promise<void>(() => undefined),
    );

    await processor.drainGracefully(60);

    expect(markRowsFailedByIdSet).toHaveBeenCalledTimes(1);
    const [ids, errorCode] = markRowsFailedByIdSet.mock.calls[0];
    expect(new Set(ids)).toEqual(new Set(['rev-1', 'rev-2', 'rev-3']));
    expect(errorCode).toBe('process_terminated');
    // Forced close called after timeout (close(true)).
    const forcedCloseCalls = processor.stubWorker.close.mock.calls.filter(
      (c) => c[0] === true,
    );
    expect(forcedCloseCalls).toHaveLength(1);
  });

  it('skips pause/close gracefully when the worker getter throws (no BullMQ wired)', async () => {
    const { processor, markRowsFailedByIdSet } = makeTestProcessor();
    processor.seedInFlight(['rev-x']);
    Object.defineProperty(processor, 'worker', {
      get() {
        throw new Error('worker not initialized');
      },
    });

    // Without a worker the drain immediately resolves as "drained"
    // and skips the timeout/markFailed branch — the BullMQ side has
    // nothing to clean up.
    await processor.drainGracefully(100);
    expect(markRowsFailedByIdSet).not.toHaveBeenCalled();
  });
});

describe('ReviewsProcessor.onApplicationShutdown', () => {
  it('delegates to drainGracefully with the configured timeout', async () => {
    const parts = makeProcessor();
    const drainSpy = jest
      .spyOn(parts.processor, 'drainGracefully')
      .mockResolvedValue(undefined);
    try {
      await parts.processor.onApplicationShutdown();
      expect(drainSpy).toHaveBeenCalledTimes(1);
      // Default SHUTDOWN_DRAIN_TIMEOUT_MS is 15_000 (Day-5 F14
      // closure — see ConfigService) since jest.setup.ts doesn't
      // override it.
      expect(drainSpy).toHaveBeenCalledWith(15_000);
    } finally {
      drainSpy.mockRestore();
    }
  });
});

import { ConfigService } from '@/config';
import { ReviewsProcessor } from '@/modules/reviews/reviews.processor';
import type { ReviewJobData } from '@/modules/reviews/types/review-queue';
import type { IGithubAuthProvider } from '@/modules/reviews/types/github-auth-provider';
import type { IReviewRepository } from '@/modules/reviews/types/review.repository';
import type { IReviewFindingRepository } from '@/modules/reviews/types/review-finding.repository';
import type { IPullRequestRepository } from '@/modules/webhooks/types/pull-request.repository';
import type { ReviewsService } from '@/modules/reviews/reviews.service';
import type { IWalkthroughSummarizer } from '@/modules/reviews/types/walkthrough-summarizer';
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
      checks: {
        update: jest.fn().mockResolvedValue({ data: {} }),
        create: jest.fn().mockResolvedValue({ data: { id: 1 } }),
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

// The processor pre-allocates the review_id and passes it into
// runRealReview. Happy-path tests build the service result around
// that worker-allocated id by reading `input.reviewId` in
// mockImplementation. The `reviewId` parameter here is the OVERRIDE —
// set it to a non-UUID / mismatched value to exercise the
// defense-in-depth UUID-mismatch branch.
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
    retrievedRules: [],
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
  markCompleted: jest.Mock;
  insert: jest.Mock;
  insertInProgress: jest.Mock;
  updateRetrievalMetadata: jest.Mock;
  getWalkthroughCommentId: jest.Mock;
  setWalkthroughCommentId: jest.Mock;
  setWalkthroughSummary: jest.Mock;
  summarizer: IWalkthroughSummarizer;
  summarize: jest.Mock;
}

function makeProcessor(
  overrides: Partial<{
    octokit: Octokit;
    runRealReview: ReturnType<typeof happyServiceResult>;
    runRealReviewError: unknown;
    findRecentInProgressForPr: ReturnType<
      IReviewRepository['findRecentInProgressForPr']
    >;
    // Seed for the stateful walkthrough-comment-id cache. A non-null
    // value models a re-review (a walkthrough already exists), which
    // makes Step 8's createIfAbsent short-circuit to 'skipped'.
    walkthroughCachedId: number | null;
    // Override the summarizer mock — e.g. a null-returning summarize to
    // exercise the failure-persists-null branch.
    summarizer: IWalkthroughSummarizer;
  }> = {},
): { processor: ReviewsProcessor } & ProcessorParts {
  const octokit = overrides.octokit ?? makeOctokit();

  const authProvider: IGithubAuthProvider = {
    forInstallation: jest.fn().mockReturnValue(octokit),
    invalidateInstallation: jest.fn(),
    markChecksPermissionMissing: jest.fn(),
    hasChecksPermission: jest.fn().mockReturnValue(true),
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
  const markCompleted = jest.fn();
  const insert = jest.fn();
  const insertInProgress = jest.fn();
  const updateRetrievalMetadata = jest.fn();
  const setWalkthroughSummary = jest.fn();
  const reviewsRepo: IReviewRepository = {
    insert,
    insertInProgress,
    updateRetrievalMetadata,
    findById: jest.fn(),
    findAll: jest.fn().mockReturnValue([]),
    markCompleted,
    markFailed,
    markFailedIfInProgress: jest.fn().mockReturnValue(1),
    sweepStaleInProgress: jest.fn().mockReturnValue(0),
    findRecentInProgressForPr,
    findMostRecentPriorCheckRun: jest.fn().mockReturnValue(undefined),
    findFiltered: jest.fn().mockReturnValue([]),
    countFiltered: jest.fn().mockReturnValue(0),
    findByIdWithFindings: jest.fn().mockReturnValue(null),
    aggregateByFilter: jest.fn().mockReturnValue({
      statusBreakdown: { completed: 0, failed: 0, in_progress: 0 },
      severityRollup: { error: 0, warning: 0, info: 0 },
      topRules: [],
      tokenTotals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      latency: { p50: null, p95: null },
      skippedCount: 0,
    }),
    distinctRepos: jest.fn().mockReturnValue([]),
    distinctAuthors: jest.fn().mockReturnValue([]),
    setCheckRunId: jest.fn(),
    setWalkthroughSummary,
  };

  const findingsRepo: IReviewFindingRepository = {
    insertMany: jest.fn(),
    findByReviewId: jest.fn().mockReturnValue([]),
    findByPrNodeIdForPriorReview: jest.fn().mockReturnValue([]),
  };

  // Default happy-path summarizer: returns a non-null intro so the
  // success path exercises a real prose summary. Tests asserting the
  // failure branch pass an override whose summarize resolves null.
  const summarizer: IWalkthroughSummarizer = overrides.summarizer ?? {
    summarize: jest.fn().mockResolvedValue({ intro: 'A concise summary.' }),
  };
  const summarize = summarizer.summarize as jest.Mock;

  // Stateful walkthrough-comment-id cache. setWalkthroughCommentId
  // writes the closed-over slot and getWalkthroughCommentId reads it,
  // so warming the cache (the in-progress create on a first review)
  // makes the terminal upsert PATCH the same comment instead of
  // creating a duplicate. Seedable to a starting value to model a
  // re-review where a walkthrough already exists.
  let walkthroughCommentId: number | null =
    overrides.walkthroughCachedId ?? null;
  const getWalkthroughCommentId = jest.fn(() => walkthroughCommentId);
  const setWalkthroughCommentId = jest.fn((_prNodeId: string, id: number | null) => {
    walkthroughCommentId = id;
  });
  const pullRequestsRepo: IPullRequestRepository = {
    save: jest.fn(),
    findByNodeId: jest.fn(),
    findRecentMatching: jest.fn().mockReturnValue([]),
    getWalkthroughCommentId,
    setWalkthroughCommentId,
  };

  const config = new ConfigService();
  const processor = new ReviewsProcessor(
    authProvider,
    reviewsService,
    reviewsRepo,
    findingsRepo,
    pullRequestsRepo,
    config,
    summarizer,
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
    markCompleted,
    insert,
    insertInProgress,
    updateRetrievalMetadata,
    getWalkthroughCommentId,
    setWalkthroughCommentId,
    setWalkthroughSummary,
    summarizer,
    summarize,
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

describe('ReviewsProcessor.process — terminal check-run (Step 13c)', () => {
  it('PATCHes the check-run to success on a completed review', async () => {
    const parts = makeProcessor();
    await parts.processor.process(makeJob());

    const checksUpdate = parts.octokit.rest.checks.update as unknown as jest.Mock;
    // The only checks.update on this happy path is the terminal Step 13c
    // PATCH (no prior leaked run → no sweep). The in-progress check-run id
    // is 1 (the checks.create stub), so the PATCH targets check_run_id 1
    // and flips it to a green completed/success.
    expect(checksUpdate).toHaveBeenCalledTimes(1);
    expect(checksUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 1,
        status: 'completed',
        conclusion: 'success',
      }),
    );
    // The output carries a success title (1 finding on the happy path).
    expect(checksUpdate.mock.calls[0][0].output.title).toContain('against your knowledge base');
  });

  it('fails the row and throws when the success check-run PATCH fails', async () => {
    const err: Error & { status?: number } = new Error('Internal Server Error');
    err.status = 500;
    const octokit = makeOctokit();
    // The terminal Step 13c PATCH is the only checks.update on this path
    // (no sweep), so rejecting checks.update outright exercises the
    // check_run_patch_failed branch.
    (octokit.rest.checks.update as unknown as jest.Mock).mockRejectedValue(err);
    const parts = makeProcessor({ octokit });

    const { UnrecoverableError } = jest.requireActual('bullmq');
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(parts.markFailed).toHaveBeenCalledTimes(1);
    const [reviewId, patch] = parts.markFailed.mock.calls[0];
    expect(typeof reviewId).toBe('string');
    expect(patch.error_code).toBe('check_run_patch_failed');
    expect(patch.error_status).toBe(500);
  });

  it('posts the Review when there are outside-diff findings but zero inline (gap closed)', async () => {
    // A finding whose location_hint parses but points at a file NOT in the
    // diff → partition.outsideDiff is non-empty while partition.anchorable
    // stays empty. The old gate (sanitizedFindings.length > 0) and the new
    // gate (shouldPostReview) both post here, but the new gate makes the
    // intent explicit: a Review still goes up carrying only the
    // outside-diff callout, with an empty inline comments[] array.
    const parts = makeProcessor();
    parts.runRealReview.mockImplementation(async (input: { reviewId?: string }) => ({
      ...happyServiceResult(input.reviewId),
      findings: [
        {
          id: 'f-out',
          review_id: input.reviewId,
          rule_id: 'rule.out',
          severity: 'warning' as const,
          title: 'Outside-diff finding',
          message: 'Points at a file not in this diff.',
          location_hint: 'totally/other.ts:5',
          citation: 'n/a',
          created_at: new Date(),
        },
      ],
    }));

    await parts.processor.process(makeJob());

    const createReview = parts.octokit.rest.pulls.createReview as unknown as jest.Mock;
    expect(createReview).toHaveBeenCalledTimes(1);
    // No inline comments anchored — the Review posts with an empty
    // comments[] array plus the outside-diff callout in the body.
    expect(createReview.mock.calls[0][0].comments).toEqual([]);
  });

  it('clean review (0 findings) posts no Review, a success "No findings" check-run, and a walkthrough WITHOUT the "see the review below" footer', async () => {
    const parts = makeProcessor();
    parts.runRealReview.mockImplementation(async (input: { reviewId?: string }) => ({
      ...happyServiceResult(input.reviewId),
      findings: [],
    }));

    await parts.processor.process(makeJob());

    // No Review posted on a fully clean review.
    expect(parts.octokit.rest.pulls.createReview as unknown as jest.Mock).not.toHaveBeenCalled();
    // The terminal check-run PATCH is a SUCCESS with the "No findings" title.
    const checksUpdate = parts.octokit.rest.checks.update as unknown as jest.Mock;
    expect(checksUpdate).toHaveBeenCalledTimes(1);
    expect(checksUpdate.mock.calls[0][0].conclusion).toBe('success');
    expect(checksUpdate.mock.calls[0][0].output.title).toContain('No findings');
    // The terminal walkthrough (warm cache → updateComment) carries the
    // success body but omits the misleading "see the review below" footer.
    const updateComment = parts.octokit.rest.issues.updateComment as unknown as jest.Mock;
    expect(updateComment).toHaveBeenCalledTimes(1);
    const walkthroughBody = updateComment.mock.calls[0][0].body;
    expect(walkthroughBody).toContain('mode=success');
    expect(walkthroughBody).not.toContain('See the review below');
  });
});

describe('ReviewsProcessor.process — walkthrough summarizer (Step 11/12)', () => {
  it('calls the summarizer with the diff, findings, and retrieved rules on success, and persists the intro', async () => {
    const parts = makeProcessor();
    // Forward the worker-allocated id (so the UUID-match check passes)
    // while injecting a populated retrievedRules so the summarizer call
    // shape can be asserted end-to-end.
    parts.runRealReview.mockImplementation(
      async (input: { reviewId?: string }) => ({
        ...happyServiceResult(input.reviewId),
        retrievedRules: [
          {
            rule_id: 'rule.test',
            source: 'team-handbook',
            title: 'A retrieved rule',
          },
        ],
      }),
    );

    await parts.processor.process(makeJob());

    // Capture the worker-allocated review id from the insertInProgress call.
    const reservedId = parts.insertInProgress.mock.calls[0][0].id as string;

    expect(parts.summarize).toHaveBeenCalledTimes(1);
    const summarizeArg = parts.summarize.mock.calls[0][0];
    expect(typeof summarizeArg.diff).toBe('string');
    expect(summarizeArg.diff.length).toBeGreaterThan(0);
    expect(summarizeArg.findings).toEqual([
      { rule_id: 'rule.test', title: 'A finding', severity: 'warning' },
    ]);
    expect(summarizeArg.retrievedRules).toEqual([
      { rule_id: 'rule.test', source: 'team-handbook', title: 'A retrieved rule' },
    ]);

    expect(parts.setWalkthroughSummary).toHaveBeenCalledTimes(1);
    expect(parts.setWalkthroughSummary).toHaveBeenCalledWith(
      reservedId,
      'A concise summary.',
    );
  });

  it('persists null when the summarizer returns null (failure), without throwing', async () => {
    const summarize = jest.fn().mockResolvedValue(null);
    const parts = makeProcessor({ summarizer: { summarize } });

    await expect(parts.processor.process(makeJob())).resolves.toBeUndefined();

    const reservedId = parts.insertInProgress.mock.calls[0][0].id as string;

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(parts.setWalkthroughSummary).toHaveBeenCalledTimes(1);
    expect(parts.setWalkthroughSummary).toHaveBeenCalledWith(reservedId, null);
    // The review still posts — the summarizer is best-effort and its
    // null result does not abort the terminal Review.
    expect(parts.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it('persists null and still posts the review when the summarizer throws', async () => {
    const parts = makeProcessor();
    // Override the summarize mock to reject — simulates a contract regression
    // where the summarizer throws instead of returning null.
    (parts.summarize as jest.Mock).mockRejectedValueOnce(
      new Error('summarizer exploded'),
    );

    await expect(parts.processor.process(makeJob())).resolves.toBeUndefined();

    const reservedId = parts.insertInProgress.mock.calls[0][0].id as string;

    // The try/catch swallowed the throw and fell through to the persist step.
    expect(parts.setWalkthroughSummary).toHaveBeenCalledTimes(1);
    expect(parts.setWalkthroughSummary).toHaveBeenCalledWith(reservedId, null);
    // The review still posts — a throwing summarizer must not abort the job.
    expect(parts.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewsProcessor.process — check-run sweep', () => {
  it('retires the most-recent prior leaked check-run to neutral', async () => {
    const parts = makeProcessor();
    (parts.reviewsRepo.findMostRecentPriorCheckRun as jest.Mock).mockReturnValue({
      reviewId: 'prior-review-id',
      checkRunId: 4242,
    });

    await parts.processor.process(makeJob());

    expect(parts.reviewsRepo.findMostRecentPriorCheckRun).toHaveBeenCalledWith({
      prNodeId: baseData.pr_node_id,
      excludingReviewId: expect.any(String),
    });
    const checksUpdate = parts.octokit.rest.checks.update as unknown as jest.Mock;
    // Two PATCHes on this happy path: the sweep retires the prior leaked
    // run (4242) to neutral, then Step 13c PATCHes THIS review's
    // in-progress check-run (id 1) to its terminal success state.
    expect(checksUpdate).toHaveBeenCalledTimes(2);
    expect(checksUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: baseData.owner,
        repo: baseData.repo,
        check_run_id: 4242,
        status: 'completed',
        conclusion: 'neutral',
        output: {
          title: 'Superseded by newer review on this PR.',
          summary: 'A newer review has started on this pull request.',
        },
      }),
    );
    // The terminal Step 13c PATCH is a SUCCESS conclusion against the
    // current review's own in-progress check-run.
    expect(checksUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 1,
        status: 'completed',
        conclusion: 'success',
      }),
    );
  });

  it('does not PATCH a sweep (neutral) check-run when there is no prior leaked run', async () => {
    const parts = makeProcessor();
    // findMostRecentPriorCheckRun defaults to mockReturnValue(undefined)
    await parts.processor.process(makeJob());
    const checksUpdate = parts.octokit.rest.checks.update as unknown as jest.Mock;
    // No sweep PATCH (no prior leaked run) — so the ONLY checks.update is
    // the terminal Step 13c success PATCH against this review's own
    // in-progress check-run; no neutral "superseded" PATCH fires.
    expect(checksUpdate).toHaveBeenCalledTimes(1);
    expect(checksUpdate.mock.calls[0][0].conclusion).toBe('success');
    expect(checksUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'neutral' }),
    );
  });
});

describe('ReviewsProcessor.process — in-progress surfaces (Step 7/8)', () => {
  it('posts an in-progress check-run on the review path and persists its id', async () => {
    const parts = makeProcessor();

    await parts.processor.process(makeJob());

    const checksCreate = parts.octokit.rest.checks.create as unknown as jest.Mock;
    expect(checksCreate).toHaveBeenCalledTimes(1);
    expect(checksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: baseData.owner,
        repo: baseData.repo,
        name: 'AI PR Review Copilot',
        head_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        status: 'in_progress',
      }),
    );
    // The returned check_run_id (stub resolves { data: { id: 1 } }) is
    // persisted on the reserved row.
    const reservedId = parts.insertInProgress.mock.calls[0][0].id;
    const setCheckRunId = parts.reviewsRepo.setCheckRunId as unknown as jest.Mock;
    expect(setCheckRunId).toHaveBeenCalledTimes(1);
    expect(setCheckRunId).toHaveBeenCalledWith(reservedId, 1);
  });

  it('posts the in-progress walkthrough on a first review (no existing comment)', async () => {
    const parts = makeProcessor();

    await parts.processor.process(makeJob());

    // Cold cache → Step 8 createComment carries the in-progress body.
    const createComment = parts.octokit.rest.issues.createComment as unknown as jest.Mock;
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0][0].body).toContain('mode=in-progress');
    // Terminal walkthrough PATCHes the same comment with the result body
    // (warm cache → updateComment), carrying the review-id marker.
    const updateComment = parts.octokit.rest.issues.updateComment as unknown as jest.Mock;
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment.mock.calls[0][0].body).toContain(
      'ai-pr-review-copilot:v1:review-id=',
    );
    expect(updateComment.mock.calls[0][0].body).not.toContain('mode=in-progress');
  });

  it('does NOT repost in-progress on a re-review (walkthrough already exists)', async () => {
    // Seed the stateful cache with an existing comment id from the
    // start — models a PR whose first review already posted a
    // walkthrough. Step 8 must short-circuit to 'skipped' and never
    // flip the existing comment back to "in progress".
    const parts = makeProcessor({ walkthroughCachedId: 999 });

    await parts.processor.process(makeJob());

    // No in-progress (or any) createComment — the existing walkthrough
    // is left in place.
    expect(parts.octokit.rest.issues.createComment).not.toHaveBeenCalled();
    // The only walkthrough write is the terminal PATCH against the
    // existing comment (id 999) carrying the result body.
    const updateComment = parts.octokit.rest.issues.updateComment as unknown as jest.Mock;
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment.mock.calls[0][0].comment_id).toBe(999);
    expect(updateComment.mock.calls[0][0].body).toContain(
      'ai-pr-review-copilot:v1:review-id=',
    );
    expect(updateComment.mock.calls[0][0].body).not.toContain('mode=in-progress');
  });

  it('renders the missing-Checks-permission note when the installation lacks Checks permission', async () => {
    const parts = makeProcessor();
    // Flip the permission OFF before process() runs. Step 7 short-
    // circuits (no checks.create / no setCheckRunId) and Step 8's
    // in-progress body carries the missing-permission note.
    (parts.authProvider.hasChecksPermission as jest.Mock).mockReturnValue(false);

    await parts.processor.process(makeJob());

    // No check-run posted and no id persisted.
    expect(parts.octokit.rest.checks.create as unknown as jest.Mock).not.toHaveBeenCalled();
    expect(parts.reviewsRepo.setCheckRunId as unknown as jest.Mock).not.toHaveBeenCalled();
    // The in-progress walkthrough body carries the unavailable-badge note.
    const createComment = parts.octokit.rest.issues.createComment as unknown as jest.Mock;
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0][0].body).toContain(
      'merge-box status badge is unavailable',
    );
  });

  it('review path posts the in-progress check-run + walkthrough only AFTER the size checks pass, then runs the review', async () => {
    const callOrder: string[] = [];
    const octokit = makeOctokit();
    (octokit.rest.checks.create as unknown as jest.Mock).mockImplementation(
      async (args: { status?: string }) => {
        callOrder.push(`checks.create:${args.status}`);
        return { data: { id: 1 } };
      },
    );
    (octokit.rest.issues.createComment as unknown as jest.Mock).mockImplementation(
      async () => {
        callOrder.push('createComment');
        return { data: { id: 1 } };
      },
    );
    const parts = makeProcessor({ octokit });
    parts.runRealReview.mockImplementation(async (input: { reviewId?: string }) => {
      callOrder.push('runRealReview');
      return happyServiceResult(input.reviewId);
    });

    await parts.processor.process(makeJob());

    // The normal diff passes the size checks, so the in-progress check-run
    // (status in_progress) and the in-progress walkthrough fire, and BOTH
    // precede the agent loop.
    expect(callOrder).toEqual([
      'checks.create:in_progress',
      'createComment',
      'runRealReview',
    ]);
    // The single in-progress check-run carries status in_progress (the
    // terminal/skipped POST helper is never used on the review path).
    const checksCreate = octokit.rest.checks.create as unknown as jest.Mock;
    expect(checksCreate).toHaveBeenCalledTimes(1);
    expect(checksCreate.mock.calls[0][0].status).toBe('in_progress');
    expect(checksCreate.mock.calls[0][0].conclusion).toBeUndefined();
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
        hallucinated_finding_count: 0,
        cache_hit_count: 0,
        check_run_id: null,
        walkthrough_summary: null,
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
      // The reserved row is finalized in place — no separate standalone
      // insert; the reservation happened up front via insertInProgress.
      expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
      expect(parts.insert).not.toHaveBeenCalled();
      const reservedId = parts.insertInProgress.mock.calls[0][0].id;
      // Retrieval metadata reconciled to the standalone-failure marker.
      expect(parts.updateRetrievalMetadata).toHaveBeenCalledTimes(1);
      const [retrievalId, retrievalPatch] =
        parts.updateRetrievalMetadata.mock.calls[0];
      expect(retrievalId).toBe(reservedId);
      expect(retrievalPatch.prompt_version).toBe('standalone-failure');
      expect(retrievalPatch.diff_length).toBe(0);
      // markFailed carries the diff_too_large code with a zero status.
      expect(parts.markFailed).toHaveBeenCalledTimes(1);
      const [failedId, failedPatch] = parts.markFailed.mock.calls[0];
      expect(failedId).toBe(reservedId);
      expect(failedPatch.error_code).toBe('diff_too_large');
      expect(failedPatch.error_status).toBe(0);
      // No in-progress surfaces ran: the only check-run write is the
      // terminal skipped POST (status completed); checks.update untouched.
      const checksCreate = parts.octokit.rest.checks.create as unknown as jest.Mock;
      expect(checksCreate).toHaveBeenCalledTimes(1);
      expect(checksCreate.mock.calls[0][0].status).toBe('completed');
      expect(checksCreate.mock.calls[0][0].conclusion).toBe('skipped');
      expect(parts.octokit.rest.checks.update as unknown as jest.Mock).not.toHaveBeenCalled();
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

    it('posts skip-walkthrough + finalizes the reserved row as standalone-skipped + does NOT call runRealReview when changed lines > cap', async () => {
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
        // The size check now precedes any in-progress surface, so NO
        // in-progress walkthrough was posted. The size-skip body lands
        // directly on the FIRST createComment (cold cache).
        expect(parts.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        const skipArgs = (parts.octokit.rest.issues.createComment as unknown as jest.Mock).mock.calls[0][0];
        expect(skipArgs.body).not.toContain('mode=in-progress');
        expect(skipArgs.body).toContain('review skipped');
        expect(parts.octokit.rest.issues.updateComment).not.toHaveBeenCalled();
        // A terminal skipped check-run was posted (no in-progress one).
        const checksCreate = parts.octokit.rest.checks.create as unknown as jest.Mock;
        expect(checksCreate).toHaveBeenCalledTimes(1);
        expect(checksCreate.mock.calls[0][0]).toEqual(
          expect.objectContaining({
            status: 'completed',
            conclusion: 'skipped',
          }),
        );
        expect(checksCreate.mock.calls[0][0].output.title).toBe(
          'Review skipped — diff exceeds size limit',
        );
        // The reserved row was finalized in place — no separate insert.
        expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
        expect(parts.insert).not.toHaveBeenCalled();
        expect(parts.markCompleted).toHaveBeenCalledTimes(1);
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

        // No in-progress surface preceded the skip now, so the size-skip
        // body lands on the FIRST createComment (cold cache).
        const skipArgs = (parts.octokit.rest.issues.createComment as unknown as jest.Mock).mock.calls[0][0];
        // 5 changed lines (3 added + 2 removed), cap of 2.
        expect(skipArgs.body).toContain('5 changed lines');
        expect(skipArgs.body).toContain('limit of **2**');
      });
    });

    it('finalizes a completed standalone-skipped-too-large row carrying the diff_length', async () => {
      await withSizeCap('2', async () => {
        const parts = makeProcessor({
          octokit: makeOctokit({
            request: jest.fn().mockResolvedValue({ data: FIVE_LINE_DIFF }),
          }),
        });

        await parts.processor.process(makeJob());

        // Reservation up front; no standalone insert.
        expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
        expect(parts.insert).not.toHaveBeenCalled();
        const reservedId = parts.insertInProgress.mock.calls[0][0].id;
        // Retrieval reconciled with the size-skip marker and the
        // diff_length carried through (matches the old standalone row).
        expect(parts.updateRetrievalMetadata).toHaveBeenCalledTimes(1);
        const [retrievalId, retrievalPatch] =
          parts.updateRetrievalMetadata.mock.calls[0];
        expect(retrievalId).toBe(reservedId);
        expect(retrievalPatch.prompt_version).toBe(
          'standalone-skipped-too-large',
        );
        expect(retrievalPatch.diff_length).toBe(
          Buffer.byteLength(FIVE_LINE_DIFF, 'utf8'),
        );
        expect(retrievalPatch.top_k).toBe(0);
        // Finalized completed with zero tokens; not failed.
        expect(parts.markCompleted).toHaveBeenCalledTimes(1);
        const [completedId, completedPatch] =
          parts.markCompleted.mock.calls[0];
        expect(completedId).toBe(reservedId);
        expect(completedPatch.input_tokens).toBe(0);
        expect(completedPatch.output_tokens).toBe(0);
        expect(parts.markFailed).not.toHaveBeenCalled();
      });
    });

    it('still finalizes the standalone-skipped row when the walkthrough POST fails (best-effort)', async () => {
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
        // The audit row landed despite the comment failure — reconciled
        // to the size-skip marker and marked completed.
        expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
        expect(parts.insert).not.toHaveBeenCalled();
        expect(parts.updateRetrievalMetadata.mock.calls[0][1].prompt_version).toBe(
          'standalone-skipped-too-large',
        );
        expect(parts.markCompleted).toHaveBeenCalledTimes(1);
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

  it('exits clean on empty diff without calling Anthropic or posting a Review, and finalizes a standalone completion row', async () => {
    const parts = makeProcessor({
      octokit: makeOctokit({
        request: jest.fn().mockResolvedValue({ data: '   \n  ' }),
      }),
    });

    await parts.processor.process(makeJob());
    expect(parts.runRealReview).not.toHaveBeenCalled();
    expect(parts.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    // The empty-diff check now precedes any in-progress surface. There is
    // NO in-progress walkthrough; instead the empty-diff branch posts a
    // dedicated honest "no diff" walkthrough directly (cold cache →
    // createComment, mode=empty-diff) and a terminal skipped check-run.
    // The empty body must NOT claim retrieval ran or that a Review was
    // posted (no "rules retrieved", no "See the review below").
    expect(parts.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const emptyBody = (parts.octokit.rest.issues.createComment as unknown as jest.Mock)
      .mock.calls[0][0].body;
    expect(emptyBody).toContain('mode=empty-diff');
    expect(emptyBody).toContain('no reviewable diff content');
    expect(emptyBody).not.toContain('mode=success');
    expect(emptyBody).not.toContain('rules retrieved');
    expect(emptyBody).not.toContain('See the review below');
    expect(emptyBody).not.toContain('mode=in-progress');
    // No PATCH fired — the success body was the first write.
    expect(parts.octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    // Terminal skipped check-run posted, no in-progress one.
    const checksCreate = parts.octokit.rest.checks.create as unknown as jest.Mock;
    expect(checksCreate).toHaveBeenCalledTimes(1);
    expect(checksCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ status: 'completed', conclusion: 'skipped' }),
    );
    expect(checksCreate.mock.calls[0][0].output.title).toBe('No diff to review');
    // The reserved row is reconciled to the dedicated empty-diff marker
    // and marked completed — no separate standalone insert.
    expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
    expect(parts.insert).not.toHaveBeenCalled();
    const reservedId = parts.insertInProgress.mock.calls[0][0].id;
    // The terminal check-run id (stub resolves { data: { id: 1 } }) is
    // persisted on the reserved row so the next sweep can retire it.
    const setCheckRunId = parts.reviewsRepo.setCheckRunId as unknown as jest.Mock;
    expect(setCheckRunId).toHaveBeenCalledWith(reservedId, 1);
    expect(parts.updateRetrievalMetadata).toHaveBeenCalledTimes(1);
    const [retrievalId, retrievalPatch] =
      parts.updateRetrievalMetadata.mock.calls[0];
    expect(retrievalId).toBe(reservedId);
    expect(retrievalPatch.prompt_version).toBe('standalone-empty-diff');
    expect(retrievalPatch.diff_length).toBe(0);
    expect(parts.markCompleted).toHaveBeenCalledTimes(1);
    expect(parts.markCompleted.mock.calls[0][0]).toBe(reservedId);
    expect(parts.markFailed).not.toHaveBeenCalled();
  });

  it('empty diff posts a "no diff" walkthrough and a skipped check-run, no in-progress surfaces', async () => {
    const parts = makeProcessor({
      octokit: makeOctokit({
        request: jest.fn().mockResolvedValue({ data: '' }),
      }),
    });

    await parts.processor.process(makeJob());

    // Honest empty-diff walkthrough body (first review → createComment).
    const createComment = parts.octokit.rest.issues.createComment as unknown as jest.Mock;
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0][0].body).toContain('mode=empty-diff');
    expect(createComment.mock.calls[0][0].body).toContain(
      'no reviewable diff content',
    );
    expect(createComment.mock.calls[0][0].body).not.toContain('mode=success');
    expect(createComment.mock.calls[0][0].body).not.toContain('rules retrieved');
    expect(createComment.mock.calls[0][0].body).not.toContain(
      'See the review below',
    );
    // No in-progress walkthrough was ever posted.
    for (const call of createComment.mock.calls) {
      expect(call[0].body).not.toContain('mode=in-progress');
    }
    // Skipped (empty-diff) check-run; never an in-progress one.
    const checksCreate = parts.octokit.rest.checks.create as unknown as jest.Mock;
    expect(checksCreate).toHaveBeenCalledTimes(1);
    expect(checksCreate.mock.calls[0][0].conclusion).toBe('skipped');
    expect(checksCreate.mock.calls[0][0].status).toBe('completed');
    for (const call of checksCreate.mock.calls) {
      expect(call[0].status).not.toBe('in_progress');
    }
  });

  it('empty-diff RE-REVIEW PATCHes the existing walkthrough in place (no duplicate)', async () => {
    // Seed the stateful cache with an existing comment id from the
    // start — models a PR whose first review already posted a
    // walkthrough, now re-reviewed against an empty diff. The empty-diff
    // path must PATCH the existing comment (no createComment duplicate).
    const parts = makeProcessor({
      walkthroughCachedId: 999,
      octokit: makeOctokit({
        request: jest.fn().mockResolvedValue({ data: '' }),
      }),
    });

    await parts.processor.process(makeJob());

    // No duplicate comment — the existing walkthrough is updated in place.
    expect(parts.octokit.rest.issues.createComment).not.toHaveBeenCalled();
    const updateComment = parts.octokit.rest.issues.updateComment as unknown as jest.Mock;
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment.mock.calls[0][0].comment_id).toBe(999);
    expect(updateComment.mock.calls[0][0].body).toContain('mode=empty-diff');
    expect(updateComment.mock.calls[0][0].body).toContain(
      'no reviewable diff content',
    );
    expect(updateComment.mock.calls[0][0].body).not.toContain('mode=success');
  });
});

describe('ReviewsProcessor.process — row reservation invariant', () => {
  // Read the processor's private in-flight set so tests can prove the
  // reserved id is added once and cleaned up on every exit path. The
  // SIGTERM drain reads this same set, so an empty set after process()
  // returns means no leaked reservation.
  function inFlightIds(processor: ReviewsProcessor): string[] {
    return Array.from(
      (processor as unknown as { activeReviewIds: Set<string> })
        .activeReviewIds,
    );
  }

  it('reserves the row once via insertInProgress AFTER pulls.get and BEFORE the diff fetch', async () => {
    const callOrder: string[] = [];
    const prsGet = jest.fn().mockImplementation(async () => {
      callOrder.push('pulls.get');
      return { data: { state: 'open' } };
    });
    const request = jest.fn().mockImplementation(async () => {
      callOrder.push('diff.fetch');
      return { data: 'diff --git a/x b/x\n+hi\n' };
    });
    const parts = makeProcessor({
      octokit: makeOctokit({ prsGet, request }),
    });
    parts.insertInProgress.mockImplementation(() => {
      callOrder.push('insertInProgress');
    });

    await parts.processor.process(makeJob());

    // Reserved exactly once with the worker-allocated id + active model.
    expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
    const reserveArgs = parts.insertInProgress.mock.calls[0][0];
    expect(typeof reserveArgs.id).toBe('string');
    expect(reserveArgs.pr_node_id).toBe(baseData.pr_node_id);
    expect(reserveArgs.model).toBe('claude-haiku-4-5-20251001');
    // Ordering: pulls.get → insertInProgress → diff.fetch.
    expect(callOrder).toEqual(['pulls.get', 'insertInProgress', 'diff.fetch']);
  });

  it('does NOT reserve a row when the in-flight guard short-circuits', async () => {
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
        hallucinated_finding_count: 0,
        cache_hit_count: 0,
        check_run_id: null,
        walkthrough_summary: null,
        created_at: new Date(),
        completed_at: null,
      },
    });

    await parts.processor.process(makeJob());
    expect(parts.insertInProgress).not.toHaveBeenCalled();
  });

  it('does NOT reserve a row before pulls.get confirms the PR is open (closed-PR path keeps the standalone insert)', async () => {
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet: jest.fn().mockResolvedValue({ data: { state: 'closed' } }),
      }),
    });

    await parts.processor.process(makeJob());
    // The reservation happens only after the open check; a closed PR
    // still uses the standalone insert (no reserved row exists).
    expect(parts.insertInProgress).not.toHaveBeenCalled();
    expect(parts.insert).toHaveBeenCalledTimes(1);
  });

  it('cleans up the reserved id on the happy path', async () => {
    const parts = makeProcessor();
    await parts.processor.process(makeJob());
    expect(inFlightIds(parts.processor)).toEqual([]);
  });

  it('cleans up the reserved id on an early-return path (empty diff)', async () => {
    const parts = makeProcessor({
      octokit: makeOctokit({
        request: jest.fn().mockResolvedValue({ data: '   \n  ' }),
      }),
    });
    await parts.processor.process(makeJob());
    // Reserved, then the outer finally removed it — no leak.
    expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
    expect(inFlightIds(parts.processor)).toEqual([]);
  });

  it('cleans up the reserved id on a throw path (runRealReview rejects)', async () => {
    const parts = makeProcessor({
      runRealReviewError: new Error('boom'),
    });
    await expect(parts.processor.process(makeJob())).rejects.toThrow(/boom/);
    // The single outer finally fires on the throw — no leaked reservation.
    expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
    expect(inFlightIds(parts.processor)).toEqual([]);
  });
});

describe('ReviewsProcessor.process — Review POST failure', () => {
  it('marks failed/inline_post_failed and throws UnrecoverableError when createReview throws', async () => {
    const err: Error & { status?: number } = new Error('Bad Gateway');
    err.status = 502;
    const parts = makeProcessor({
      octokit: makeOctokit({
        createReview: jest.fn().mockRejectedValue(err),
      }),
    });

    // POST failures are terminal — a retry would rerun the agent
    // loop AND POST again (3× duplicate Reviews + 3× Anthropic
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
  // Pull LlmRequestError from the real impl — the spec only
  // cares about errorCode/retryAfterMs surface shapes.
  const {
    LlmRequestError,
  } = jest.requireActual('@/infrastructure/llm');

  it('wraps credit_balance_too_low in UnrecoverableError (terminal — no retry)', async () => {
    const err = new LlmRequestError('credit too low', {
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
    const err = new LlmRequestError('bad request', {
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
    const err = new LlmRequestError('rate limited', {
      status: 429,
      errorCode: 'rate_limit_error',
      retryAfterMs: 5000,
    });
    const parts = makeProcessor({ runRealReviewError: err });
    const { UnrecoverableError } = jest.requireActual('bullmq');
    // Should be the original LlmRequestError, NOT UnrecoverableError.
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      LlmRequestError,
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
    // The worker pre-allocates the review_id and passes it into
    // runRealReview. A drift between what we passed in and what came
    // back signals an internal-logic bug; we fail terminally
    // (UnrecoverableError — no retry) and mark the row
    // failed/internal_error.
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
      markChecksPermissionMissing: jest.fn(),
      hasChecksPermission: jest.fn().mockReturnValue(true),
    };
    const markRowsFailedByIdSet = jest.fn();
    const reviewsService = {
      runRealReview: jest.fn(),
      markRowsFailedByIdSet,
    } as unknown as ReviewsService;

    const reviewsRepo: IReviewRepository = {
      insert: jest.fn(),
      insertInProgress: jest.fn(),
      updateRetrievalMetadata: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn().mockReturnValue([]),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
      markFailedIfInProgress: jest.fn().mockReturnValue(1),
      sweepStaleInProgress: jest.fn().mockReturnValue(0),
      findRecentInProgressForPr: jest.fn(),
      findMostRecentPriorCheckRun: jest.fn().mockReturnValue(undefined),
      findFiltered: jest.fn().mockReturnValue([]),
      countFiltered: jest.fn().mockReturnValue(0),
      findByIdWithFindings: jest.fn().mockReturnValue(null),
      aggregateByFilter: jest.fn().mockReturnValue({
        statusBreakdown: { completed: 0, failed: 0, in_progress: 0 },
        severityRollup: { error: 0, warning: 0, info: 0 },
        topRules: [],
        tokenTotals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        latency: { p50: null, p95: null },
        skippedCount: 0,
      }),
      distinctRepos: jest.fn().mockReturnValue([]),
      distinctAuthors: jest.fn().mockReturnValue([]),
      setCheckRunId: jest.fn(),
      setWalkthroughSummary: jest.fn(),
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
    const summarizer: IWalkthroughSummarizer = {
      summarize: jest.fn().mockResolvedValue(null),
    };
    const config = new ConfigService();
    const processor = new TestProcessor(
      authProvider,
      reviewsService,
      reviewsRepo,
      findingsRepo,
      pullRequestsRepo,
      config,
      summarizer,
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
      // Default SHUTDOWN_DRAIN_TIMEOUT_MS is 15_000 (see
      // ConfigService) since jest.setup.ts doesn't override it.
      expect(drainSpy).toHaveBeenCalledWith(15_000);
    } finally {
      drainSpy.mockRestore();
    }
  });
});

describe('ReviewsProcessor.process — failure walkthrough', () => {
  // Helper: extract the mode=failed walkthrough body from BOTH
  // createComment and updateComment calls. A failed-walkthrough body
  // can land on either surface depending on whether an in-progress
  // walkthrough already exists when the failure fires:
  //   - Terminal-without-review and pre-Step-8 failures (pulls.get,
  //     diff-fetch, diff_too_large) run BEFORE any in-progress comment
  //     exists → createComment.
  //   - Agent-loop failures run AFTER Step 8 created+cached the
  //     in-progress comment → updateComment (PATCH in place).
  function failedWalkthroughBodies(parts: ProcessorParts): string[] {
    const createCalls = (
      parts.octokit.rest.issues.createComment as unknown as jest.Mock
    ).mock.calls;
    const updateCalls = (
      parts.octokit.rest.issues.updateComment as unknown as jest.Mock
    ).mock.calls;
    return [...createCalls, ...updateCalls]
      .map((c) => c[0]?.body as string | undefined)
      .filter((b): b is string => typeof b === 'string')
      .filter((b) => b.includes('<!-- ai-pr-review-copilot:v1:mode=failed -->'));
  }

  it('posts a "review could not complete" walkthrough on a retryable pulls.get failure (github_api_error)', async () => {
    const err: Error & { status?: number } = new Error('Bad Gateway');
    err.status = 502;
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet: jest.fn().mockRejectedValue(err),
      }),
    });

    await expect(parts.processor.process(makeJob())).rejects.toThrow(/Bad Gateway/);

    const bodies = failedWalkthroughBodies(parts);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('<!-- ai-pr-review-copilot:v1:mode=failed -->');
    expect(bodies[0].toLowerCase()).toContain('github');
  });

  it('posts a "review could not complete" walkthrough on a retryable diff-fetch failure (github_api_error)', async () => {
    const err: Error & { status?: number } = new Error('Bad Gateway');
    err.status = 502;
    const parts = makeProcessor({
      octokit: makeOctokit({
        request: jest.fn().mockRejectedValue(err),
      }),
    });

    await expect(parts.processor.process(makeJob())).rejects.toThrow(/Bad Gateway/);

    const bodies = failedWalkthroughBodies(parts);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].toLowerCase()).toContain('github');

    // Reserved row was created before the diff fetch.
    expect(parts.insertInProgress).toHaveBeenCalledTimes(1);
    const reservedId = parts.insertInProgress.mock.calls[0][0].id;
    // No separate standalone insert — the reserved row is finalized in place.
    expect(parts.insert).not.toHaveBeenCalled();
    // Retrieval metadata reconciled to standalone-failure with diff_length 0.
    expect(parts.updateRetrievalMetadata).toHaveBeenCalledTimes(1);
    const [retrievalId, retrievalPatch] = parts.updateRetrievalMetadata.mock.calls[0];
    expect(retrievalId).toBe(reservedId);
    expect(retrievalPatch).toEqual(
      expect.objectContaining({ prompt_version: 'standalone-failure', diff_length: 0 }),
    );
    // markFailed called with github_api_error and the diff-fetch HTTP status.
    expect(parts.markFailed).toHaveBeenCalledTimes(1);
    const [failedId, failedPatch] = parts.markFailed.mock.calls[0];
    expect(failedId).toBe(reservedId);
    expect(failedPatch).toEqual(
      expect.objectContaining({ error_code: 'github_api_error', error_status: 502 }),
    );
  });

  it('posts a "review could not complete" walkthrough on diff_too_large (diff_too_large reason)', async () => {
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

      const bodies = failedWalkthroughBodies(parts);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].toLowerCase()).toMatch(/diff|cap/);
      // A terminal skipped check-run is posted directly (no in-progress
      // surface ran on this exit).
      const checksCreate = parts.octokit.rest.checks.create as unknown as jest.Mock;
      expect(checksCreate).toHaveBeenCalledTimes(1);
      expect(checksCreate.mock.calls[0][0]).toEqual(
        expect.objectContaining({ status: 'completed', conclusion: 'skipped' }),
      );
      expect(checksCreate.mock.calls[0][0].output.title).toBe(
        'Review could not complete',
      );
    } finally {
      if (prevCap === undefined) delete process.env.MAX_DIFF_BYTES;
      else process.env.MAX_DIFF_BYTES = prevCap;
    }
  });

  it('posts a "review could not complete" walkthrough with anthropic_error reason on a terminal Anthropic error', async () => {
    const {
      LlmRequestError,
    } = jest.requireActual('@/infrastructure/llm');
    const err = new LlmRequestError('credit too low', {
      status: 400,
      errorCode: 'credit_balance_too_low',
    });
    const parts = makeProcessor({ runRealReviewError: err });

    const { UnrecoverableError } = jest.requireActual('bullmq');
    await expect(parts.processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const bodies = failedWalkthroughBodies(parts);
    expect(bodies).toHaveLength(1);
    // Anthropic reason copy says the model call was rejected — does NOT
    // expose the raw error code.
    expect(bodies[0].toLowerCase()).toMatch(/language-model|model|account|configuration/);
    expect(bodies[0]).not.toContain('credit_balance_too_low');
    // The Step 7 in-progress check-run is PATCHed to skipped.
    const checksUpdate = parts.octokit.rest.checks.update as unknown as jest.Mock;
    expect(checksUpdate).toHaveBeenCalledTimes(1);
    expect(checksUpdate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ status: 'completed', conclusion: 'skipped' }),
    );
    expect(checksUpdate.mock.calls[0][0].output.title).toBe(
      'Review could not complete',
    );
  });

  it('posts a "review could not complete" walkthrough with internal_error reason on a non-Anthropic mid-loop error', async () => {
    const parts = makeProcessor({
      runRealReviewError: new Error('boom'),
    });

    await expect(parts.processor.process(makeJob())).rejects.toThrow(/boom/);

    const bodies = failedWalkthroughBodies(parts);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].toLowerCase()).toContain('internal');
    // The Step 7 in-progress check-run is PATCHed to skipped.
    const checksUpdate = parts.octokit.rest.checks.update as unknown as jest.Mock;
    expect(checksUpdate).toHaveBeenCalledTimes(1);
    expect(checksUpdate.mock.calls[0][0].conclusion).toBe('skipped');
    expect(checksUpdate.mock.calls[0][0].output.title).toBe(
      'Review could not complete',
    );
  });

  it('does NOT post a "review could not complete" walkthrough when the PR is closed (state !== open)', async () => {
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet: jest
          .fn()
          .mockResolvedValue({ data: { state: 'closed' } }),
      }),
    });

    await parts.processor.process(makeJob());

    expect(failedWalkthroughBodies(parts)).toHaveLength(0);
  });

  it('does NOT post a "review could not complete" walkthrough on a terminal pulls.get 404', async () => {
    const err: Error & { status?: number } = new Error('Not Found');
    err.status = 404;
    const parts = makeProcessor({
      octokit: makeOctokit({
        prsGet: jest.fn().mockRejectedValue(err),
      }),
    });

    await expect(parts.processor.process(makeJob())).rejects.toThrow(/Not Found/);
    expect(failedWalkthroughBodies(parts)).toHaveLength(0);
  });

  it('does not propagate failed-walkthrough POST errors — the job still throws the original error', async () => {
    const upstream: Error & { status?: number } = new Error('Bad Gateway');
    upstream.status = 502;
    const commentErr: Error & { status?: number } = new Error(
      'createComment rate-limited',
    );
    commentErr.status = 403;

    const octokit = makeOctokit({
      prsGet: jest.fn().mockRejectedValue(upstream),
    });
    (octokit.rest.issues.createComment as unknown as jest.Mock).mockRejectedValue(
      commentErr,
    );
    const parts = makeProcessor({ octokit });

    // The original 502 propagates — the comment-POST failure was
    // swallowed (best-effort).
    await expect(parts.processor.process(makeJob())).rejects.toThrow(/Bad Gateway/);
    // The audit row still landed.
    expect(parts.insert).toHaveBeenCalledTimes(1);
    expect(parts.insert.mock.calls[0][0].error_code).toBe('github_api_error');
  });
});

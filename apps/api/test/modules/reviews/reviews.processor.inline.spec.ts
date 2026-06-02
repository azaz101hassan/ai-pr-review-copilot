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

const VALID_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,5 @@',
  ' const x = 1;',
  '+const y = 2;',
  '+const z = 3;',
  ' export { x };',
].join('\n');

function fmtFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    rule_id: 'rule.test',
    severity: 'warning' as const,
    title: 'A finding',
    message: 'An explanation.',
    location_hint: 'src/foo.ts:2',
    citation: 'const y = 2;',
    created_at: new Date(),
    ...overrides,
  };
}

interface StubOctokitParts {
  prsGet: jest.Mock;
  request: jest.Mock;
  createReview: jest.Mock;
  createComment: jest.Mock;
  updateComment: jest.Mock;
  listComments: jest.Mock;
}

function makeOctokit(parts: Partial<StubOctokitParts> = {}): {
  octokit: Octokit;
  parts: StubOctokitParts;
} {
  const full: StubOctokitParts = {
    prsGet:
      parts.prsGet ??
      jest.fn().mockResolvedValue({ data: { state: 'open' } }),
    request:
      parts.request ??
      jest.fn().mockResolvedValue({ data: VALID_DIFF }),
    createReview:
      parts.createReview ??
      jest
        .fn()
        .mockResolvedValue({ data: { html_url: 'https://example.test/r/1' } }),
    createComment:
      parts.createComment ??
      jest.fn().mockResolvedValue({ data: { id: 555 } }),
    updateComment:
      parts.updateComment ?? jest.fn().mockResolvedValue({ data: {} }),
    listComments:
      parts.listComments ?? jest.fn().mockResolvedValue({ data: [] }),
  };
  return {
    octokit: {
      rest: {
        pulls: {
          get: full.prsGet,
          createReview: full.createReview,
        },
        issues: {
          createComment: full.createComment,
          updateComment: full.updateComment,
          listComments: full.listComments,
        },
      },
      request: full.request,
    } as unknown as Octokit,
    parts: full,
  };
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

function happyServiceResult(reviewId: string | undefined, findings: unknown[]) {
  return {
    review_id: reviewId ?? '01234567-89ab-4cde-8fed-cba987654321',
    status: 'completed' as const,
    findings,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    model: 'claude-haiku-4-5-20251001',
    prompt_version: 'v3',
    turn_count: 1,
    tool_calls: [],
  };
}

interface SetupOpts {
  octokitParts?: Partial<StubOctokitParts>;
  walkthroughCachedId?: number | null;
  findings?: unknown[];
}

function setup(opts: SetupOpts = {}) {
  const { octokit, parts } = makeOctokit(opts.octokitParts);

  const authProvider: IGithubAuthProvider = {
    forInstallation: jest.fn().mockReturnValue(octokit),
    invalidateInstallation: jest.fn(),
  };

  const runRealReview = jest.fn().mockImplementation(async (input: {
    reviewId?: string;
  }) =>
    happyServiceResult(input.reviewId, opts.findings ?? [fmtFinding()]),
  );

  const reviewsService = {
    runRealReview,
  } as unknown as ReviewsService;

  const reviewsRepo: IReviewRepository = {
    insert: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn().mockReturnValue([]),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
    markFailedIfInProgress: jest.fn().mockReturnValue(1),
    sweepStaleInProgress: jest.fn().mockReturnValue(0),
    findRecentInProgressForPr: jest.fn().mockReturnValue(undefined),
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

  const getWalkthroughCommentId = jest
    .fn()
    .mockReturnValue(opts.walkthroughCachedId ?? null);
  const setWalkthroughCommentId = jest.fn();
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
  );

  return {
    processor,
    octokit,
    parts,
    runRealReview,
    getWalkthroughCommentId,
    setWalkthroughCommentId,
    pullRequestsRepo,
    reviewsRepo,
  };
}

describe('ReviewsProcessor inline-comment flow', () => {
  describe('first run (no cached walkthrough)', () => {
    it('posts the walkthrough, then the inlined review with comments[]', async () => {
      const s = setup({ walkthroughCachedId: null });
      await s.processor.process(makeJob());

      // 1. Walkthrough scan happens first.
      expect(s.parts.listComments).toHaveBeenCalledTimes(1);
      // 2. Walkthrough POST fires (nothing matched the marker).
      expect(s.parts.createComment).toHaveBeenCalledTimes(1);
      const walkthroughArgs = s.parts.createComment.mock.calls[0][0];
      expect(walkthroughArgs.issue_number).toBe(7);
      expect(walkthroughArgs.body).toMatch(
        /^<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_node_test -->/,
      );
      // 3. The comment id is cached.
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        555,
      );
      // 4. Inlined Review POST fires with comments[].
      expect(s.parts.createReview).toHaveBeenCalledTimes(1);
      const reviewArgs = s.parts.createReview.mock.calls[0][0];
      expect(reviewArgs.event).toBe('COMMENT');
      expect(reviewArgs.commit_id).toBeUndefined();
      expect(reviewArgs.body).toContain('ai-pr-review-copilot:v1:review-id=');
      expect(reviewArgs.comments).toHaveLength(1);
      expect(reviewArgs.comments[0]).toEqual(
        expect.objectContaining({
          path: 'src/foo.ts',
          line: 2,
          side: 'RIGHT',
        }),
      );
      expect(reviewArgs.request).toEqual({ retries: 0 });
    });
  });

  describe('second run (cached walkthrough)', () => {
    it('PATCHes the walkthrough in place, does not POST a new one', async () => {
      const s = setup({ walkthroughCachedId: 999 });
      await s.processor.process(makeJob());

      // listComments scan is skipped when the cache hits.
      expect(s.parts.listComments).not.toHaveBeenCalled();
      // createComment is NOT called.
      expect(s.parts.createComment).not.toHaveBeenCalled();
      // updateComment IS called.
      expect(s.parts.updateComment).toHaveBeenCalledTimes(1);
      expect(s.parts.updateComment.mock.calls[0][0]).toEqual(
        expect.objectContaining({ comment_id: 999 }),
      );
      // setWalkthroughCommentId is not called on the cached path
      // (id is already correct).
      expect(s.setWalkthroughCommentId).not.toHaveBeenCalled();
      // Inlined Review still posts.
      expect(s.parts.createReview).toHaveBeenCalledTimes(1);
    });
  });

  describe('zero findings', () => {
    it('PATCHes the walkthrough only and skips the inlined Review POST', async () => {
      const s = setup({ walkthroughCachedId: 999, findings: [] });
      await s.processor.process(makeJob());

      expect(s.parts.updateComment).toHaveBeenCalledTimes(1);
      expect(s.parts.createReview).not.toHaveBeenCalled();
    });
  });

  describe('walkthrough POST/PATCH failure paths', () => {
    it('PATCH 404 → clears cache and falls through to scan/POST', async () => {
      const update404 = jest
        .fn()
        .mockRejectedValueOnce({ status: 404, message: 'Not Found' });
      const scanned = jest.fn().mockResolvedValue({ data: [] }); // empty scan
      const created = jest.fn().mockResolvedValue({ data: { id: 777 } });

      const s = setup({
        walkthroughCachedId: 999,
        octokitParts: {
          updateComment: update404,
          listComments: scanned,
          createComment: created,
        },
      });
      await s.processor.process(makeJob());

      expect(update404).toHaveBeenCalledTimes(1);
      expect(scanned).toHaveBeenCalledTimes(1);
      expect(created).toHaveBeenCalledTimes(1);
      // Cache cleared then set to the new id.
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        null,
      );
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        777,
      );
    });

    it('empty cache + scan finds existing comment → PATCH (adopt) instead of POST', async () => {
      const scanned = jest.fn().mockResolvedValue({
        data: [
          {
            id: 333,
            body:
              '<!-- ai-pr-review-copilot:walkthrough:v1:pr=PR_node_test -->\n...',
          },
        ],
      });
      const update = jest.fn().mockResolvedValue({ data: {} });
      const created = jest.fn();

      const s = setup({
        walkthroughCachedId: null,
        octokitParts: {
          listComments: scanned,
          updateComment: update,
          createComment: created,
        },
      });
      await s.processor.process(makeJob());

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 333 }),
      );
      expect(created).not.toHaveBeenCalled();
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        333,
      );
    });

    it('walkthrough POST 502 → retried once, then succeeds', async () => {
      const create502 = jest
        .fn()
        .mockRejectedValueOnce({ status: 502, message: 'Bad Gateway' })
        .mockResolvedValueOnce({ data: { id: 888 } });

      const s = setup({
        walkthroughCachedId: null,
        octokitParts: { createComment: create502 },
      });
      await s.processor.process(makeJob());

      expect(create502).toHaveBeenCalledTimes(2);
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        888,
      );
      expect(s.parts.createReview).toHaveBeenCalledTimes(1);
    });

    it('scan 502 → retried once, then succeeds', async () => {
      // After cache miss, the marker scan can transiently 502. The
      // worker retries the scan once before falling through to POST,
      // so a flaky list-comments call doesn't sink the upsert.
      const listComments = jest
        .fn()
        .mockRejectedValueOnce({ status: 502, message: 'Bad Gateway' })
        .mockResolvedValueOnce({ data: [] });
      const created = jest.fn().mockResolvedValue({ data: { id: 444 } });

      const s = setup({
        walkthroughCachedId: null,
        octokitParts: { listComments, createComment: created },
      });
      await s.processor.process(makeJob());

      expect(listComments).toHaveBeenCalledTimes(2);
      expect(created).toHaveBeenCalledTimes(1);
      expect(s.setWalkthroughCommentId).toHaveBeenCalledWith(
        'PR_node_test',
        444,
      );
    });

    it('walkthrough POST fails twice → review row marked comment_post_failed', async () => {
      const create502 = jest
        .fn()
        .mockRejectedValue({ status: 502, message: 'Bad Gateway' });

      const s = setup({
        walkthroughCachedId: null,
        octokitParts: { createComment: create502 },
      });

      await expect(s.processor.process(makeJob())).rejects.toBeDefined();

      expect(create502).toHaveBeenCalledTimes(2);
      // Inlined Review POST is NOT attempted when the Walkthrough
      // ultimately fails.
      expect(s.parts.createReview).not.toHaveBeenCalled();
      expect(s.reviewsRepo.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error_code: 'comment_post_failed',
          error_status: 502,
        }),
      );
    });
  });

  describe('inlined Review POST failure paths', () => {
    it('createReview 422 → review row marked inline_post_failed, walkthrough already up', async () => {
      const create422 = jest
        .fn()
        .mockRejectedValue({ status: 422, message: 'Unprocessable' });

      // Make the PR-state recheck return 'open' so the 422 is NOT
      // reclassified as pr_closed_during_review.
      const prsGet = jest
        .fn()
        .mockResolvedValueOnce({ data: { state: 'open' } }) // step 4
        .mockResolvedValueOnce({ data: { state: 'open' } }); // F5 recheck

      const s = setup({
        walkthroughCachedId: 999,
        octokitParts: { createReview: create422, prsGet },
      });

      await expect(s.processor.process(makeJob())).rejects.toBeDefined();

      // Walkthrough patched first.
      expect(s.parts.updateComment).toHaveBeenCalledTimes(1);
      // Inline POST attempted exactly once (retries: 0).
      expect(create422).toHaveBeenCalledTimes(1);
      // Row marked with the new error_code.
      expect(s.reviewsRepo.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error_code: 'inline_post_failed',
          error_status: 422,
        }),
      );
    });

    it('createReview 422 → PR closed mid-flight reclassifies as pr_closed_during_review', async () => {
      const create422 = jest
        .fn()
        .mockRejectedValue({ status: 422, message: 'Unprocessable' });
      const prsGet = jest
        .fn()
        .mockResolvedValueOnce({ data: { state: 'open' } })
        .mockResolvedValueOnce({ data: { state: 'closed' } });

      const s = setup({
        walkthroughCachedId: 999,
        octokitParts: { createReview: create422, prsGet },
      });

      await expect(s.processor.process(makeJob())).rejects.toBeDefined();
      expect(s.reviewsRepo.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error_code: 'pr_closed_during_review',
        }),
      );
    });
  });
});

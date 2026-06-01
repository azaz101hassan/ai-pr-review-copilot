import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import {
  ConfigService,
  parseWorkerConcurrency,
} from '@/config';
import { AnthropicRequestError } from '@/infrastructure/anthropic';
import { GitHubRepoContextProvider } from '@/infrastructure/github/github-repo-context.provider';
import { formatBriefError, readStatus } from '@/types';
import {
  anchorFindingsToDiff,
  findWalkthroughCommentId,
  formatInlineCommentBody,
  formatReviewBody,
  formatWalkthroughBody,
  parseDiffHunks,
  FindingWithSeverity,
} from './helpers';
import {
  IPullRequestRepository,
  PULL_REQUEST_REPOSITORY,
} from '@/modules/webhooks/types/pull-request.repository';
import type { Octokit } from 'octokit';
import { RunDryRunResult, ReviewsService } from './reviews.service';
import {
  GITHUB_AUTH_PROVIDER,
  IGithubAuthProvider,
} from './types/github-auth-provider';
import {
  IReviewFindingRepository,
  REVIEW_FINDING_REPOSITORY,
} from './types/review-finding.repository';
import {
  IReviewRepository,
  REVIEW_REPOSITORY,
} from './types/review.repository';
import {
  REVIEW_QUEUE_NAME,
  ReviewJobData,
} from './types/review-queue';

// Day-5 BullMQ worker. One Processor instance per app boot — consumes
// jobs off the `reviews` queue. The class extends WorkerHost (the
// modern @nestjs/bullmq@11 contract; @Process() decorators were
// deprecated in this major version).
//
// process() lifecycle (in order):
//   1. Read job.data once at entry (AE2 — never re-read mid-job).
//   2. Per-PR guard via findRecentInProgressForPr — if a recent
//      in_progress row exists, exit clean. Defends against BullMQ
//      stalled-job replay racing the deterministic-jobId upsert.
//   3. Mint installation-scoped Octokit from the cached provider.
//   4. pulls.get → if state !== 'open' or 404, mark failed and exit.
//   5. Fetch unified diff via mediaType.format='diff'.
//   6. Pre-check: empty diff → mark completed with zero findings,
//      do not call Anthropic, do not POST. MAX_DIFF_BYTES overflow
//      → mark failed/diff_too_large, exit clean.
//   7. Construct GitHubRepoContextProvider (per-job).
//   8. Call reviewsService.runRealReview — runs the agent loop,
//      persists the row and findings.
//   9. Sanitize each finding's title/message; format the body with
//      the self-identifying header + UUID-validated marker.
//   10. POST octokit.rest.pulls.createReview (event=COMMENT,
//       commit_id OMITTED so GitHub defaults to PR's current branch
//       tip — eliminates stale-head-SHA window). retries: 0.
//   11. On failure during steps 3-10: classifyError → markFailed
//       with the right error_code; re-throw so BullMQ schedules a
//       retry per the queue's attempts budget.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Guard lookback window — the per-PR row-in-progress guard rejects
// jobs that arrived while a prior attempt is still running. We use
// the worst-case loop budget + a small grace so a healthy long-loop
// review doesn't get bumped by a BullMQ retry.
const GUARD_LOOKBACK_MS = 10 * 60_000;

// Worker concurrency is read from env at decoration time via the
// parseWorkerConcurrency helper. Decorators evaluate at class-
// definition (BEFORE Nest constructs any provider), so a ConfigService
// instance isn't available — the parse helper mirrors the pattern
// `parseEnableDryRun` / `parseBooleanFlag` use elsewhere. Operator
// dial: WORKER_CONCURRENCY=<positive int>; default 1.
//
// `settings.backoffStrategy` is the F4 closure — pairs with
// QueueModule's `backoff: { type: 'custom' }` defaultJobOptions.
// Returns Anthropic's retry-after-ms when present; falls back to
// 1s/2s/4s exponential otherwise.
@Processor(REVIEW_QUEUE_NAME, {
  concurrency: parseWorkerConcurrency(process.env.WORKER_CONCURRENCY, 1),
  settings: {
    backoffStrategy: reviewBackoffStrategy,
  },
})
@Injectable()
export class ReviewsProcessor
  extends WorkerHost
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(ReviewsProcessor.name);

  // Set of review_ids currently in-flight (added on row insert,
  // removed in finally). The shutdown drain reads this set to mark
  // any still-running rows failed/process_terminated when the
  // bounded drain times out.
  private readonly activeReviewIds = new Set<string>();

  constructor(
    @Inject(GITHUB_AUTH_PROVIDER)
    private readonly githubAuth: IGithubAuthProvider,
    private readonly reviewsService: ReviewsService,
    @Inject(REVIEW_REPOSITORY)
    private readonly reviewsRepo: IReviewRepository,
    @Inject(REVIEW_FINDING_REPOSITORY)
    private readonly findingsRepo: IReviewFindingRepository,
    @Inject(PULL_REQUEST_REPOSITORY)
    private readonly pullRequestsRepo: IPullRequestRepository,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<ReviewJobData>): Promise<void> {
    const data = job.data;
    const jobLogPrefix = `[job=${job.id} pr=${data.pr_node_id}]`;
    this.logger.log(
      `${jobLogPrefix} worker.job.dequeued head_sha=${data.head_sha}`,
    );

    // Step 2 — per-PR guard. Skip if a recent in_progress row exists.
    const inFlight = this.reviewsRepo.findRecentInProgressForPr(
      data.pr_node_id,
      GUARD_LOOKBACK_MS,
    );
    if (inFlight) {
      this.logger.warn(
        `${jobLogPrefix} worker.job.skipped guard review_id=${inFlight.id} (already in_progress) — clean exit, no retry`,
      );
      return;
    }

    // Step 3 — installation-scoped Octokit (cached).
    const octokit = this.githubAuth.forInstallation(data.installation_id);

    // Step 4 — pulls.get to confirm the PR is still open.
    let prState: 'open' | 'closed' | string;
    try {
      const pr = await octokit.rest.pulls.get({
        owner: data.owner,
        repo: data.repo,
        pull_number: data.pr_number,
      });
      prState = (pr.data as { state?: string }).state ?? 'unknown';
    } catch (err) {
      // 404 → the PR was deleted (rare — typically the repo was deleted or
      // transferred); treat as terminal-not-found so retries don't burn.
      // Other statuses → generic github_api_error.
      const status = readStatus(err);
      const errorCode =
        status === 404 ? 'pr_closed_during_review' : 'github_api_error';
      await this.writeStandaloneFailure(data, errorCode, status);
      this.logger.warn(
        `${jobLogPrefix} worker.job.failed pulls.get status=${status} error_code=${errorCode}`,
      );
      // F12 closure: 401 means the cached Octokit's installation
      // token is now invalid (App uninstalled, PEM rotated). Drop
      // the cache entry so the next forInstallation call mints fresh.
      if (status === 401) {
        this.githubAuth.invalidateInstallation(data.installation_id);
      }
      // 401 / 404 / 410 are terminal — no point retrying. 401
      // would require an operator-side rotation; 404/410 are gone.
      if (status === 401 || status === 404 || status === 410) {
        throw new UnrecoverableError(formatBriefError(err));
      }
      throw classifyToRequestError(err);
    }

    if (prState !== 'open') {
      await this.writeStandaloneFailure(
        data,
        'pr_closed_during_review',
        0,
      );
      this.logger.log(
        `${jobLogPrefix} worker.job.skipped pr_state=${prState}`,
      );
      return;
    }

    // Step 5 — unified diff via mediaType.
    let diff: string;
    try {
      const res = await octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner: data.owner,
          repo: data.repo,
          pull_number: data.pr_number,
          mediaType: { format: 'diff' },
        },
      );
      diff = String(res.data ?? '');
    } catch (err) {
      const status = readStatus(err);
      await this.writeStandaloneFailure(data, 'github_api_error', status);
      if (status === 401) {
        this.githubAuth.invalidateInstallation(data.installation_id);
        throw new UnrecoverableError(formatBriefError(err));
      }
      throw classifyToRequestError(err);
    }

    // Step 6a — MAX_DIFF_BYTES.
    const diffBytes = Buffer.byteLength(diff, 'utf8');
    if (diffBytes > this.config.maxDiffBytes) {
      await this.writeStandaloneFailure(data, 'diff_too_large', 0);
      this.logger.warn(
        `${jobLogPrefix} worker.job.failed diff_too_large bytes=${diffBytes} cap=${this.config.maxDiffBytes}`,
      );
      return;
    }

    // Step 6b — empty diff. Mark completed cleanly without calling
    // Anthropic and without POSTing. Day-5 plan: "mark completed
    // cleanly". A standalone-completion row with zero findings keeps
    // the audit trail honest (Day-6 eval sees the attempt + zero
    // findings, rather than the operator wondering why a delivery
    // vanished). Mirrors writeStandaloneFailure for symmetry.
    if (diff.trim().length === 0) {
      this.writeStandaloneCompletion(data);
      this.logger.log(`${jobLogPrefix} worker.review.empty diff was empty`);
      return;
    }

    // Step 7 — per-job context provider.
    const repoContext = new GitHubRepoContextProvider({
      octokit,
      owner: data.owner,
      repo: data.repo,
      head_sha: data.head_sha,
      pr_node_id: data.pr_node_id,
      priorReviewRepo: this.findingsRepo,
    });

    // F2 closure: pre-allocate the review_id at the worker so the
    // activeReviewIds tracking Set is consistent with row existence
    // for the entire lifecycle (add BEFORE runRealReview persists
    // the row, delete in finally). The previous code added to the
    // Set AFTER runRealReview returned — a SIGTERM inside the agent
    // loop would then miss the row entirely from the drain's
    // perspective. The pre-allocated UUID is passed through
    // runRealReview into runDryRun's insert (validated as canonical
    // UUID by the service).
    const reviewId = randomUUID();
    this.activeReviewIds.add(reviewId);

    let result: RunDryRunResult;
    try {
      this.logger.log(
        `${jobLogPrefix} worker.review.started review_id=${reviewId}`,
      );
      result = await this.reviewsService.runRealReview({
        diff,
        prNodeId: data.pr_node_id,
        headSha: data.head_sha,
        repoContext,
        reviewId,
      });
    } catch (err) {
      // runRealReview already wrote a failed row internally.
      this.activeReviewIds.delete(reviewId);
      this.logger.warn(
        `${jobLogPrefix} worker.review.failed ${formatBriefError(err)}`,
      );
      // F4 closure: terminal Anthropic errors (credit_balance_too_low,
      // invalid_request_error, etc.) must not retry — a retry of the
      // same agent loop would produce the same failure AND burn
      // another $X of Anthropic credit. Wrap in UnrecoverableError so
      // BullMQ skips remaining attempts.
      if (isTerminalAnthropicError(err)) {
        throw new UnrecoverableError(formatBriefError(err));
      }
      // Retryable (429, 5xx, transport) — re-throw the original.
      // BullMQ's backoffStrategy reads err.retryAfterMs and honours
      // Anthropic's hint when present.
      throw err;
    }

    try {
      this.logger.log(
        `${jobLogPrefix} worker.review.findings_emitted count=${result.findings.length} review_id=${reviewId}`,
      );

      // UUID defense (unchanged).
      if (result.review_id !== reviewId || !UUID_RE.test(reviewId)) {
        this.logger.error(
          `${jobLogPrefix} worker.review.bad_uuid expected=${reviewId} got=${result.review_id}`,
        );
        this.reviewsRepo.markFailed(reviewId, {
          completed_at: new Date(),
          error_status: null,
          error_code: 'internal_error',
        });
        throw new UnrecoverableError(
          'runRealReview review_id did not match worker-allocated id',
        );
      }

      // Step 9 — parse and partition (pure, deterministic, no I/O).
      const sanitizedFindings: FindingWithSeverity[] = result.findings.map(
        (f) => ({
          rule_id: f.rule_id,
          title: f.title,
          message: f.message,
          location_hint: f.location_hint,
          citation: f.citation,
          severity: f.severity,
        }),
      );

      const diffHunks = parseDiffHunks(diff);
      const partition = anchorFindingsToDiff({
        findings: sanitizedFindings,
        diffHunks,
      });
      const counts = countBySeverity(sanitizedFindings);
      const hasOutsideDiff = partition.outsideDiff.length > 0;

      // Step 10a — upsert the Walkthrough.
      const walkthroughBody = formatWalkthroughBody({
        prNodeId: data.pr_node_id,
        reviewId,
        counts,
        outsideDiff: partition.outsideDiff,
      });

      const walkthroughPosted = await this.upsertWalkthrough({
        octokit,
        owner: data.owner,
        repo: data.repo,
        pr_number: data.pr_number,
        pr_node_id: data.pr_node_id,
        body: walkthroughBody,
      });

      // Step 10b — POST the inlined Review (skip on zero findings).
      let inlinePosted = false;
      if (sanitizedFindings.length > 0) {
        const reviewBody = formatReviewBody({
          reviewId,
          counts,
          hasOutsideDiff,
        });

        const inlineComments = partition.anchorable.map((a) => ({
          path: a.path,
          line: a.line,
          side: 'RIGHT' as const,
          ...(a.startLine !== null && a.startLine !== a.line
            ? { start_line: a.startLine, start_side: 'RIGHT' as const }
            : {}),
          body: formatInlineCommentBody({ finding: a.finding }),
        }));

        type CreateReviewParams = Parameters<
          typeof octokit.rest.pulls.createReview
        >[0];
        const createReviewArgs: CreateReviewParams & {
          request?: { retries?: number };
        } = {
          owner: data.owner,
          repo: data.repo,
          pull_number: data.pr_number,
          event: 'COMMENT',
          body: reviewBody,
          comments: inlineComments,
          request: { retries: 0 },
        };

        const posted = await octokit.rest.pulls.createReview(createReviewArgs);
        const url =
          (posted.data as { html_url?: string } | undefined)?.html_url ??
          '(no URL)';
        this.logger.log(
          `${jobLogPrefix} worker.review.posted url=${url} review_id=${reviewId}`,
        );
        inlinePosted = true;
      }

      this.logger.log(
        `${jobLogPrefix} worker.review.post_summary ` +
          `walkthrough.posted=${walkthroughPosted} ` +
          `inline_review.posted=${inlinePosted} ` +
          `anchorable_count=${partition.anchorable.length} ` +
          `outside_diff_count=${partition.outsideDiff.length}`,
      );
    } finally {
      this.activeReviewIds.delete(reviewId);
    }
  }

  // Upsert the Walkthrough issue comment for this PR. On the first
  // run (no cached id and no existing marker in the thread), creates
  // a new comment and caches the id. On subsequent runs, PATCHes the
  // existing comment in-place so the PR thread isn't flooded.
  private async upsertWalkthrough(args: {
    octokit: Octokit;
    owner: string;
    repo: string;
    pr_number: number;
    pr_node_id: string;
    body: string;
  }): Promise<'created' | 'patched'> {
    const { octokit, owner, repo, pr_number, pr_node_id, body } = args;

    const cachedId = this.pullRequestsRepo.getWalkthroughCommentId(pr_node_id);
    if (cachedId !== null) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: cachedId,
        body,
      });
      return 'patched';
    }

    const scanned = await findWalkthroughCommentId(octokit, {
      owner,
      repo,
      pr_number,
      pr_node_id,
    });
    if (scanned !== null) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: scanned,
        body,
      });
      this.pullRequestsRepo.setWalkthroughCommentId(pr_node_id, scanned);
      return 'patched';
    }

    const created = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr_number,
      body,
    });
    const newId = (created.data as { id: number }).id;
    this.pullRequestsRepo.setWalkthroughCommentId(pr_node_id, newId);
    return 'created';
  }

  // Day-5 bounded shutdown drain (U8). On SIGTERM Nest fires
  // onApplicationShutdown across every provider that implements the
  // hook; the processor pauses the BullMQ worker (no new jobs
  // dequeued), waits up to SHUTDOWN_DRAIN_TIMEOUT_MS for active
  // jobs to finish, and on timeout marks any still-in-flight
  // reviews rows failed/process_terminated. The U7 row-in-progress
  // guard is the second-line defense on the next boot when BullMQ
  // re-dispatches stalled jobs — it sees the failed row and exits
  // clean. The 10-minute sweep cutoff is the third line of defense
  // if the drain misses a row entirely (e.g., race between row
  // insert and Set.add).
  async onApplicationShutdown(): Promise<void> {
    await this.drainGracefully(this.config.shutdownDrainTimeoutMs);
  }

  async drainGracefully(timeoutMs: number): Promise<void> {
    const inFlightSnapshot = Array.from(this.activeReviewIds);
    this.logger.log(
      `worker.shutdown.draining in_flight=${inFlightSnapshot.length} timeout_ms=${timeoutMs}`,
    );

    // Pause + close — wraps in try because in test/no-worker mode
    // the `worker` getter throws ("worker not initialized") and we
    // still want the drain timeout / mark-failed bookkeeping to run.
    let closePromise: Promise<void> | undefined;
    try {
      const worker = this.worker;
      await worker.pause();
      closePromise = worker.close(false);
    } catch (err) {
      this.logger.warn(
        `worker.shutdown.no_worker ${formatBriefError(err)} — skipping pause/close`,
      );
    }

    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs).unref(),
    );

    const outcome = closePromise
      ? await Promise.race([
          closePromise.then(() => 'drained' as const),
          timeoutPromise,
        ])
      : 'drained';

    if (outcome === 'drained') {
      this.logger.log('worker.shutdown.drain_complete');
      return;
    }

    // Timed out — mark every still-in-flight review failed.
    const stillRunning = Array.from(this.activeReviewIds);
    this.logger.warn(
      `worker.shutdown.drain_timeout in_flight=${stillRunning.length} — marking failed/process_terminated`,
    );
    if (stillRunning.length > 0) {
      this.reviewsService.markRowsFailedByIdSet(
        stillRunning,
        'process_terminated',
      );
    }

    // Force-close the worker if the close handle existed.
    try {
      const worker = this.worker;
      await worker.close(true);
    } catch (err) {
      this.logger.warn(
        `worker.shutdown.force_close_failed ${formatBriefError(err)}`,
      );
    }
  }

  // Standalone completion path — empty diff. Mirrors
  // writeStandaloneFailure: inserts a one-shot completed row with
  // zero findings (`top_k=0`, empty retrieved_chunk_ids) so the
  // audit trail records the attempt. No Anthropic call ran; no POST.
  // Day-6 eval can filter by `prompt_version='standalone-empty-diff'`
  // to exclude these from quality metrics.
  private writeStandaloneCompletion(data: ReviewJobData): void {
    const id = randomUUID();
    const now = new Date();
    try {
      this.reviewsRepo.insert({
        id,
        pr_node_id: data.pr_node_id,
        created_by: null,
        diff_length: 0,
        model: this.config.anthropicModel,
        prompt_version: 'standalone-empty-diff',
        top_k: 0,
        retrieved_chunk_ids: '[]',
        retrieved_chunk_ids_hash: '0'.repeat(64),
        status: 'completed',
        error_status: null,
        error_code: null,
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        created_at: now,
        completed_at: now,
      });
    } catch (writeErr) {
      this.logger.error(
        `failed to persist standalone completion row for pr=${data.pr_node_id} — ${formatBriefError(writeErr)}`,
      );
    }
  }

  // Standalone failure path — runs when the worker fails BEFORE
  // entering runRealReview (so no review row exists yet). We insert
  // a one-shot failed row so the Day-6 eval harness sees the
  // attempt and its error_code, rather than the operator wondering
  // why a webhook delivery vanished.
  private async writeStandaloneFailure(
    data: ReviewJobData,
    errorCode: string,
    errorStatus: number,
  ): Promise<void> {
    const id = randomUUID();
    const now = new Date();
    try {
      this.reviewsRepo.insert({
        id,
        pr_node_id: data.pr_node_id,
        created_by: null,
        diff_length: 0,
        model: this.config.anthropicModel,
        prompt_version: 'standalone-failure',
        top_k: 0,
        retrieved_chunk_ids: '[]',
        retrieved_chunk_ids_hash: '0'.repeat(64),
        status: 'failed',
        error_status: errorStatus,
        error_code: errorCode,
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        created_at: now,
        completed_at: now,
      });
    } catch (writeErr) {
      this.logger.error(
        `failed to persist standalone failure row for pr=${data.pr_node_id} — ${formatBriefError(writeErr)}`,
      );
    }
  }
}

function classifyToRequestError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function countBySeverity(findings: { severity: 'error' | 'warning' | 'info' }[]) {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === 'error') error += 1;
    else if (f.severity === 'warning') warning += 1;
    else info += 1;
  }
  return { error, warning, info, total: error + warning + info };
}

// F4 closure. Terminal Anthropic error codes — codes for which a
// retry would be guaranteed to fail (the same way) or unsafe (cost
// alert). When the agent loop emits any of these via
// AnthropicRequestError, the worker wraps it in UnrecoverableError
// so BullMQ skips the remaining attempts.
const TERMINAL_ANTHROPIC_CODES = new Set([
  'credit_balance_too_low',
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  // Day-4 internal terminal codes — re-emitting the loop would
  // produce the same outcome.
  'turn_cap_exceeded',
  'malformed_emit_finding',
  'unexpected_response_shape',
]);

// F4 closure. Returns true when the AnthropicRequestError is one we
// should not retry. Anthropic 429s, 5xx, and transport errors fall
// through to the BullMQ retry path with the custom backoff (see
// reviewBackoffStrategy).
export function isTerminalAnthropicError(err: unknown): boolean {
  if (!(err instanceof AnthropicRequestError)) return false;
  return Boolean(err.errorCode && TERMINAL_ANTHROPIC_CODES.has(err.errorCode));
}

// F4 closure — paired with QueueModule's `backoff: { type: 'custom' }`.
// Honour Anthropic's retry-after when the failure carries it; fall
// back to 1s/2s/4s exponential. Clamps the upstream hint to a 60s
// ceiling so a hostile or malformed header can't park a job for an
// hour. Exported for test visibility.
export function reviewBackoffStrategy(
  attemptsMade: number,
  _type: string,
  err: Error | undefined,
): number {
  const retryAfterMs = (err as { retryAfterMs?: number } | undefined)
    ?.retryAfterMs;
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 60_000);
  }
  // attemptsMade is the count of FAILED tries so far (1 on the
  // first retry decision). 1s, 2s, 4s.
  const exp = 1000 * Math.pow(2, Math.max(0, attemptsMade - 1));
  return Math.min(exp, 60_000);
}

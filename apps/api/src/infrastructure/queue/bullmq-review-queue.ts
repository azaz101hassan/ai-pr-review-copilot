import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue, Job } from 'bullmq';
import {
  EnqueueResult,
  IReviewQueue,
  REVIEW_JOB_NAME,
  REVIEW_QUEUE_NAME,
  ReviewJobData,
} from '@/modules/reviews/types/review-queue';
import { formatBriefError } from '@/types';

// Separator between the PR node_id and head_sha in a behind-active
// jobId. BullMQ reserves ':' as its Redis key delimiter and rejects
// any custom job id containing it (Job.validateOptions throws
// "Custom Id cannot contain :"). We use '.', which is absent from both
// GitHub node_ids (base64url: A-Za-z0-9-_) and hex head_shas, so it
// stays an unambiguous separator. The jobId construction and the
// coalesce-sweep prefix MUST use the same value — both read this const.
const BEHIND_ACTIVE_SHA_SEPARATOR = '.';

// BullMQ-backed implementation of IReviewQueue.
//
// Upsert mechanics — deterministic job-id with upsert-on-collision:
//
//   1. jobId = data.pr_node_id (one BullMQ job per PR ever).
//   2. const existing = await queue.getJob(jobId).
//   3. If no existing job → queue.add() with the deterministic jobId
//      → result: 'added'.
//   4. existing.getState() → 'waiting' | 'delayed' →
//      existing.updateData(data) → result: 'updated-in-place'. The
//      waiting job runs with the fresh payload.
//   5. existing.getState() → 'active' | 'completed' | 'failed' |
//      'unknown' → queue.add() with `${jobId}.${head_sha}` so the
//      new job queues BEHIND the running one (never cancel
//      running). result: 'enqueued-behind-active'. (Separator is
//      '.', not ':' — BullMQ forbids ':' in custom job ids; see
//      BEHIND_ACTIVE_SHA_SEPARATOR.)
//
// Known race window: between `getState` returning 'waiting' and
// `updateData` resolving, the worker may dequeue the job and start
// processing — the new payload is then lost (`updateData` succeeds
// but the worker reads the prior copy from `job.data` cached at
// dispatch). The processor's per-PR row-in-progress guard is the
// second line of defense. A future move to BullMQ's
// `deduplication: { keepLastIfActive }` Lua-script primitive could
// close the race once that API is stable.
//
// Default retry: BullMQ's `attempts: 3` with exponential backoff.
// Tunable via the queue registration in QueueModule; the operator
// dials it down on installs where Anthropic burn is a concern.
@Injectable()
export class BullMQReviewQueue implements IReviewQueue {
  private readonly logger = new Logger(BullMQReviewQueue.name);

  constructor(
    @InjectQueue(REVIEW_QUEUE_NAME)
    private readonly queue: Queue<ReviewJobData>,
  ) {}

  async enqueueReview(data: ReviewJobData): Promise<EnqueueResult> {
    const jobId = data.pr_node_id;

    const existing = await this.queue.getJob(jobId);
    if (!existing) {
      await this.queue.add(REVIEW_JOB_NAME, data, { jobId });
      this.logger.log(
        `enqueue: added jobId=${jobId} head_sha=${data.head_sha}`,
      );
      return { jobId, result: 'added' };
    }

    const state = await this.safeGetState(existing);

    if (state === 'waiting' || state === 'delayed') {
      await existing.updateData(data);
      this.logger.log(
        `enqueue: updated-in-place jobId=${jobId} state=${state} head_sha=${data.head_sha}`,
      );
      return { jobId, result: 'updated-in-place' };
    }

    // ACTIVE | COMPLETED | FAILED | UNKNOWN — never replace; queue a
    // fresh job suffixed with the head_sha so it lands behind the
    // running one. Two concurrent re-pushes against the same head_sha
    // produce the same suffix; BullMQ's per-jobId uniqueness then
    // de-duplicates the second add automatically (the second call's
    // jobId collision is a no-op; we re-check by getJob and surface
    // as 'updated-in-place').
    const newJobId = `${jobId}${BEHIND_ACTIVE_SHA_SEPARATOR}${data.head_sha}`;

    // Coalesce rebase-fixup spam: every waiting behind-active job
    // for this PR with a DIFFERENT head_sha is stale (the author
    // just kept pushing). Remove them so only the most-recent
    // waiting job survives → 10 force-pushes don't queue 10 reviews
    // and burn 10× Anthropic spend.
    await this.coalesceWaitingBehindActive(jobId, newJobId);

    const existingByNewId = await this.queue.getJob(newJobId);
    if (existingByNewId) {
      const newState = await this.safeGetState(existingByNewId);
      if (newState === 'waiting' || newState === 'delayed') {
        await existingByNewId.updateData(data);
        this.logger.log(
          `enqueue: updated-in-place jobId=${newJobId} (queued behind active) state=${newState}`,
        );
        return { jobId: newJobId, result: 'updated-in-place' };
      }
      // Edge: the rebuild collision is itself completed/failed.
      // Surface as 'enqueued-behind-active' for telemetry symmetry —
      // the queue still has at most one waiting job per (PR, sha).
      return { jobId: newJobId, result: 'enqueued-behind-active' };
    }

    await this.queue.add(REVIEW_JOB_NAME, data, { jobId: newJobId });
    this.logger.log(
      `enqueue: enqueued-behind-active jobId=${newJobId} prior_state=${state}`,
    );
    return { jobId: newJobId, result: 'enqueued-behind-active' };
  }

  // Sweep waiting / delayed jobs whose jobId starts with
  // `${baseJobId}.` (the behind-active suffix pattern) and remove
  // all of them EXCEPT `keepJobId`. The base waiting job
  // (jobId === baseJobId) is left alone — its updateData path is
  // the primary short-circuit and never duplicates Anthropic spend.
  //
  // We use Queue.getJobs with the 'waiting' + 'delayed' filters
  // and walk the result. Iteration cost is O(waiting jobs in
  // queue); the test corpus is small and production volumes are
  // bounded by webhook arrival rate.
  private async coalesceWaitingBehindActive(
    baseJobId: string,
    keepJobId: string,
  ): Promise<void> {
    const prefix = `${baseJobId}${BEHIND_ACTIVE_SHA_SEPARATOR}`;
    let stale: Array<Job> = [];
    try {
      // BullMQ's getJobs takes a types filter + range; default range
      // is 0..-1 (all). We grab waiting + delayed which is where
      // behind-active jobs live until they dequeue.
      const candidates = await this.queue.getJobs(
        ['waiting', 'delayed'] as never,
        0,
        -1,
      );
      stale = candidates.filter(
        (j) =>
          typeof j.id === 'string' &&
          j.id.startsWith(prefix) &&
          j.id !== keepJobId,
      );
    } catch (err) {
      // getJobs can race with worker dequeue; on transient failure
      // skip coalescing (the worst case is we queue an extra
      // review, which the worker's per-PR in-progress guard will
      // short-circuit anyway).
      this.logger.warn(
        `enqueue.coalesce: getJobs failed for prefix=${prefix} — skipping coalesce. ${formatBriefError(err)}`,
      );
      return;
    }
    for (const job of stale) {
      try {
        await job.remove();
        this.logger.log(
          `enqueue.coalesce: removed stale jobId=${job.id} (superseded by ${keepJobId})`,
        );
      } catch (err) {
        // Job may have just dequeued; tolerate.
        this.logger.warn(
          `enqueue.coalesce: remove failed for jobId=${job.id} — ${formatBriefError(err)}`,
        );
      }
    }
  }

  // BullMQ's Job.getState() can throw if the underlying Lua script
  // races with a job state transition. Treat the failure as 'unknown'
  // so the upsert falls through to the safe 'enqueued-behind-active'
  // branch rather than blowing up the webhook with a 5xx.
  private async safeGetState(job: Job): Promise<string> {
    try {
      return await job.getState();
    } catch (err) {
      this.logger.warn(
        `getState failed for jobId=${job.id} — defaulting to 'unknown'. ${formatBriefError(err)}`,
      );
      return 'unknown';
    }
  }
}


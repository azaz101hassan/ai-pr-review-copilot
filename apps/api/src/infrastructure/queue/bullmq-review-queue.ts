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

// Day-5 BullMQ-backed implementation of IReviewQueue.
//
// Upsert mechanics — hand-rolled per the brainstorm's
// "deterministic BullMQ job-id with upsert-on-collision" wording:
//
//   1. jobId = data.pr_node_id (one BullMQ job per PR ever).
//   2. const existing = await queue.getJob(jobId).
//   3. If no existing job → queue.add() with the deterministic jobId
//      → result: 'added'.
//   4. existing.getState() → 'waiting' | 'delayed' → existing.updateData(data)
//      → result: 'updated-in-place'. The waiting job runs with the
//      fresh payload (R2).
//   5. existing.getState() → 'active' | 'completed' | 'failed' | 'unknown'
//      → queue.add() with `${jobId}:${head_sha}` so the new job queues
//      BEHIND the running one (R3 — never cancel running). result:
//      'enqueued-behind-active'.
//
// Known race window (documented Day-5 trade-off): between `getState`
// returning 'waiting' and `updateData` resolving, the worker may
// dequeue the job and start processing — the new payload is then
// lost (`updateData` succeeds but the worker reads the prior copy
// from `job.data` cached at dispatch). The U7 row-in-progress guard
// is the second line of defense. The Day-8 follow-up is to adopt
// BullMQ's `deduplication: { keepLastIfActive }` Lua-script primitive
// once the dedup API shape has stabilised; rejected at Day 5 because
// the primitives are observable in worker logs (debuggable on demo
// day) and don't churn across minor versions.
//
// Default retry: BullMQ's `attempts: 3` with exponential backoff. The
// retry budget is tunable via the queue registration in QueueModule;
// Day-5 ships the default and lets the operator dial it down on the
// dogfood install if Anthropic burn becomes a concern (see Day-5
// Open Questions about retry × Anthropic spend).
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
    const newJobId = `${jobId}:${data.head_sha}`;

    // F18 closure. Coalesce rebase-fixup spam: every waiting
    // behind-active job for this PR with a DIFFERENT head_sha is
    // stale (the operator just kept pushing). Remove them so only
    // the most-recent waiting job survives → 10 force-pushes don't
    // queue 10 reviews + burn 10× Anthropic spend.
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

  // F18 closure. Sweep waiting / delayed jobs whose jobId starts
  // with `${baseJobId}:` (the behind-active suffix pattern) and
  // remove all of them EXCEPT `keepJobId`. The base waiting job
  // (jobId === baseJobId) is left alone — its updateData path is
  // the primary R2 short-circuit and never duplicates Anthropic
  // spend.
  //
  // We use Queue.getJobs with the 'waiting' + 'delayed' filters
  // and walk the result. Iteration cost is O(waiting jobs in
  // queue); the test corpus is small and production volumes are
  // bounded by webhook arrival rate.
  private async coalesceWaitingBehindActive(
    baseJobId: string,
    keepJobId: string,
  ): Promise<void> {
    const prefix = `${baseJobId}:`;
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


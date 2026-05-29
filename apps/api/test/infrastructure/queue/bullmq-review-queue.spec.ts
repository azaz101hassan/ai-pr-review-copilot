import { BullMQReviewQueue } from '@/infrastructure/queue';
import type { Queue, Job } from 'bullmq';
import type { ReviewJobData } from '@/modules/reviews/types/review-queue';
import {
  REVIEW_JOB_NAME,
  REVIEW_QUEUE_NAME,
} from '@/modules/reviews/types/review-queue';

// Test harness: a minimal in-memory queue stub that records every
// `add` / `getJob` / `updateData` call and lets the test simulate any
// job state. Keeps the upsert logic observable without ioredis-mock
// (which would need a real BullMQ Queue construction, which would
// need a Redis connection in jest's CommonJS runtime).

type JobState =
  | 'waiting'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed'
  | 'unknown';

interface FakeJob {
  id: string;
  data: ReviewJobData;
  state: JobState;
  updateData: jest.Mock;
  getState: jest.Mock;
  // F18 closure: coalesce sweeps stale waiting jobs via job.remove().
  remove: jest.Mock;
}

interface FakeQueueState {
  jobs: Map<string, FakeJob>;
  addCalls: Array<{ name: string; data: ReviewJobData; opts: { jobId?: string } }>;
}

function makeFakeQueue() {
  const state: FakeQueueState = { jobs: new Map(), addCalls: [] };

  const setJob = (id: string, data: ReviewJobData, jobState: JobState) => {
    // Mirror BullMQ's real Job.validateOptions: a custom job id cannot
    // contain ':' (BullMQ's Redis key delimiter) — it throws
    // "Custom Id cannot contain :". The fake queue enforces the same
    // rule so a malformed jobId fails this always-on suite instead of
    // only blowing up against real Redis (which is exactly how the
    // `${node_id}:${head_sha}` behind-active jobId shipped undetected).
    if (id.includes(':')) {
      throw new Error('Custom Id cannot contain :');
    }
    const job: FakeJob = {
      id,
      data: { ...data },
      state: jobState,
      updateData: jest.fn().mockImplementation(async (newData: ReviewJobData) => {
        job.data = { ...newData };
      }),
      getState: jest.fn().mockImplementation(async () => job.state),
      remove: jest.fn().mockImplementation(async () => {
        state.jobs.delete(id);
      }),
    };
    state.jobs.set(id, job);
    return job;
  };

  const queue = {
    getJob: jest.fn(async (id: string) => state.jobs.get(id)),
    add: jest.fn(
      async (name: string, data: ReviewJobData, opts: { jobId?: string }) => {
        state.addCalls.push({ name, data, opts });
        if (opts.jobId) {
          setJob(opts.jobId, data, 'waiting');
        }
      },
    ),
    // F18 closure: the fake queue mirrors BullMQ's getJobs([types]),
    // returning every fake job whose state matches one of `types`.
    getJobs: jest.fn(async (types: JobState[]) => {
      const wanted = new Set(types);
      return Array.from(state.jobs.values()).filter((j) => wanted.has(j.state));
    }),
  } as unknown as Queue<ReviewJobData>;

  return { queue, state, setJob };
}

const baseData: ReviewJobData = {
  pr_node_id: 'PR_kwDOIVj1A85vRcDe',
  owner: 'octocat',
  repo: 'demo',
  pr_number: 42,
  head_sha: 'sha-1111',
  installation_id: 12345,
};

describe('BullMQReviewQueue.enqueueReview', () => {
  it('adds a new job when no prior job exists for the PR', async () => {
    const { queue, state } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    const result = await adapter.enqueueReview(baseData);

    expect(result).toEqual({
      jobId: baseData.pr_node_id,
      result: 'added',
    });
    expect(state.addCalls).toHaveLength(1);
    expect(state.addCalls[0]).toEqual({
      name: REVIEW_JOB_NAME,
      data: baseData,
      opts: { jobId: baseData.pr_node_id },
    });
  });

  it('updates payload in-place when a waiting job exists (R2 / AE2)', async () => {
    const { queue, state, setJob } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    // Pre-seed a waiting job at the deterministic jobId.
    const job = setJob(baseData.pr_node_id, baseData, 'waiting');

    const updated: ReviewJobData = { ...baseData, head_sha: 'sha-2222' };
    const result = await adapter.enqueueReview(updated);

    expect(result).toEqual({
      jobId: baseData.pr_node_id,
      result: 'updated-in-place',
    });
    // No new job was added — only updateData fired on the existing one.
    expect(state.addCalls).toHaveLength(0);
    expect(job.updateData).toHaveBeenCalledTimes(1);
    expect(job.updateData).toHaveBeenCalledWith(updated);
  });

  it('treats delayed jobs identically to waiting (in-place update)', async () => {
    const { queue, setJob } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    const job = setJob(baseData.pr_node_id, baseData, 'delayed');
    const updated: ReviewJobData = { ...baseData, head_sha: 'sha-late' };

    const result = await adapter.enqueueReview(updated);
    expect(result.result).toBe('updated-in-place');
    expect(job.updateData).toHaveBeenCalledWith(updated);
  });

  it('queues a fresh job behind an active one (R3 / AE-Q)', async () => {
    const { queue, state, setJob } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    // Prior job is actively processing — must not be touched.
    const activeJob = setJob(baseData.pr_node_id, baseData, 'active');

    const updated: ReviewJobData = { ...baseData, head_sha: 'sha-newer' };
    const result = await adapter.enqueueReview(updated);

    expect(result).toEqual({
      jobId: `${baseData.pr_node_id}.sha-newer`,
      result: 'enqueued-behind-active',
    });
    expect(state.addCalls).toHaveLength(1);
    expect(state.addCalls[0].opts.jobId).toBe(
      `${baseData.pr_node_id}.sha-newer`,
    );
    // Behind-active jobId must be BullMQ-legal — no ':' delimiter.
    expect(result.jobId).not.toContain(':');
    // The running job's payload is untouched.
    expect(activeJob.updateData).not.toHaveBeenCalled();
  });

  it('handles a third enqueue while an active job and a behind-active waiting job exist', async () => {
    const { queue, state, setJob } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    // active head_sha = sha-1111
    setJob(baseData.pr_node_id, baseData, 'active');
    // waiting head_sha = sha-2222
    const waitingBehind = setJob(
      `${baseData.pr_node_id}.sha-2222`,
      { ...baseData, head_sha: 'sha-2222' },
      'waiting',
    );

    // Third push with NEW head_sha (3333). Suffix collision is unique,
    // so add a brand-new behind-active job with the new sha.
    const third: ReviewJobData = { ...baseData, head_sha: 'sha-3333' };
    const result = await adapter.enqueueReview(third);

    expect(result).toEqual({
      jobId: `${baseData.pr_node_id}.sha-3333`,
      result: 'enqueued-behind-active',
    });
    expect(state.addCalls).toHaveLength(1);
    // The earlier waiting-behind-active job is untouched.
    expect(waitingBehind.updateData).not.toHaveBeenCalled();
  });

  it('updates-in-place when a behind-active job already exists for the same head_sha', async () => {
    const { queue, state, setJob } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    setJob(baseData.pr_node_id, baseData, 'active');
    // Already-queued behind-active job for sha-2222.
    const behind = setJob(
      `${baseData.pr_node_id}.sha-2222`,
      { ...baseData, head_sha: 'sha-2222' },
      'waiting',
    );

    const data: ReviewJobData = { ...baseData, head_sha: 'sha-2222' };
    const result = await adapter.enqueueReview(data);

    expect(result.result).toBe('updated-in-place');
    expect(result.jobId).toBe(`${baseData.pr_node_id}.sha-2222`);
    expect(state.addCalls).toHaveLength(0);
    expect(behind.updateData).toHaveBeenCalledTimes(1);
  });

  it('propagates queue.add errors (R4 / AE4 — webhook returns 5xx)', async () => {
    const { queue } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);
    (queue.add as jest.Mock).mockRejectedValueOnce(
      new Error('ECONNREFUSED: Redis dropped'),
    );

    await expect(adapter.enqueueReview(baseData)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("treats a job's getState() error as 'unknown' and enqueues behind it", async () => {
    const { queue, state, setJob } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    const job = setJob(baseData.pr_node_id, baseData, 'waiting');
    (job.getState as jest.Mock).mockRejectedValueOnce(
      new Error('lua script raced'),
    );

    const result = await adapter.enqueueReview(baseData);
    // Falls through to the 'enqueued-behind-active' branch (safe
    // default) rather than blowing up the webhook with a 5xx.
    expect(result.result).toBe('enqueued-behind-active');
    expect(state.addCalls).toHaveLength(1);
  });

  it('a completed prior job triggers behind-active enqueue (cleanup-not-yet-pruned)', async () => {
    const { queue, state, setJob } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    setJob(baseData.pr_node_id, baseData, 'completed');

    const result = await adapter.enqueueReview(baseData);
    expect(result.result).toBe('enqueued-behind-active');
    expect(state.addCalls).toHaveLength(1);
  });

  it('a failed prior job triggers behind-active enqueue', async () => {
    const { queue, state, setJob } = makeFakeQueue();
    const adapter = new BullMQReviewQueue(queue);

    setJob(baseData.pr_node_id, baseData, 'failed');

    const result = await adapter.enqueueReview(baseData);
    expect(result.result).toBe('enqueued-behind-active');
    expect(state.addCalls).toHaveLength(1);
  });

  // F18 closure. Rebase-fixup spam: an active job + several stale
  // waiting jobs (different head_shas) get pruned to just one
  // waiting job → one extra review, not N.
  describe('F18 head_sha coalescing', () => {
    it('removes stale waiting behind-active jobs from prior head_shas', async () => {
      const { queue, state, setJob } = makeFakeQueue();
      const adapter = new BullMQReviewQueue(queue);

      // Active job on the base PR id.
      setJob(baseData.pr_node_id, baseData, 'active');
      // Three stale waiting jobs from prior pushes.
      const staleA = setJob(
        `${baseData.pr_node_id}.sha-AAA`,
        { ...baseData, head_sha: 'sha-AAA' },
        'waiting',
      );
      const staleB = setJob(
        `${baseData.pr_node_id}.sha-BBB`,
        { ...baseData, head_sha: 'sha-BBB' },
        'waiting',
      );
      const staleC = setJob(
        `${baseData.pr_node_id}.sha-CCC`,
        { ...baseData, head_sha: 'sha-CCC' },
        'waiting',
      );

      const result = await adapter.enqueueReview({
        ...baseData,
        head_sha: 'sha-NEW',
      });

      expect(result.result).toBe('enqueued-behind-active');
      expect(staleA.remove).toHaveBeenCalledTimes(1);
      expect(staleB.remove).toHaveBeenCalledTimes(1);
      expect(staleC.remove).toHaveBeenCalledTimes(1);
      // Only the active job + the newly-added behind-active job remain.
      expect(state.jobs.size).toBe(2);
      expect(state.jobs.has(baseData.pr_node_id)).toBe(true);
      expect(state.jobs.has(`${baseData.pr_node_id}.sha-NEW`)).toBe(true);
    });

    it('does not remove the base waiting job (jobId === pr_node_id)', async () => {
      const { queue, setJob } = makeFakeQueue();
      const adapter = new BullMQReviewQueue(queue);

      // No active job; just a waiting base job (the normal R2 path).
      const base = setJob(baseData.pr_node_id, baseData, 'waiting');

      await adapter.enqueueReview({ ...baseData, head_sha: 'sha-NEW' });

      // R2 path → updateData on the base waiting job, no coalesce.
      expect(base.remove).not.toHaveBeenCalled();
    });

    it('does not touch waiting jobs for OTHER PRs', async () => {
      const { queue, setJob } = makeFakeQueue();
      const adapter = new BullMQReviewQueue(queue);

      setJob(baseData.pr_node_id, baseData, 'active');
      const otherStale = setJob(
        'PR_other.sha-XXX',
        { ...baseData, pr_node_id: 'PR_other', head_sha: 'sha-XXX' },
        'waiting',
      );

      await adapter.enqueueReview({ ...baseData, head_sha: 'sha-NEW' });

      expect(otherStale.remove).not.toHaveBeenCalled();
    });
  });
});

describe('Constants', () => {
  it('exports a stable queue name', () => {
    expect(REVIEW_QUEUE_NAME).toBe('reviews');
  });

  it('exports a stable job name', () => {
    expect(REVIEW_JOB_NAME).toBe('process-review');
  });
});

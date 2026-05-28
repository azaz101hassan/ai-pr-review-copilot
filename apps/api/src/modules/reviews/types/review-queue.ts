// IReviewQueue is the swap seam for the per-PR job queue the webhook
// path enqueues onto and the worker dequeues from. Day-5 ships one
// binding — `BullMQReviewQueue` (Redis-backed) — and the
// IReviewQueue contract stays narrow enough that a future in-memory
// (test fixtures), SQS, or NATS implementation could land later
// without renegotiating consumers.
//
// Constants are exported so callers don't drift on the queue + job
// name. Both BullMQ producers and consumers must agree on these.

export const REVIEW_QUEUE = Symbol('ReviewQueue');

// BullMQ queue name. Used as the Redis key prefix (`bull:reviews:*`).
// Stable across Day-5+ — renaming would orphan in-flight jobs and
// the related telemetry queries in Day-6.
export const REVIEW_QUEUE_NAME = 'reviews';

// BullMQ job name. The `Processor` in U7 registers a single
// `WorkerHost` whose `process()` handles every job on this queue
// regardless of name; the name is still part of the BullMQ telemetry
// surface (visible in worker logs, Bull Board, etc.), so we keep it
// descriptive.
export const REVIEW_JOB_NAME = 'process-review';

// Per-job payload. The worker reads `job.data` once at entry per the
// AE2 contract — never re-read mid-job — so this shape is the
// snapshot of the PR-revision state at enqueue time. Subsequent
// upserts (R2) replace the payload via Job.updateData; the active
// worker keeps reading its dequeued copy.
export interface ReviewJobData {
  pr_node_id: string;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  installation_id: number;
}

// Discriminated outcome of an enqueue attempt. The webhook handler
// surfaces these as log lines (R2/R3) and the existence of this enum
// drives the AE-Q test scenario — same `pr_node_id` arriving twice
// in rapid succession must produce `updated-in-place` when the prior
// job is still waiting, and `enqueued-behind-active` when it's
// already running. Day-5 has no consumer that branches on the result
// beyond logging; future Day-8 observability may emit metrics per
// outcome.
export type EnqueueResultKind =
  | 'added'
  | 'updated-in-place'
  | 'enqueued-behind-active';

export interface EnqueueResult {
  jobId: string;
  result: EnqueueResultKind;
}

export interface IReviewQueue {
  // Deterministic-jobId upsert (R2/R3). Implementation MUST guarantee
  // that two concurrent calls with the same `pr_node_id` never
  // dispatch a duplicate ACTIVE job to two workers — at most one
  // active + at most one waiting, with the waiting slot replaced
  // in-place on subsequent enqueues. The hand-rolled sequence in
  // BullMQReviewQueue closes the common race; a documented narrower
  // race window survives (see U4 source comments).
  enqueueReview(input: ReviewJobData): Promise<EnqueueResult>;
}

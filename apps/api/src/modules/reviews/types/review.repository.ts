import {
  ReviewCompletionPatch,
  ReviewFailurePatch,
  ReviewInsert,
  ReviewRecord,
} from './review.types';

export const REVIEW_REPOSITORY = Symbol('ReviewRepository');

export interface IReviewRepository {
  // Inserts a new review row. The 3-step lifecycle (see ReviewsService)
  // calls this with status='in_progress' BEFORE the Claude call so a
  // process death doesn't leak an unfinalised attempt — the startup
  // sweep then finalises it as 'failed'/'process_terminated'.
  insert(record: ReviewInsert): void;

  findById(id: string): ReviewRecord | undefined;

  // Listing API. Capped at 100 rows by default to keep the response
  // bounded — Day 5/6 paginates properly when a listing UI lands.
  findAll(limit?: number): ReviewRecord[];

  // Flips an `in_progress` row to `completed` with the usage stats. Used
  // inside ReviewsService's transaction so completion + finding inserts
  // commit atomically.
  markCompleted(id: string, patch: ReviewCompletionPatch): void;

  // Flips an `in_progress` row to `failed` with the error fields. Used
  // on the Anthropic-error catch path; no transaction needed because
  // there are no findings to coordinate with. Also used by the
  // comment_post_failed path to flip a 'completed' row to 'failed'
  // when the Review POST didn't land — that's a legitimate
  // completed→failed semantic transition (analysis succeeded, POST
  // did not), which is why this version isn't guarded on status.
  markFailed(id: string, patch: ReviewFailurePatch): void;

  // Day-5 F2 closure. Same as markFailed BUT only fires when the
  // row's status is still 'in_progress'. The SIGTERM drain uses this
  // so a row that finished completing milliseconds before the drain
  // inspected its in-flight Set doesn't get flipped from 'completed'
  // to 'failed'. Returns the number of rows actually updated.
  markFailedIfInProgress(id: string, patch: ReviewFailurePatch): number;

  // Startup sweep. Marks any `in_progress` row whose `created_at` is
  // older than the cutoff as `failed` with the given error_code (e.g.,
  // 'process_terminated'). Returns the number of rows updated.
  sweepStaleInProgress(opts: { olderThanMs: number; errorCode: string }): number;

  // Day-5 worker guard. Returns the most-recent in_progress row for
  // the given pr_node_id whose created_at is within the lookback
  // window, or undefined when no such row exists. ReviewsProcessor
  // (U7) consults this at job entry — when a row is already running
  // for the same PR (BullMQ stalled-job replay; double-delivery
  // race) the processor exits clean rather than starting a parallel
  // Anthropic call.
  findRecentInProgressForPr(
    prNodeId: string,
    withinMs: number,
  ): ReviewRecord | undefined;
}

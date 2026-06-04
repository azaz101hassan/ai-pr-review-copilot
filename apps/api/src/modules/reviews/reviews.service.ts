import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@/config';
import { DatabaseService } from '@/infrastructure/db/database.service';
import { EmbeddingsService, SearchHit } from '@/modules/embeddings/embeddings.service';
import {
  ILlmReviewer,
  LLM_REVIEWER,
  PROMPT_AND_TOOL_VERSION,
  UsageStats,
} from './types/llm-reviewer';
import { IRepoContextProvider } from './types/repo-context-provider';
import { AnthropicRequestError } from '@/infrastructure/anthropic/anthropic-request.error';
import {
  IReviewRepository,
  REVIEW_REPOSITORY,
} from './types/review.repository';
import {
  IReviewFindingRepository,
  REVIEW_FINDING_REPOSITORY,
} from './types/review-finding.repository';
import {
  ReviewFindingInsert,
  ReviewFindingRecord,
} from './types/review-finding.types';
import { ToolCallRecord } from './types/review.types';
import {
  IPullRequestRepository,
  PULL_REQUEST_REPOSITORY,
} from '@/modules/webhooks/types/pull-request.repository';
import { ReviewEventsService, TerminalReviewEvent } from './events/review-events.service';

// ReviewsService orchestrates the review pipeline:
//   embeddings.search() → llm.analyzeDiff() → persist (3-step lifecycle)
//
// The 3-step lifecycle removes the "process died between insert and
// update" failure mode that a 2-state status enum would silently leak.

export interface RunDryRunInput {
  diff: string;
  k?: number;
  prNodeId?: string | null;
  // Per-review repo-context source. CLI builds a
  // `FilesystemRepoContextProvider` against the resolved `--repo`
  // directory; HTTP callers pass nothing and the adapter falls back
  // to truthful `is_error` tool_results (or a NullRepoContextProvider
  // if the controller layer ever wires one).
  repoContext?: IRepoContextProvider;
  // Caller-provided review_id. The BullMQ worker pre-allocates the
  // UUID so it can add to its in-flight tracking Set BEFORE the
  // lifecycle row is inserted — closes the race window between row
  // insert and the activeReviewIds.add() that would otherwise run
  // AFTER runRealReview returned. CLI / HTTP callers don't pass
  // this; runDryRun generates one when absent.
  reviewId?: string;
}

// Sibling entry point for the BullMQ worker. The worker pre-checks
// empty-diff / MAX_DIFF_BYTES and constructs the
// GitHubRepoContextProvider before calling this; runRealReview just
// delegates to the shared lifecycle. `headSha` is captured here so
// future work can persist it on the row without renegotiating the
// input shape — the service doesn't use it directly (the worker
// uses it for the createReview POST).
export interface RunRealReviewInput {
  diff: string;
  prNodeId: string;
  headSha: string;
  repoContext: IRepoContextProvider;
  // Mirrors RunDryRunInput.reviewId. The processor pre-allocates the
  // UUID and adds it to activeReviewIds BEFORE calling runRealReview
  // so the SIGTERM-drain Set is consistent with the row's existence
  // for the entire lifecycle.
  reviewId?: string;
}

export interface RunDryRunResult {
  review_id: string;
  status: 'completed' | 'failed';
  findings: ReviewFindingRecord[];
  usage: UsageStats | null;
  model: string;
  prompt_version: string;
  // Agent-loop aggregates. Always populated on the completed path;
  // `null` only when the review failed BEFORE the first
  // messages.create response returned.
  turn_count: number;
  tool_calls: ToolCallRecord[] | null;
  error_code?: string;
}

export class ReviewsServiceError extends Error {
  readonly name = 'ReviewsServiceError';
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

// Raised from 10 → 20 alongside the corpus expansion (api-conventions
// adds ~30 rules; top-10 was no longer enough to keep specific rules
// in the retrieval set across mixed-domain diffs). Higher K costs more
// input tokens per agent loop; revisit if real-PR cost climbs.
const DEFAULT_K = 20;
// Cutoff used by the startup sweep AND the per-PR worker guard.
// 10 minutes is safely above the worst-case 6-turn agent loop with
// file fetches (~6 minutes wall clock) while still surfacing real
// stalls within an operator's attention window.
const STALE_IN_PROGRESS_CUTOFF_MS = 10 * 60_000;
// Severity values that match the rule corpus's metadata.severity field.
// Sourced from rule metadata at persistence; the adapter never emits
// severity. Exported so SettingsResponseDto can reference them without
// instantiating the service.
export type SeverityLevel = 'error' | 'warning' | 'info';
export const ALLOWED_SEVERITIES: ReadonlySet<SeverityLevel> = new Set<SeverityLevel>([
  'error',
  'warning',
  'info',
]);
export const DEFAULT_SEVERITY: SeverityLevel = 'warning';

@Injectable()
export class ReviewsService implements OnModuleInit {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly embeddings: EmbeddingsService,
    @Inject(LLM_REVIEWER) private readonly llm: ILlmReviewer,
    @Inject(REVIEW_REPOSITORY) private readonly reviews: IReviewRepository,
    @Inject(REVIEW_FINDING_REPOSITORY)
    private readonly findings: IReviewFindingRepository,
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    // In-process event bus for terminal-state SSE events. Injected by
    // class (no token) — ReviewsModule provides and exports it.
    private readonly events: ReviewEventsService,
    // Used to resolve repo_full_name + author_login for the SSE event
    // payload when pr_node_id is non-NULL. DatabaseModule is @Global()
    // so the token is available without re-importing the database
    // module.
    @Inject(PULL_REQUEST_REPOSITORY)
    private readonly pullRequests: IPullRequestRepository,
  ) {}

  // Sweep stale `in_progress` rows once at boot. A row stuck in
  // `in_progress` for > 5 minutes is almost certainly the residue of a
  // process killed between the pre-Claude insert (step 5) and the
  // post-Claude transaction (step 7). Finalising as 'failed' /
  // 'process_terminated' keeps the audit trail honest.
  onModuleInit(): void {
    const swept = this.reviews.sweepStaleInProgress({
      olderThanMs: STALE_IN_PROGRESS_CUTOFF_MS,
      errorCode: 'process_terminated',
    });
    if (swept > 0) {
      this.logger.warn(
        `Startup sweep: finalised ${swept} stale in_progress review(s) as failed/process_terminated`,
      );
    }
  }

  async runDryRun(input: RunDryRunInput): Promise<RunDryRunResult> {
    if (!input.diff || input.diff.length === 0) {
      throw new ReviewsServiceError('diff is empty');
    }

    const k = input.k ?? DEFAULT_K;
    const diffLength = input.diff.length;
    const prNodeId = input.prNodeId ?? null;
    // attempt_id is the handle used in pre-insert log lines so log
    // tracing has *something* to grep on if the row never lands. The
    // review_id is generated separately just below, and is NEVER
    // logged before the row commits — a log line referencing an id
    // that never made it into the DB would mislead an operator
    // chasing a "missing review" report.
    const attemptId = randomUUID();

    this.logger.debug(
      `runDryRun start: attempt=${attemptId} diff_len=${diffLength} k=${k}` +
        `${prNodeId ? ` pr=${prNodeId}` : ''}`,
    );

    const rawHits = await this.embeddings.search(input.diff, { k });

    // Sort hits deterministically by `${source}:${rule_id}` composite
    // before any downstream use. Chroma's similarity-ordered output
    // can shuffle same-score hits between calls — and the user
    // message embeds them in this order, so a tiny reshuffle changes
    // the bytes Anthropic's prompt cache hashes against. Sorting once
    // here makes the user-message segment cacheable on warm calls.
    // The `retrieved_chunk_ids_hash` is unaffected (already
    // sort-stable via hashSortedComposites), and the column we write
    // now reflects what Claude actually saw (sorted), which is also
    // what eval replay needs to reproduce.
    const searchHits = [...rawHits].sort((a, b) =>
      `${a.source}:${a.rule_id}`.localeCompare(`${b.source}:${b.rule_id}`),
    );

    const retrievedChunkIds = searchHits.map((hit) => `${hit.source}:${hit.rule_id}`);
    const retrievedChunkIdsHash = hashSortedComposites(retrievedChunkIds);

    // Generate the review_id just before the insert (and not in a
    // pre-insert log line) — once the row is durably inserted we can
    // log it freely. When the caller pre-allocates a review_id (the
    // BullMQ worker does so it can add to its in-flight tracking Set
    // BEFORE the row insert), use the caller's id and validate it's
    // a UUID — otherwise generate one.
    const reviewId = validateOptionalReviewId(input.reviewId) ?? randomUUID();
    const startedAt = new Date();
    this.reviews.insert({
      id: reviewId,
      pr_node_id: prNodeId,
      created_by: null,
      diff_length: diffLength,
      model: this.config.anthropicModel,
      prompt_version: PROMPT_AND_TOOL_VERSION,
      top_k: k,
      retrieved_chunk_ids: JSON.stringify(retrievedChunkIds),
      retrieved_chunk_ids_hash: retrievedChunkIdsHash,
      status: 'in_progress',
      error_status: null,
      error_code: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      created_at: startedAt,
      completed_at: null,
    });

    let result: Awaited<ReturnType<ILlmReviewer['analyzeDiff']>>;
    try {
      result = await this.llm.analyzeDiff({
        diff: input.diff,
        rules: searchHits.map((hit) => ({
          rule_id: hit.rule_id,
          source: hit.source,
          document: hit.document,
          title: hit.title,
        })),
        repoContext: input.repoContext,
      });
    } catch (err) {
      // Guard the markFailed write so a secondary DB failure (SQLITE_BUSY,
      // disk full, schema corruption) doesn't shadow the original error.
      // The original `err` is what callers need to see; the persistence
      // failure is a secondary concern that we log and move on from. The
      // 5-min in_progress sweep will finalise the row on next boot if
      // markFailed never landed.
      const markFailedSafely = (patch: Parameters<typeof this.reviews.markFailed>[1]): void => {
        try {
          this.reviews.markFailed(reviewId, patch);
        } catch (persistErr) {
          this.logger.error(
            `markFailed write failed for review ${reviewId} — original error preserved; sweep will finalise this row`,
            persistErr instanceof Error ? persistErr.stack : String(persistErr),
          );
        }
      };

      // Helper to emit the failure SSE event AFTER the
      // markFailedSafely write has landed. Wrapping in try/catch so a
      // subscriber throw does not propagate back to the catch block —
      // the original error is still what the caller receives via throw.
      const emitFailedSafely = (failedAt: Date): void => {
        try {
          const failEvent: TerminalReviewEvent = {
            review_id: reviewId,
            pr_node_id: prNodeId,
            repo_full_name: null, // no PR join on failure path (simplicity over precision)
            author_login: null,
            status: 'failed',
            prompt_version: PROMPT_AND_TOOL_VERSION,
            finding_counts: { error: 0, warning: 0, info: 0 },
            token_totals: null,
            completed_at: failedAt.getTime(),
          };
          this.events.emit(failEvent);
        } catch (emitErr) {
          this.logger.error(
            `SSE emit failed for failed review ${reviewId} — original error preserved`,
            emitErr instanceof Error ? emitErr.stack : String(emitErr),
          );
        }
      };

      if (err instanceof AnthropicRequestError) {
        const failedAt = new Date();
        markFailedSafely({
          completed_at: failedAt,
          error_status: err.status,
          error_code: err.errorCode ?? 'anthropic_error',
          // turn_cap_exceeded and malformed_emit_finding carry partial
          // loop state on the error so it lands in the reviews row
          // alongside the failure. Pre-loop failures (auth, network)
          // leave these undefined → markFailed leaves turn_count at
          // the schema default (0).
          turn_count: err.turnCount,
          tool_calls: err.toolCalls ?? null,
        });
        // Emit the failure SSE — outside any transaction, since the
        // markFailed write above has already committed. Emit before
        // throwing so the SSE stream reflects the failure before the
        // error propagates to the caller.
        emitFailedSafely(failedAt);
        throw err;
      }
      const failedAt = new Date();
      markFailedSafely({
        completed_at: failedAt,
        error_status: null,
        error_code: 'internal_error',
      });
      emitFailedSafely(failedAt);
      throw new ReviewsServiceError(
        'ReviewsService.runDryRun failed before transaction commit',
        err,
      );
    }

    // Build per-finding inserts BEFORE the transaction so the
    // synchronous callback below does only sync work. Severity is
    // sourced from each matched SearchHit's metadata. The adapter
    // already filters hallucinated rule_ids; we re-defend here with
    // a fallback in case future adapters skip the filter.
    const completedAt = new Date();
    const findingInserts: ReviewFindingInsert[] = [];
    for (const finding of result.findings) {
      const matched = searchHits.find((hit) => hit.rule_id === finding.rule_id);
      if (!matched) {
        // Adapter already filters; if we reach here, log and skip.
        this.logger.warn(
          `Dropped finding with unmatched rule_id="${sanitizeSlug(finding.rule_id)}"`,
        );
        continue;
      }
      const severity = resolveSeverity(matched, this.logger);
      findingInserts.push({
        id: randomUUID(),
        review_id: reviewId,
        rule_id: finding.rule_id,
        severity,
        title: finding.title,
        message: finding.message,
        location_hint: finding.location_hint ?? null,
        citation: finding.citation ?? null,
        created_at: completedAt,
      });
    }

    // SYNCHRONOUS ONLY — better-sqlite3's transaction(fn) commits on
    // the first `await`. Any await inside this callback silently breaks
    // atomicity. See https://github.com/WiseLibs/better-sqlite3#transactionfunction-function---function
    this.db.transaction(() => {
      this.reviews.markCompleted(reviewId, {
        completed_at: completedAt,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: result.usage.cache_read_input_tokens ?? null,
        turn_count: result.turnCount,
        tool_calls: result.toolCalls,
        hallucinated_finding_count: result.hallucinatedFindingCount,
        cache_hit_count: result.cacheHitCount,
      });
      this.findings.insertMany(findingInserts);
    });

    const persistedFindings = this.findings.findByReviewId(reviewId);

    // SSE success emit. Must be OUTSIDE the db.transaction() callback
    // above: better-sqlite3 runs callbacks synchronously inside
    // BEGIN…COMMIT with no post-commit hook, so emitting inside the
    // callback would rollback the transaction if a subscriber threw.
    // Placing it here guarantees "emit only after the row is durably
    // committed".
    try {
      const prRow = prNodeId ? this.pullRequests.findByNodeId(prNodeId) : undefined;
      const successEvent: TerminalReviewEvent = {
        review_id: reviewId,
        pr_node_id: prNodeId,
        repo_full_name: prRow?.repo_full_name ?? null,
        author_login: prRow?.author_login ?? null,
        status: 'completed',
        prompt_version: PROMPT_AND_TOOL_VERSION,
        finding_counts: countBySeverity(findingInserts),
        token_totals: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? null,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? null,
        },
        completed_at: completedAt.getTime(),
      };
      this.events.emit(successEvent);
    } catch (emitErr) {
      this.logger.error(
        `SSE emit failed for completed review ${reviewId} — review row is committed and unaffected`,
        emitErr instanceof Error ? emitErr.stack : String(emitErr),
      );
    }

    return {
      review_id: reviewId,
      status: 'completed',
      findings: persistedFindings,
      usage: result.usage,
      model: result.model,
      prompt_version: result.promptVersion,
      turn_count: result.turnCount,
      tool_calls: result.toolCalls,
    };
  }

  // Sibling of runDryRun for the BullMQ worker path. The lifecycle
  // is identical (insert in_progress → llm.analyzeDiff →
  // transaction(markCompleted + findings.insertMany)). The only
  // differences are upstream: the worker fetched the diff from
  // Octokit, pre-checked empty / MAX_DIFF_BYTES, and constructed the
  // per-job GitHubRepoContextProvider. The worker also POSTs the
  // GitHub Review after this returns, using the result's findings —
  // that POST stays out of this method to keep the persistence
  // contract symmetric with runDryRun.
  async runRealReview(input: RunRealReviewInput): Promise<RunDryRunResult> {
    return this.runDryRun({
      diff: input.diff,
      prNodeId: input.prNodeId,
      repoContext: input.repoContext,
      reviewId: input.reviewId,
    });
  }

  // Shutdown-drain helper. Marks every review_id in the set as
  // failed/<errorCode>, gated on the row still being 'in_progress'
  // (see IReviewRepository.markFailedIfInProgress). Wraps the loop
  // in a single better-sqlite3 transaction so the whole batch commits
  // or none does.
  //
  // The unique caller is ReviewsProcessor.drainGracefully on
  // SIGTERM timeout. Rows that completed between the drain snapshot
  // and this call retain their 'completed' status — the guarded
  // UPDATE is a no-op for them. Returns the number of rows actually
  // flipped so the drain log reflects truth.
  markRowsFailedByIdSet(reviewIds: string[], errorCode: string): number {
    if (reviewIds.length === 0) return 0;
    const completedAt = new Date();
    let flipped = 0;
    this.db.transaction(() => {
      for (const id of reviewIds) {
        flipped += this.reviews.markFailedIfInProgress(id, {
          completed_at: completedAt,
          error_status: null,
          error_code: errorCode,
        });
      }
    });
    return flipped;
  }
}

// Tight UUID gate. Mirrors the regex in reviews.processor.ts and the
// formatter. Reject any string that fails the canonical pattern so a
// caller passing garbage doesn't end up persisted as the row id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateOptionalReviewId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ReviewsServiceError(
      'runDryRun.input.reviewId must be a canonical UUID when provided',
    );
  }
  return value;
}

function hashSortedComposites(composites: string[]): string {
  const sorted = [...composites].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

function resolveSeverity(
  hit: SearchHit,
  logger: Logger,
): SeverityLevel {
  const candidate = hit.metadata?.severity;
  if (typeof candidate === 'string' && ALLOWED_SEVERITIES.has(candidate as SeverityLevel)) {
    return candidate as SeverityLevel;
  }
  logger.warn(
    `Severity missing or unrecognised for rule_id="${sanitizeSlug(hit.rule_id)}" — defaulting to "${DEFAULT_SEVERITY}"`,
  );
  return DEFAULT_SEVERITY;
}

function sanitizeSlug(value: unknown): string {
  if (typeof value !== 'string') return '<non-string>';
  return value.replace(/[\r\n]+/g, ' ').slice(0, 80);
}

// Count finding inserts by severity for the SSE terminal event payload.
// Called on the success path only; the failure path always emits zeros.
function countBySeverity(
  inserts: ReviewFindingInsert[],
): TerminalReviewEvent['finding_counts'] {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const insert of inserts) {
    if (insert.severity in counts) {
      counts[insert.severity as keyof typeof counts]++;
    }
  }
  return counts;
}

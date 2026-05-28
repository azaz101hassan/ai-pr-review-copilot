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

// ReviewsService orchestrates the Day-3 pipeline:
//   embeddings.search() → llm.analyzeDiff() → persist (3-step lifecycle)
//
// The 3-step lifecycle removes the "process died between insert and
// update" failure mode that a 2-state status enum would silently leak.
// See docs/plans/04-day3-claude-integration.md → Key Technical
// Decisions → Persistence atomicity.

export interface RunDryRunInput {
  diff: string;
  k?: number;
  prNodeId?: string | null;
}

export interface RunDryRunResult {
  review_id: string;
  status: 'completed' | 'failed';
  findings: ReviewFindingRecord[];
  usage: UsageStats | null;
  model: string;
  prompt_version: string;
}

export class ReviewsServiceError extends Error {
  readonly name = 'ReviewsServiceError';
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

const DEFAULT_K = 10;
// Same cutoff used by the startup sweep — 5 minutes. Anything older
// than this in `in_progress` is treated as a casualty of a prior
// process death.
const STALE_IN_PROGRESS_CUTOFF_MS = 5 * 60_000;
// Severity values that match the rule corpus's metadata.severity field.
// Sourced from rule metadata at persistence; the adapter never emits
// severity (see D1 in the plan).
const ALLOWED_SEVERITIES = new Set(['error', 'warning', 'info']);
const DEFAULT_SEVERITY: 'error' | 'warning' | 'info' = 'warning';

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
    // review_id is generated separately just below, and is NEVER logged
    // before the row commits (PF1).
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
    // what Day-6 eval will want to reproduce.
    const searchHits = [...rawHits].sort((a, b) =>
      `${a.source}:${a.rule_id}`.localeCompare(`${b.source}:${b.rule_id}`),
    );

    const retrievedChunkIds = searchHits.map((hit) => `${hit.source}:${hit.rule_id}`);
    const retrievedChunkIdsHash = hashSortedComposites(retrievedChunkIds);

    // PF1: generate the review_id just before the insert (and not in a
    // pre-insert log line). Once the row is durably inserted we can use
    // it freely.
    const reviewId = randomUUID();
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
      });
    } catch (err) {
      if (err instanceof AnthropicRequestError) {
        this.reviews.markFailed(reviewId, {
          completed_at: new Date(),
          error_status: err.status,
          error_code: err.errorCode ?? 'anthropic_error',
        });
        throw err;
      }
      this.reviews.markFailed(reviewId, {
        completed_at: new Date(),
        error_status: null,
        error_code: 'internal_error',
      });
      throw new ReviewsServiceError(
        'ReviewsService.runDryRun failed before transaction commit',
        err,
      );
    }

    // Build per-finding inserts BEFORE the transaction so the
    // synchronous callback below does only sync work. Severity is
    // sourced from each matched SearchHit's metadata (D1). Adapter
    // already filtered hallucinated rule_ids, but we re-defend here
    // with a fallback in case future adapters skip the filter.
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
      });
      this.findings.insertMany(findingInserts);
    });

    const persistedFindings = this.findings.findByReviewId(reviewId);

    return {
      review_id: reviewId,
      status: 'completed',
      findings: persistedFindings,
      usage: result.usage,
      model: result.model,
      prompt_version: result.promptVersion,
    };
  }
}

function hashSortedComposites(composites: string[]): string {
  const sorted = [...composites].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

function resolveSeverity(
  hit: SearchHit,
  logger: Logger,
): 'error' | 'warning' | 'info' {
  const candidate = hit.metadata?.severity;
  if (typeof candidate === 'string' && ALLOWED_SEVERITIES.has(candidate)) {
    return candidate as 'error' | 'warning' | 'info';
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

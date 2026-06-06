import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, gt, isNotNull, lt, lte, notInArray, sql, sum } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { pullRequests, reviewFindings, reviews } from '../schema';
import {
  AnalyticsAggregate,
  IReviewRepository,
  ReviewFilterSpec,
  ReviewListEntry,
} from '@/modules/reviews/types/review.repository';
import {
  ReviewCompletionPatch,
  ReviewFailurePatch,
  ReviewInsert,
  ReviewRecord,
} from '@/modules/reviews/types/review.types';
import { ReviewFindingRecord } from '@/modules/reviews/types/review-finding.types';
import { computeLatencyPercentiles } from '@/modules/dashboard/helpers/latency-percentile';

// Prompt version values that indicate a standalone (pre-LLM) outcome:
// a hard failure, an empty diff, or a size-gate skip. These rows are
// excluded from the main analytics aggregates because they have no
// findings, zero or null token fields, and would distort every metric.
// The list page (findFiltered / countFiltered) still shows them so the
// displayed row count matches the actual DB count.
//
// The `standalone-skipped-too-large` value gets its own dedicated count
// on the aggregate (skippedCount) so the dashboard can show how often
// the size gate is firing — a useful pivot-validation signal.
const STANDALONE_VERSIONS = [
  'standalone-failure',
  'standalone-empty-diff',
  'standalone-skipped-too-large',
] as const;

const SIZE_SKIPPED_VERSION = 'standalone-skipped-too-large' as const;

// Error-code breakdown. These error_code values come from worker
// lifecycle / GitHub-post paths (reviews.processor.ts and the
// startup sweep in reviews.service.ts), not the reviewer loop itself.
// Excluding them keeps the dashboard chip's signal scoped to reviewer
// behavior — "what's the most common way the reviewer fails?" —
// rather than mixing in orchestration failures the operator already
// sees on the failure walkthrough on the PR. Reviewer-loop codes
// (turn_cap_exceeded, malformed_emit_finding, rate_limit_error,
// unexpected_response_shape, internal_error, etc.) and any future
// codes added inside the reviewer auto-appear in the chip without
// a code change here — that's the deny-list trade-off vs. an
// allow-list.
const POST_SIDE_ERROR_CODES = [
  'comment_post_failed',
  'inline_post_failed',
  'pr_closed_during_review',
  'process_terminated',
] as const;

@Injectable()
export class SqliteReviewsRepository implements IReviewRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(record: ReviewInsert): void {
    this.db.drizzle.insert(reviews).values(record).run();
  }

  // Reserve a row up front with zeroed/empty retrieval metadata and
  // null usage. The 'placeholder' prompt_version flags the row as
  // not-yet-reconciled; updateRetrievalMetadata overwrites these six
  // columns once retrieval has run (or a skip/empty/failure path sets
  // a standalone marker).
  insertInProgress(args: {
    id: string;
    pr_node_id: string;
    model: string;
    created_at: Date;
  }): void {
    this.insert({
      id: args.id,
      pr_node_id: args.pr_node_id,
      created_by: null,
      diff_length: 0,
      model: args.model,
      prompt_version: 'placeholder',
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
      created_at: args.created_at,
      completed_at: null,
    });
  }

  findById(id: string): ReviewRecord | undefined {
    return this.db.drizzle.select().from(reviews).where(eq(reviews.id, id)).get();
  }

  findAll(limit = 100): ReviewRecord[] {
    return this.db.drizzle
      .select()
      .from(reviews)
      .orderBy(desc(reviews.created_at))
      .limit(limit)
      .all();
  }

  markCompleted(id: string, patch: ReviewCompletionPatch): void {
    this.db.drizzle
      .update(reviews)
      .set({
        status: 'completed',
        completed_at: patch.completed_at,
        input_tokens: patch.input_tokens,
        output_tokens: patch.output_tokens,
        cache_creation_input_tokens: patch.cache_creation_input_tokens,
        cache_read_input_tokens: patch.cache_read_input_tokens,
        // Drizzle's `json` mode handles serialization. Skip the SET
        // for both undefined AND null — otherwise drizzle-orm may
        // serialize `null` as the literal JSON string "null" in a
        // `mode: 'json'` text column, which breaks
        // `WHERE tool_calls_json IS NULL` queries used by eval.
        // Skipping leaves the column at its schema default
        // (turn_count = 0, tool_calls_json = SQL NULL).
        ...(patch.turn_count !== undefined && patch.turn_count !== null
          ? { turn_count: patch.turn_count }
          : {}),
        ...(patch.tool_calls !== undefined && patch.tool_calls !== null
          ? { tool_calls_json: patch.tool_calls }
          : {}),
        // Observability counters. Omit the SET when undefined so the
        // column's schema default (0) applies — same shape as the
        // turn_count handling above. A caller that explicitly passes
        // 0 still writes 0, which matches the default.
        ...(patch.hallucinated_finding_count !== undefined
          ? { hallucinated_finding_count: patch.hallucinated_finding_count }
          : {}),
        ...(patch.cache_hit_count !== undefined
          ? { cache_hit_count: patch.cache_hit_count }
          : {}),
        // Overwrite the placeholder model stored at insert time with the
        // actual model id echoed back by the provider SDK. Omit when not
        // provided so older callers that don't pass this field are unaffected.
        ...(patch.model !== undefined && patch.model !== ''
          ? { model: patch.model }
          : {}),
      })
      .where(eq(reviews.id, id))
      .run();
  }

  markFailed(id: string, patch: ReviewFailurePatch): void {
    this.db.drizzle
      .update(reviews)
      .set({
        status: 'failed',
        completed_at: patch.completed_at,
        error_status: patch.error_status,
        error_code: patch.error_code,
        ...(patch.turn_count !== undefined && patch.turn_count !== null
          ? { turn_count: patch.turn_count }
          : {}),
        ...(patch.tool_calls !== undefined && patch.tool_calls !== null
          ? { tool_calls_json: patch.tool_calls }
          : {}),
      })
      .where(eq(reviews.id, id))
      .run();
  }

  // Identical to markFailed BUT gated on status='in_progress'. Used
  // by the SIGTERM drain so a row that finished completing in the
  // last millisecond doesn't get flipped from 'completed' to
  // 'failed'. The regular markFailed path stays unguarded because
  // comment_post_failed legitimately flips 'completed' → 'failed'
  // (the agent loop succeeded; only the POST didn't land). Returns
  // the number of rows updated so the drain can log accurately.
  markFailedIfInProgress(id: string, patch: ReviewFailurePatch): number {
    const result = this.db.drizzle
      .update(reviews)
      .set({
        status: 'failed',
        completed_at: patch.completed_at,
        error_status: patch.error_status,
        error_code: patch.error_code,
        ...(patch.turn_count !== undefined && patch.turn_count !== null
          ? { turn_count: patch.turn_count }
          : {}),
        ...(patch.tool_calls !== undefined && patch.tool_calls !== null
          ? { tool_calls_json: patch.tool_calls }
          : {}),
      })
      .where(
        and(eq(reviews.id, id), eq(reviews.status, 'in_progress')),
      )
      .run();
    return Number(result.changes);
  }

  setCheckRunId(reviewId: string, checkRunId: number): void {
    const result = this.db.drizzle
      .update(reviews)
      .set({ check_run_id: checkRunId })
      .where(eq(reviews.id, reviewId))
      .run();
    if (Number(result.changes) === 0) {
      throw new Error(`no review row with id="${reviewId}"`);
    }
  }

  setWalkthroughSummary(reviewId: string, summary: string | null): void {
    const result = this.db.drizzle
      .update(reviews)
      .set({ walkthrough_summary: summary })
      .where(eq(reviews.id, reviewId))
      .run();
    if (Number(result.changes) === 0) {
      throw new Error(`no review row with id="${reviewId}"`);
    }
  }

  // Reconcile the six placeholder retrieval columns written by
  // insertInProgress with their real values. Scoped to those columns
  // only — status, tokens, error fields, created_at, and completed_at
  // are left untouched so the lifecycle row keeps its in_progress
  // reservation and any later markCompleted/markFailed semantics.
  updateRetrievalMetadata(
    reviewId: string,
    patch: {
      diff_length: number;
      model: string;
      prompt_version: string;
      top_k: number;
      retrieved_chunk_ids: string;
      retrieved_chunk_ids_hash: string;
    },
  ): void {
    this.db.drizzle
      .update(reviews)
      .set({
        diff_length: patch.diff_length,
        model: patch.model,
        prompt_version: patch.prompt_version,
        top_k: patch.top_k,
        retrieved_chunk_ids: patch.retrieved_chunk_ids,
        retrieved_chunk_ids_hash: patch.retrieved_chunk_ids_hash,
      })
      .where(eq(reviews.id, reviewId))
      .run();
  }

  findRecentInProgressForPr(
    prNodeId: string,
    withinMs: number,
  ): ReviewRecord | undefined {
    const cutoff = new Date(Date.now() - withinMs);
    return this.db.drizzle
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.pr_node_id, prNodeId),
          eq(reviews.status, 'in_progress'),
          gt(reviews.created_at, cutoff),
        ),
      )
      .orderBy(desc(reviews.created_at))
      .limit(1)
      .get();
  }

  sweepStaleInProgress(opts: { olderThanMs: number; errorCode: string }): number {
    const cutoff = new Date(Date.now() - opts.olderThanMs);
    const now = new Date();
    const result = this.db.drizzle
      .update(reviews)
      .set({
        status: 'failed',
        error_code: opts.errorCode,
        completed_at: now,
      })
      .where(
        and(
          eq(reviews.status, 'in_progress'),
          lt(reviews.created_at, cutoff),
        ),
      )
      .run();
    return Number(result.changes);
  }

  // Dashboard read-side methods.

  // LEFT JOIN reviews → pull_requests to expose PR metadata. NULL when
  // pr_node_id is null (dry-run reviews). Does NOT exclude standalone rows
  // so the list page count matches the DB row count.
  findFiltered(
    spec: ReviewFilterSpec,
    opts: { limit: number; offset?: number },
  ): ReviewListEntry[] {
    const offset = opts.offset ?? 0;
    const rows = this.db.drizzle
      .select({
        id: reviews.id,
        pr_node_id: reviews.pr_node_id,
        created_by: reviews.created_by,
        diff_length: reviews.diff_length,
        model: reviews.model,
        prompt_version: reviews.prompt_version,
        top_k: reviews.top_k,
        retrieved_chunk_ids: reviews.retrieved_chunk_ids,
        retrieved_chunk_ids_hash: reviews.retrieved_chunk_ids_hash,
        status: reviews.status,
        error_status: reviews.error_status,
        error_code: reviews.error_code,
        input_tokens: reviews.input_tokens,
        output_tokens: reviews.output_tokens,
        cache_creation_input_tokens: reviews.cache_creation_input_tokens,
        cache_read_input_tokens: reviews.cache_read_input_tokens,
        turn_count: reviews.turn_count,
        tool_calls_json: reviews.tool_calls_json,
        created_at: reviews.created_at,
        completed_at: reviews.completed_at,
        repo_full_name: pullRequests.repo_full_name,
        pr_number: pullRequests.number,
        pr_title: pullRequests.title,
        author_login: pullRequests.author_login,
        // Indexed lookup per row via idx_review_findings_review_id; cheap
        // at the list page's 50-row ceiling.
        finding_count: sql<number>`(
          SELECT COUNT(*) FROM ${reviewFindings}
          WHERE ${reviewFindings.review_id} = ${reviews.id}
        )`.as('finding_count'),
      })
      .from(reviews)
      .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
      .where(buildFilterCondition(spec))
      .orderBy(desc(reviews.created_at))
      .limit(opts.limit)
      .offset(offset)
      .all();

    return rows as ReviewListEntry[];
  }

  // Total count of rows matching the filter. Does NOT exclude standalone rows.
  countFiltered(spec: ReviewFilterSpec): number {
    const result = this.db.drizzle
      .select({ total: count() })
      .from(reviews)
      .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
      .where(buildFilterCondition(spec))
      .get();
    return result?.total ?? 0;
  }

  // Single review + its findings. Returns null for unknown id.
  // Findings ordered by created_at ASC.
  findByIdWithFindings(
    id: string,
  ): { review: ReviewRecord; findings: ReviewFindingRecord[] } | null {
    const review = this.db.drizzle
      .select()
      .from(reviews)
      .where(eq(reviews.id, id))
      .get();

    if (!review) return null;

    const findings = this.db.drizzle
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.review_id, id))
      .orderBy(asc(reviewFindings.created_at))
      .all();

    return { review, findings };
  }

  // Runs nine queries inside a single read transaction and returns
  // aggregated analytics. The five "main" queries (1-5) exclude every
  // standalone row (`prompt_version NOT IN (...)`); a sixth query
  // counts the size-gate skips on its own so the dashboard can
  // surface them without inflating the completed/severity/latency
  // tallies; queries 7-9 add observability signals (hallucination
  // total, top reviewer-loop error codes, cache-hit total).
  aggregateByFilter(spec: ReviewFilterSpec): AnalyticsAggregate {
    return this.db.transaction(() => {
      const filterCond = buildFilterCondition(spec);
      const standaloneExclusion = notInArray(reviews.prompt_version, [...STANDALONE_VERSIONS]);

      const baseWhere = filterCond
        ? and(filterCond, standaloneExclusion)
        : standaloneExclusion;

      // 1. Status breakdown: GROUP BY status
      const statusRows = this.db.drizzle
        .select({ status: reviews.status, cnt: count() })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .where(baseWhere)
        .groupBy(reviews.status)
        .all();

      const statusBreakdown = { completed: 0, failed: 0, in_progress: 0 };
      for (const row of statusRows) {
        if (row.status === 'completed') statusBreakdown.completed = row.cnt;
        else if (row.status === 'failed') statusBreakdown.failed = row.cnt;
        else if (row.status === 'in_progress') statusBreakdown.in_progress = row.cnt;
      }

      // 2. Severity rollup: JOIN review_findings, GROUP BY severity
      const severityRows = this.db.drizzle
        .select({ severity: reviewFindings.severity, cnt: count() })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .innerJoin(reviewFindings, eq(reviews.id, reviewFindings.review_id))
        .where(baseWhere)
        .groupBy(reviewFindings.severity)
        .all();

      const severityRollup = { error: 0, warning: 0, info: 0 };
      for (const row of severityRows) {
        if (row.severity === 'error') severityRollup.error = row.cnt;
        else if (row.severity === 'warning') severityRollup.warning = row.cnt;
        else if (row.severity === 'info') severityRollup.info = row.cnt;
      }

      // 3. Top-10 rules: GROUP BY rule_id ORDER BY count DESC LIMIT 10
      const topRuleRows = this.db.drizzle
        .select({ rule_id: reviewFindings.rule_id, cnt: count() })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .innerJoin(reviewFindings, eq(reviews.id, reviewFindings.review_id))
        .where(baseWhere)
        .groupBy(reviewFindings.rule_id)
        .orderBy(desc(count()))
        .limit(10)
        .all();

      const topRules = topRuleRows.map((r) => ({ rule_id: r.rule_id, count: r.cnt }));

      // 4. Token totals: SUM over four token columns
      const tokenRow = this.db.drizzle
        .select({
          input_tokens: sum(reviews.input_tokens),
          output_tokens: sum(reviews.output_tokens),
          cache_creation_input_tokens: sum(reviews.cache_creation_input_tokens),
          cache_read_input_tokens: sum(reviews.cache_read_input_tokens),
        })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .where(baseWhere)
        .get();

      const tokenTotals = {
        input_tokens: Number(tokenRow?.input_tokens ?? 0),
        output_tokens: Number(tokenRow?.output_tokens ?? 0),
        cache_creation_input_tokens: Number(tokenRow?.cache_creation_input_tokens ?? 0),
        cache_read_input_tokens: Number(tokenRow?.cache_read_input_tokens ?? 0),
      };

      // 5. Latency: fetch (completed_at - created_at) in ms for completed rows
      //    then compute p50/p95 in TS (SQLite has no percentile_cont).
      const latencyRows = this.db.drizzle
        .select({
          duration_ms: sql<number>`(${reviews.completed_at} - ${reviews.created_at})`,
        })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .where(
          and(
            baseWhere,
            eq(reviews.status, 'completed'),
            isNotNull(reviews.completed_at),
          ),
        )
        .all();

      const durations = latencyRows
        .map((r) => r.duration_ms)
        .filter((d): d is number => typeof d === 'number' && d >= 0);

      const latency = computeLatencyPercentiles(durations);

      // 6. Size-gate skip count — explicitly INCLUDES the standalone
      //    skip rows that the main queries exclude. Honours the same
      //    filter (repo/author/date) so the count moves with whatever
      //    slice the operator is looking at.
      const skipWhere = filterCond
        ? and(filterCond, eq(reviews.prompt_version, SIZE_SKIPPED_VERSION))
        : eq(reviews.prompt_version, SIZE_SKIPPED_VERSION);
      const skipRow = this.db.drizzle
        .select({ cnt: count() })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .where(skipWhere)
        .get();
      const skippedCount = skipRow?.cnt ?? 0;

      // 7. Hallucination total: SUM(hallucinated_finding_count) over
      //    non-standalone rows respecting the filter. Standalone rows
      //    carry 0 anyway (no reviewer ran), but baseWhere keeps the
      //    semantics consistent with the rest of the aggregator.
      const hallucinationRow = this.db.drizzle
        .select({ total: sum(reviews.hallucinated_finding_count) })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .where(baseWhere)
        .get();
      const hallucinatedTotal = Number(hallucinationRow?.total ?? 0);

      // 8. Error-code breakdown: top-10 by count, failed reviews only,
      //    excluding POST-side / orchestration codes so the chip
      //    surfaces reviewer-loop failure modes only. Renderers may
      //    subset further (the dashboard chip shows top 3).
      const errorRows = this.db.drizzle
        .select({ error_code: reviews.error_code, cnt: count() })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .where(
          and(
            baseWhere,
            eq(reviews.status, 'failed'),
            isNotNull(reviews.error_code),
            notInArray(reviews.error_code, [...POST_SIDE_ERROR_CODES]),
          ),
        )
        .groupBy(reviews.error_code)
        .orderBy(desc(count()))
        .limit(10)
        .all();

      const errorCodeBreakdown = errorRows
        .filter((r): r is { error_code: string; cnt: number } => r.error_code !== null)
        .map((r) => ({ error_code: r.error_code, count: r.cnt }));

      // 9. Cache-hit total: SUM(cache_hit_count) over non-standalone rows
      //    respecting the filter. Validates the per-review dedup cache's
      //    impact — operator sees how many tool calls were short-circuited.
      const cacheHitRow = this.db.drizzle
        .select({ total: sum(reviews.cache_hit_count) })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
        .where(baseWhere)
        .get();
      const cacheHitTotal = Number(cacheHitRow?.total ?? 0);

      return {
        statusBreakdown,
        severityRollup,
        topRules,
        tokenTotals,
        latency,
        skippedCount,
        hallucinatedTotal,
        errorCodeBreakdown,
        cacheHitTotal,
      };
    });
  }

  // SELECT DISTINCT repo_full_name from joined pull_requests, sorted.
  // Reviews with null pr_node_id produce no row (LEFT JOIN yields null
  // repo_full_name, which is filtered out by isNotNull).
  distinctRepos(spec: ReviewFilterSpec, limit: number): string[] {
    const filterCond = buildFilterCondition(spec);
    const rows = this.db.drizzle
      .selectDistinct({ repo_full_name: pullRequests.repo_full_name })
      .from(reviews)
      .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
      .where(filterCond ? and(filterCond, isNotNull(pullRequests.repo_full_name)) : isNotNull(pullRequests.repo_full_name))
      .orderBy(asc(pullRequests.repo_full_name))
      .limit(limit)
      .all();

    return rows.map((r) => r.repo_full_name as string);
  }

  // SELECT DISTINCT author_login from joined pull_requests, sorted.
  // Reviews with null pr_node_id do not surface a null entry (filtered by
  // isNotNull on author_login).
  distinctAuthors(spec: ReviewFilterSpec, limit: number): string[] {
    const filterCond = buildFilterCondition(spec);
    const rows = this.db.drizzle
      .selectDistinct({ author_login: pullRequests.author_login })
      .from(reviews)
      .leftJoin(pullRequests, eq(reviews.pr_node_id, pullRequests.node_id))
      .where(filterCond ? and(filterCond, isNotNull(pullRequests.author_login)) : isNotNull(pullRequests.author_login))
      .orderBy(asc(pullRequests.author_login))
      .limit(limit)
      .all();

    return rows.map((r) => r.author_login as string);
  }
}

// Shared WHERE-clause builder for the filter spec.
//
// Translates a ReviewFilterSpec into a Drizzle condition. Returns undefined
// when the spec is empty (so callers can skip the .where() call entirely).
// Time bounds are inclusive: sinceMs <= created_at <= untilMs.
function buildFilterCondition(spec: ReviewFilterSpec) {
  const conditions = [];

  if (spec.repo) {
    conditions.push(eq(pullRequests.repo_full_name, spec.repo));
  }
  if (spec.author) {
    conditions.push(eq(pullRequests.author_login, spec.author));
  }
  if (spec.prNodeId) {
    conditions.push(eq(reviews.pr_node_id, spec.prNodeId));
  }
  if (spec.sinceMs !== undefined) {
    conditions.push(gte(reviews.created_at, new Date(spec.sinceMs)));
  }
  if (spec.untilMs !== undefined) {
    conditions.push(lte(reviews.created_at, new Date(spec.untilMs)));
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

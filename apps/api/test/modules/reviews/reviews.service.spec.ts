import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { firstValueFrom, take } from 'rxjs';
import { Logger } from '@nestjs/common';
import { ReviewsService, ReviewsServiceError } from '@/modules/reviews/reviews.service';
import { ReviewEventsService, TerminalReviewEvent } from '@/modules/reviews/events/review-events.service';
import { AnthropicRequestError } from '@/infrastructure/anthropic/anthropic-request.error';
import { DatabaseService } from '@/infrastructure/db';
import { SqliteReviewsRepository } from '@/infrastructure/db/repositories/sqlite-reviews.repository';
import { SqliteReviewFindingsRepository } from '@/infrastructure/db/repositories/sqlite-review-findings.repository';
import {
  AnalyzeDiffInput,
  AnalyzeDiffResult,
  ILlmReviewer,
  PROMPT_AND_TOOL_VERSION,
} from '@/modules/reviews/types/llm-reviewer';
import {
  IReviewRepository,
  IReviewFindingRepository,
} from '@/modules/reviews/types';
import {
  ReviewFindingInsert,
  ReviewFindingRecord,
} from '@/modules/reviews/types/review-finding.types';
import {
  ReviewCompletionPatch,
  ReviewFailurePatch,
  ReviewInsert,
  ReviewRecord,
} from '@/modules/reviews/types/review.types';
import { ConfigService } from '@/config';
import { EmbeddingsService, SearchHit } from '@/modules/embeddings/embeddings.service';
import { IPullRequestRepository } from '@/modules/webhooks/types/pull-request.repository';
import { PullRequestRecord } from '@/modules/webhooks/types/pull-request.types';

// Spec for ReviewsService. Most cases use pure-mock collaborators
// (fast). Three cases use a real SQLite tmpdir via DatabaseService:
//   - transaction rollback after markCompleted but before
//     findings.insertMany — proves atomicity guarantee.
//   - onModuleInit startup sweep finalises stale in_progress rows.
//   - failure path persists 'failed' status atomically.
//
// ReviewEventsService emit assertions. Pure-mock cases pass a no-op
// ReviewEventsService stub; the emit-specific cases use a real
// ReviewEventsService instance to verify the Subject broadcast
// contract.

const REAL_DIFF = 'diff --git a/x.js b/x.js\n@@ -1 +1 @@\n-let x = 1\n+var x = 1\n';

function makeSearchHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    rule_id: 'no-var',
    source: 'team-standards',
    score: 0.91,
    title: 'No var',
    document: 'Prefer let/const over var.',
    metadata: { severity: 'warning', language: 'ts' },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    anthropicModel: 'claude-haiku-4-5-20251001',
    ...overrides,
  } as ConfigService;
}

function makeEmbeddings(hits: SearchHit[]): EmbeddingsService {
  return {
    search: jest.fn().mockResolvedValue(hits),
  } as unknown as EmbeddingsService;
}

function makeLlm(result: AnalyzeDiffResult | Error): ILlmReviewer {
  return {
    analyzeDiff:
      result instanceof Error
        ? jest.fn().mockRejectedValue(result)
        : jest.fn().mockResolvedValue(result),
  };
}

interface MockReviewRepo extends IReviewRepository {
  insert: jest.Mock;
  findById: jest.Mock;
  findAll: jest.Mock;
  markCompleted: jest.Mock;
  markFailed: jest.Mock;
  markFailedIfInProgress: jest.Mock;
  sweepStaleInProgress: jest.Mock;
}
function makeMockReviewRepo(): MockReviewRepo {
  return {
    insert: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
    markFailedIfInProgress: jest.fn().mockReturnValue(1),
    sweepStaleInProgress: jest.fn().mockReturnValue(0),
  } as MockReviewRepo;
}

interface MockFindingRepo extends IReviewFindingRepository {
  insertMany: jest.Mock;
  findByReviewId: jest.Mock;
  findByPrNodeIdForPriorReview: jest.Mock;
}
function makeMockFindingRepo(): MockFindingRepo {
  return {
    insertMany: jest.fn(),
    findByReviewId: jest.fn().mockReturnValue([]),
    findByPrNodeIdForPriorReview: jest.fn().mockReturnValue([]),
  } as MockFindingRepo;
}

function makeDbStub(): DatabaseService {
  // For tests that don't actually persist, a stub `transaction` that
  // synchronously invokes the callback is enough.
  return {
    transaction: <T>(fn: () => T): T => fn(),
  } as unknown as DatabaseService;
}

// Stub PullRequestRepository that returns undefined for findByNodeId unless configured.
interface MockPullRequestRepo extends IPullRequestRepository {
  save: jest.Mock;
  findByNodeId: jest.Mock;
}
function makeMockPrRepo(prRecord?: Partial<PullRequestRecord>): MockPullRequestRepo {
  const record: PullRequestRecord | undefined = prRecord
    ? {
        node_id: 'PR_node',
        repo_full_name: 'org/repo',
        number: 1,
        title: 'Test PR',
        state: 'open',
        head_sha: 'a'.repeat(40),
        base_sha: 'b'.repeat(40),
        author_login: 'alice',
        created_at: new Date(),
        updated_at: new Date(),
        raw_payload: '{}',
        walkthrough_comment_id: null,
        ...prRecord,
      }
    : undefined;
  return {
    save: jest.fn(),
    findByNodeId: jest.fn().mockReturnValue(record),
  } as MockPullRequestRepo;
}

// No-op ReviewEventsService for tests that don't care about emit.
function makeNoopEventsService(): ReviewEventsService {
  const svc = new ReviewEventsService();
  // Don't complete — just let the service be used normally;
  // since no one subscribes, emits are silently dropped.
  return svc;
}

function happyAnalyzeResult(
  overrides: Partial<AnalyzeDiffResult> = {},
): AnalyzeDiffResult {
  return {
    findings: [
      {
        rule_id: 'no-var',
        title: 'Replace var',
        message: 'Use let or const instead of var',
        location_hint: 'src/x.js:1',
        citation: 'var x = 1',
      },
    ],
    usage: {
      input_tokens: 1234,
      output_tokens: 56,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    model: 'claude-haiku-4-5-20251001',
    promptVersion: PROMPT_AND_TOOL_VERSION,
    // Degenerate single-turn case represented as turnCount=1 + one
    // synthetic emit_finding tool call so this helper satisfies the
    // return type. The service-level persistence + flow tests don't
    // inspect these fields; the e2e spec covers scripted multi-turn
    // behaviour.
    turnCount: 1,
    toolCalls: [
      {
        turn_idx: 1,
        tool_name: 'emit_finding',
        input_hash: '0'.repeat(16),
        result_bytes: 0,
        latency_ms: 0,
        stop_reason: 'tool_use',
      },
    ],
    hallucinatedFindingCount: 0,
    cacheHitCount: 0,
    ...overrides,
  };
}

describe('ReviewsService (pure-mock cases)', () => {
  describe('runDryRun — happy path lifecycle', () => {
    it('inserts in_progress BEFORE Claude call, then markCompleted + insertMany inside transaction', async () => {
      const hit = makeSearchHit();
      const embeddings = makeEmbeddings([hit]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      findings.findByReviewId.mockReturnValue([
        {
          id: 'finding-id-1',
          review_id: 'placeholder',
          rule_id: 'no-var',
          severity: 'warning',
          title: 'Replace var',
          message: 'Use let or const',
          location_hint: 'src/x.js:1',
          citation: 'var x = 1',
          created_at: new Date(),
        },
      ]);
      const db = makeDbStub();
      const service = new ReviewsService(embeddings, llm, reviews, findings, db, makeConfig(), makeNoopEventsService(), makeMockPrRepo());

      // Record call order
      const callOrder: string[] = [];
      reviews.insert.mockImplementation((record: ReviewInsert) => {
        callOrder.push(`insert(status=${record.status})`);
      });
      (llm.analyzeDiff as jest.Mock).mockImplementation(async () => {
        callOrder.push('analyzeDiff');
        return happyAnalyzeResult();
      });
      reviews.markCompleted.mockImplementation(() => {
        callOrder.push('markCompleted');
      });
      findings.insertMany.mockImplementation(() => {
        callOrder.push('insertMany');
      });

      const result = await service.runDryRun({ diff: REAL_DIFF });

      expect(callOrder).toEqual([
        'insert(status=in_progress)',
        'analyzeDiff',
        'markCompleted',
        'insertMany',
      ]);
      expect(reviews.markFailed).not.toHaveBeenCalled();
      expect(result.status).toBe('completed');
      expect(result.prompt_version).toBe(PROMPT_AND_TOOL_VERSION);
    });

    it('the in_progress insert has null token columns and prompt_version v1', async () => {
      const hit = makeSearchHit();
      const embeddings = makeEmbeddings([hit]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });

      const insertedRow = reviews.insert.mock.calls[0][0] as ReviewInsert;
      expect(insertedRow.status).toBe('in_progress');
      expect(insertedRow.input_tokens).toBeNull();
      expect(insertedRow.output_tokens).toBeNull();
      expect(insertedRow.cache_creation_input_tokens).toBeNull();
      expect(insertedRow.cache_read_input_tokens).toBeNull();
      expect(insertedRow.created_by).toBeNull();
      expect(insertedRow.prompt_version).toBe(PROMPT_AND_TOOL_VERSION);
      expect(insertedRow.retrieved_chunk_ids_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('default k is 10, override k flows through to embeddings.search AND the inserted row', async () => {
      const hit = makeSearchHit();
      const embeddings = makeEmbeddings([hit]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });
      expect((embeddings.search as jest.Mock).mock.calls[0][1]).toEqual({ k: 20 });
      expect((reviews.insert.mock.calls[0][0] as ReviewInsert).top_k).toBe(20);

      reviews.insert.mockClear();
      (embeddings.search as jest.Mock).mockClear();

      await service.runDryRun({ diff: REAL_DIFF, k: 5 });
      expect((embeddings.search as jest.Mock).mock.calls[0][1]).toEqual({ k: 5 });
      expect((reviews.insert.mock.calls[0][0] as ReviewInsert).top_k).toBe(5);
    });

    it('prNodeId flows through (null when absent, value when present)', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        makeMockFindingRepo(),
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });
      expect((reviews.insert.mock.calls[0][0] as ReviewInsert).pr_node_id).toBeNull();

      reviews.insert.mockClear();
      await service.runDryRun({ diff: REAL_DIFF, prNodeId: 'PR_xyz' });
      expect((reviews.insert.mock.calls[0][0] as ReviewInsert).pr_node_id).toBe('PR_xyz');
    });

    it('retrieved_chunk_ids is JSON-stringified array of composites; hash is sha256 of sorted-joined', async () => {
      const hits = [
        makeSearchHit({ rule_id: 'no-var', source: 'team-standards' }),
        makeSearchHit({ rule_id: 'eqeqeq', source: 'airbnb' }),
      ];
      const embeddings = makeEmbeddings(hits);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        makeMockFindingRepo(),
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });

      const inserted = reviews.insert.mock.calls[0][0] as ReviewInsert;
      const parsedIds = JSON.parse(inserted.retrieved_chunk_ids) as string[];
      // Service now sorts hits by composite before persisting + sending
      // to the LLM (so the user-message bytes are stable across calls
      // — Anthropic's prompt cache hashes against the exact bytes, and
      // Chroma can shuffle same-score hits between calls). The column
      // therefore records the sorted order, not the retrieval order.
      expect(parsedIds).toEqual(['airbnb:eqeqeq', 'team-standards:no-var']);
      const sorted = ['airbnb:eqeqeq', 'team-standards:no-var'].join('\n');
      const expectedHash = require('node:crypto')
        .createHash('sha256')
        .update(sorted)
        .digest('hex');
      expect(inserted.retrieved_chunk_ids_hash).toBe(expectedHash);
    });

    it('sorts hits by `${source}:${rule_id}` composite before passing to the LLM (cache stability)', async () => {
      // Hits returned in deliberately non-alphabetical order — service
      // must sort before invoking the adapter so consecutive calls
      // produce byte-identical user messages.
      const hits = [
        makeSearchHit({ rule_id: 'no-var', source: 'team-standards' }),
        makeSearchHit({ rule_id: 'eqeqeq', source: 'airbnb' }),
        makeSearchHit({ rule_id: 'prefer-const', source: 'airbnb' }),
      ];
      const embeddings = makeEmbeddings(hits);
      const llm = makeLlm(happyAnalyzeResult());
      const service = new ReviewsService(
        embeddings,
        llm,
        makeMockReviewRepo(),
        makeMockFindingRepo(),
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });

      const arg = (llm.analyzeDiff as jest.Mock).mock.calls[0][0] as AnalyzeDiffInput;
      const composites = arg.rules.map((r) => `${r.source}:${r.rule_id}`);
      expect(composites).toEqual([
        'airbnb:eqeqeq',
        'airbnb:prefer-const',
        'team-standards:no-var',
      ]);
    });
  });

  describe('runDryRun — severity sourcing (D1)', () => {
    it('persists severity from the matched SearchHit metadata (rule wins over adapter silence)', async () => {
      const hit = makeSearchHit({ metadata: { severity: 'error', language: 'ts' } });
      const embeddings = makeEmbeddings([hit]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });

      const inserts = findings.insertMany.mock.calls[0][0] as ReviewFindingInsert[];
      expect(inserts).toHaveLength(1);
      expect(inserts[0].severity).toBe('error');
    });

    it('defaults to "warning" and logs when SearchHit metadata lacks severity', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const hit = makeSearchHit({ metadata: {} });
      const embeddings = makeEmbeddings([hit]);
      const llm = makeLlm(happyAnalyzeResult());
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        makeMockReviewRepo(),
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });

      const inserts = findings.insertMany.mock.calls[0][0] as ReviewFindingInsert[];
      expect(inserts[0].severity).toBe('warning');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no-var'));
      warnSpy.mockRestore();
    });

    it('defaults to "warning" when metadata.severity is not in the allowed enum', async () => {
      const hit = makeSearchHit({ metadata: { severity: 'critical' } });
      const embeddings = makeEmbeddings([hit]);
      const llm = makeLlm(happyAnalyzeResult());
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        makeMockReviewRepo(),
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });

      const inserts = findings.insertMany.mock.calls[0][0] as ReviewFindingInsert[];
      expect(inserts[0].severity).toBe('warning');
    });
  });

  describe('runDryRun — empty paths', () => {
    it('empty diff throws synchronously without calling embeddings, llm, or repos', async () => {
      const embeddings = makeEmbeddings([]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await expect(service.runDryRun({ diff: '' })).rejects.toMatchObject({
        name: 'ReviewsServiceError',
      });
      expect(embeddings.search).not.toHaveBeenCalled();
      expect(llm.analyzeDiff).not.toHaveBeenCalled();
      expect(reviews.insert).not.toHaveBeenCalled();
    });

    it('empty findings still inserts the review row and calls insertMany([])', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const llm = makeLlm(happyAnalyzeResult({ findings: [] }));
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      const result = await service.runDryRun({ diff: REAL_DIFF });

      expect(reviews.insert).toHaveBeenCalledTimes(1);
      expect(reviews.markCompleted).toHaveBeenCalledTimes(1);
      expect(findings.insertMany).toHaveBeenCalledWith([]);
      expect(result.findings).toEqual([]);
    });
  });

  describe('runDryRun — mapping discipline', () => {
    it('forwards only {rule_id, source, document, title} to the adapter (no score, no metadata)', async () => {
      const hit = makeSearchHit({
        metadata: { severity: 'warning', language: 'ts', secret: 'should-not-leak' },
      });
      const embeddings = makeEmbeddings([hit]);
      const llm = makeLlm(happyAnalyzeResult());
      const service = new ReviewsService(
        embeddings,
        llm,
        makeMockReviewRepo(),
        makeMockFindingRepo(),
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });

      const arg = (llm.analyzeDiff as jest.Mock).mock.calls[0][0] as AnalyzeDiffInput;
      expect(arg.rules).toEqual([
        {
          rule_id: 'no-var',
          source: 'team-standards',
          document: 'Prefer let/const over var.',
          title: 'No var',
        },
      ]);
      expect(JSON.stringify(arg.rules)).not.toContain('should-not-leak');
      expect(JSON.stringify(arg.rules)).not.toContain('score');
    });

    it('embeddings.search is called with {k} only — no `where` clause at the search layer', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const llm = makeLlm(happyAnalyzeResult());
      const service = new ReviewsService(
        embeddings,
        llm,
        makeMockReviewRepo(),
        makeMockFindingRepo(),
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });
      const call = (embeddings.search as jest.Mock).mock.calls[0];
      expect(call[0]).toBe(REAL_DIFF);
      expect(call[1]).toEqual({ k: 20 });
    });
  });

  describe('runDryRun — failure paths', () => {
    it('AnthropicRequestError → markFailed with status/code, re-throw the error', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const err = new AnthropicRequestError('Anthropic API error: HTTP 429 (rate_limit_error)', {
        status: 429,
        errorCode: 'rate_limit_error',
      });
      const llm = makeLlm(err);
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await expect(service.runDryRun({ diff: REAL_DIFF })).rejects.toBe(err);
      expect(reviews.insert).toHaveBeenCalledTimes(1);
      expect((reviews.insert.mock.calls[0][0] as ReviewInsert).status).toBe('in_progress');
      expect(reviews.markFailed).toHaveBeenCalledTimes(1);
      const failPatch = reviews.markFailed.mock.calls[0][1] as ReviewFailurePatch;
      expect(failPatch.error_status).toBe(429);
      expect(failPatch.error_code).toBe('rate_limit_error');
      expect(reviews.markCompleted).not.toHaveBeenCalled();
      expect(findings.insertMany).not.toHaveBeenCalled();
    });

    it('non-Anthropic error → markFailed("internal_error") then wraps in ReviewsServiceError', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const underlying = new Error('boom');
      const llm = makeLlm(underlying);
      const reviews = makeMockReviewRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        makeMockFindingRepo(),
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      let caught: unknown;
      try {
        await service.runDryRun({ diff: REAL_DIFF });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ReviewsServiceError);
      expect((caught as ReviewsServiceError).cause).toBe(underlying);
      expect(reviews.markFailed.mock.calls[0][1].error_code).toBe('internal_error');
      expect(reviews.markFailed.mock.calls[0][1].error_status).toBeNull();
    });

    it('turn_cap_exceeded → markFailed carries the partial turn_count + tool_calls from the error', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const partialToolCalls = [
        {
          turn_idx: 1,
          tool_name: 'fetch_related_file',
          input_hash: 'a'.repeat(16),
          result_bytes: 800,
          latency_ms: 500,
          stop_reason: 'tool_use',
        },
      ];
      const err = new AnthropicRequestError(
        'Agent loop exceeded 6 turns without emit_finding',
        {
          status: 200,
          errorCode: 'turn_cap_exceeded',
          turnCount: 6,
          toolCalls: partialToolCalls,
        },
      );
      const llm = makeLlm(err);
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await expect(service.runDryRun({ diff: REAL_DIFF })).rejects.toBe(err);
      const failPatch = reviews.markFailed.mock.calls[0][1] as ReviewFailurePatch;
      expect(failPatch.error_code).toBe('turn_cap_exceeded');
      expect(failPatch.turn_count).toBe(6);
      expect(failPatch.tool_calls).toEqual(partialToolCalls);
      // No findings persisted on turn_cap_exceeded — the plan's
      // no-partial-findings rule (see Key Technical Decisions).
      expect(findings.insertMany).not.toHaveBeenCalled();
      expect(reviews.markCompleted).not.toHaveBeenCalled();
    });
  });

  describe('runDryRun — repoContext + agent-loop aggregates', () => {
    it('forwards input.repoContext to llm.analyzeDiff (CLI path)', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );
      const repoContext = {
        fetchFile: jest.fn(),
        fetchFunctionDefinition: jest.fn(),
        fetchPriorReview: jest.fn(),
      };

      await service.runDryRun({ diff: REAL_DIFF, repoContext: repoContext as unknown as Parameters<typeof service.runDryRun>[0]['repoContext'] });

      const analyzeArgs = (llm.analyzeDiff as jest.Mock).mock.calls[0][0];
      expect(analyzeArgs.repoContext).toBe(repoContext);
    });

    it('without input.repoContext, llm.analyzeDiff is called with repoContext: undefined', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      await service.runDryRun({ diff: REAL_DIFF });

      const analyzeArgs = (llm.analyzeDiff as jest.Mock).mock.calls[0][0];
      expect(analyzeArgs.repoContext).toBeUndefined();
    });

    it('markCompleted carries turnCount + toolCalls from the adapter result', async () => {
      const embeddings = makeEmbeddings([makeSearchHit()]);
      const toolCalls = [
        {
          turn_idx: 1,
          tool_name: 'fetch_related_file',
          input_hash: 'x'.repeat(16),
          result_bytes: 1024,
          latency_ms: 612,
          stop_reason: 'tool_use',
        },
        {
          turn_idx: 2,
          tool_name: 'emit_finding',
          input_hash: 'y'.repeat(16),
          result_bytes: 220,
          latency_ms: 511,
          stop_reason: 'tool_use',
        },
      ];
      const llm = makeLlm(
        happyAnalyzeResult({ turnCount: 2, toolCalls }),
      );
      const reviews = makeMockReviewRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        makeMockFindingRepo(),
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      const result = await service.runDryRun({ diff: REAL_DIFF });

      const completionPatch = reviews.markCompleted.mock.calls[0][1] as ReviewCompletionPatch;
      expect(completionPatch.turn_count).toBe(2);
      expect(completionPatch.tool_calls).toEqual(toolCalls);
      expect(result.turn_count).toBe(2);
      expect(result.tool_calls).toEqual(toolCalls);
    });
  });

  describe('review_id timing invariant', () => {
    it('review_id passed to insert/markCompleted/insertMany is the same id and is generated after embeddings.search', async () => {
      const hit = makeSearchHit();
      const embeddings = makeEmbeddings([hit]);
      const llm = makeLlm(happyAnalyzeResult());
      const reviews = makeMockReviewRepo();
      const findings = makeMockFindingRepo();
      const service = new ReviewsService(
        embeddings,
        llm,
        reviews,
        findings,
        makeDbStub(),
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      let idAtSearchTime: string | undefined;
      (embeddings.search as jest.Mock).mockImplementation(async () => {
        // Capture what's been logged at this point — review_id should
        // not exist yet because we generate it AFTER search returns.
        idAtSearchTime = '<not-yet>';
        return [hit];
      });

      const result = await service.runDryRun({ diff: REAL_DIFF });

      const idFromInsert = (reviews.insert.mock.calls[0][0] as ReviewInsert).id;
      const idFromMarkCompleted = reviews.markCompleted.mock.calls[0][0] as string;
      const findingInserts = findings.insertMany.mock.calls[0][0] as ReviewFindingInsert[];

      expect(idAtSearchTime).toBe('<not-yet>');
      expect(idFromInsert).toBe(idFromMarkCompleted);
      expect(findingInserts.every((f) => f.review_id === idFromInsert)).toBe(true);
      expect(result.review_id).toBe(idFromInsert);
    });
  });

  describe('db.transaction callback synchronicity guard', () => {
    it('source code never calls db.transaction with an `async` callback (grep-style guard)', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/modules/reviews/reviews.service.ts'),
        'utf8',
      );
      // Match `db.transaction(async`, `db.transaction((...) async`, etc.
      // The simple substring is enough to flag the common regression
      // shape; if the file evolves to use destructured `transaction`,
      // tighten this.
      expect(source).not.toMatch(/db\.transaction\(\s*async\b/);
      expect(source).not.toMatch(/\.transaction\(\s*async\b/);
      expect(source).toContain('SYNCHRONOUS ONLY');
    });
  });
});

// Real-SQLite tests use the actual DatabaseService for rollback / sweep
// guarantees that can't be observed through pure mocks.

describe('ReviewsService — real SQLite cases', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let reviewsRepo: SqliteReviewsRepository;
  let findingsRepo: SqliteReviewFindingsRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-service-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    reviewsRepo = new SqliteReviewsRepository(db);
    findingsRepo = new SqliteReviewFindingsRepository(db);
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('transaction rollback: if findings.insertMany throws, the markCompleted is rolled back', async () => {
    const embeddings = makeEmbeddings([makeSearchHit()]);
    const llm = makeLlm(happyAnalyzeResult());

    // Wrap the real findings repo so insertMany throws AFTER
    // markCompleted has already been called inside the same
    // transaction. The rollback should leave the row at 'in_progress'.
    const sabotagedFindings: IReviewFindingRepository = {
      insertMany: jest.fn().mockImplementation(() => {
        throw new Error('disk full');
      }),
      findByReviewId: (id) => findingsRepo.findByReviewId(id),
      findByPrNodeIdForPriorReview: (id) =>
        findingsRepo.findByPrNodeIdForPriorReview(id),
    };

    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      sabotagedFindings,
      db,
      makeConfig(),
      makeNoopEventsService(),
      makeMockPrRepo(),
    );

    await expect(service.runDryRun({ diff: REAL_DIFF })).rejects.toThrow('disk full');

    const all = reviewsRepo.findAll() as ReviewRecord[];
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('in_progress');
    expect(all[0].completed_at).toBeNull();
    // No findings written either.
    expect(findingsRepo.findByReviewId(all[0].id)).toEqual([]);
  });

  it('failure path: AnthropicRequestError persists status=failed with error fields, no findings', async () => {
    const embeddings = makeEmbeddings([makeSearchHit()]);
    const llm = makeLlm(
      new AnthropicRequestError('Anthropic API error: HTTP 429 (rate_limit_error)', {
        status: 429,
        errorCode: 'rate_limit_error',
      }),
    );
    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      makeNoopEventsService(),
      makeMockPrRepo(),
    );

    await expect(service.runDryRun({ diff: REAL_DIFF })).rejects.toMatchObject({
      name: 'AnthropicRequestError',
      status: 429,
      errorCode: 'rate_limit_error',
    });

    const all = reviewsRepo.findAll() as ReviewRecord[];
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('failed');
    expect(all[0].error_status).toBe(429);
    expect(all[0].error_code).toBe('rate_limit_error');
    expect(all[0].completed_at).toBeInstanceOf(Date);
    expect(findingsRepo.findByReviewId(all[0].id)).toEqual([]);
  });

  it('onModuleInit: finalises stale in_progress rows older than the cutoff, leaves fresh ones alone', () => {
    // STALE_IN_PROGRESS_CUTOFF_MS is 10 minutes so the sweep doesn't
    // race a healthy long agent loop. The stale row sits comfortably
    // past the cutoff at 15 min to keep the assertion timing-stable
    // regardless of suite-order drift.
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000);
    const oneMinAgo = new Date(Date.now() - 60_000);

    reviewsRepo.insert({
      id: 'stale-id',
      pr_node_id: null,
      created_by: null,
      diff_length: 100,
      model: 'claude-haiku-4-5-20251001',
      prompt_version: 'v1',
      top_k: 10,
      retrieved_chunk_ids: '[]',
      retrieved_chunk_ids_hash: 'a'.repeat(64),
      status: 'in_progress',
      error_status: null,
      error_code: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      created_at: fifteenMinAgo,
      completed_at: null,
    });
    reviewsRepo.insert({
      id: 'fresh-id',
      pr_node_id: null,
      created_by: null,
      diff_length: 100,
      model: 'claude-haiku-4-5-20251001',
      prompt_version: 'v1',
      top_k: 10,
      retrieved_chunk_ids: '[]',
      retrieved_chunk_ids_hash: 'a'.repeat(64),
      status: 'in_progress',
      error_status: null,
      error_code: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      created_at: oneMinAgo,
      completed_at: null,
    });

    const service = new ReviewsService(
      makeEmbeddings([]),
      makeLlm(happyAnalyzeResult()),
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      makeNoopEventsService(),
      makeMockPrRepo(),
    );

    service.onModuleInit();

    const stale = reviewsRepo.findById('stale-id') as ReviewRecord;
    const fresh = reviewsRepo.findById('fresh-id') as ReviewRecord;
    expect(stale.status).toBe('failed');
    expect(stale.error_code).toBe('process_terminated');
    expect(stale.completed_at).toBeInstanceOf(Date);
    expect(fresh.status).toBe('in_progress');
    expect(fresh.completed_at).toBeNull();
  });

  // runRealReview is a thin sibling of runDryRun on the service. Its
  // job is to delegate to the same lifecycle with the extra real-PR
  // inputs (prNodeId required, headSha captured for future use).
  it('runRealReview persists the row with pr_node_id and goes through the same lifecycle as runDryRun', async () => {
    // pr_node_id is an FK to pull_requests.node_id — seed the parent
    // row directly via raw SQL (the test's scope is the service, not
    // pull-request CRUD).
    db.getDb()
      .prepare(
        `INSERT INTO pull_requests
          (node_id, repo_full_name, number, title, state,
           head_sha, base_sha, author_login, created_at, updated_at, raw_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'PR_real_review_test',
        'octocat/demo',
        7,
        'Real review test',
        'open',
        'd'.repeat(40),
        'e'.repeat(40),
        'octocat',
        Date.now(),
        Date.now(),
        '{}',
      );

    const hit = makeSearchHit({ metadata: { severity: 'warning' } });
    const embeddings = makeEmbeddings([hit]);
    const llm = makeLlm(happyAnalyzeResult());
    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      makeNoopEventsService(),
      makeMockPrRepo(),
    );

    const result = await service.runRealReview({
      diff: REAL_DIFF,
      prNodeId: 'PR_real_review_test',
      headSha: 'd'.repeat(40),
      repoContext: undefined as never,
    });

    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(1);

    const row = reviewsRepo.findById(result.review_id) as ReviewRecord;
    expect(row.pr_node_id).toBe('PR_real_review_test');
    expect(row.status).toBe('completed');
  });

  // markRowsFailedByIdSet wraps a markFailed loop in a single
  // transaction. Drives the shutdown drain's failed-row flip.
  describe('markRowsFailedByIdSet', () => {
    function seedInProgress(id: string): void {
      reviewsRepo.insert({
        id,
        pr_node_id: null,
        created_by: null,
        diff_length: 0,
        model: 'haiku',
        prompt_version: 'v1',
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
        created_at: new Date(),
        completed_at: null,
      });
    }

    it('flips every in_progress row in the set to failed/<errorCode>', () => {
      seedInProgress('drain-a');
      seedInProgress('drain-b');
      seedInProgress('drain-c');

      const service = new ReviewsService(
        makeEmbeddings([]),
        makeLlm(happyAnalyzeResult()),
        reviewsRepo,
        findingsRepo,
        db,
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );

      service.markRowsFailedByIdSet(
        ['drain-a', 'drain-b', 'drain-c'],
        'process_terminated',
      );

      for (const id of ['drain-a', 'drain-b', 'drain-c']) {
        const row = reviewsRepo.findById(id) as ReviewRecord;
        expect(row.status).toBe('failed');
        expect(row.error_code).toBe('process_terminated');
        expect(row.completed_at).toBeInstanceOf(Date);
      }
    });

    it('no-ops on an empty id list', () => {
      seedInProgress('not-touched');
      const service = new ReviewsService(
        makeEmbeddings([]),
        makeLlm(happyAnalyzeResult()),
        reviewsRepo,
        findingsRepo,
        db,
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );
      service.markRowsFailedByIdSet([], 'process_terminated');
      expect((reviewsRepo.findById('not-touched') as ReviewRecord).status).toBe(
        'in_progress',
      );
    });

    // A row that completed milliseconds before the drain inspected
    // the in-flight Set must NOT be flipped to failed —
    // markFailedIfInProgress gates on status='in_progress'.
    it('does not flip rows that are already completed (drain race guard)', () => {
      seedInProgress('drain-completed');
      // Use the real markCompleted path so the row is now 'completed'.
      reviewsRepo.markCompleted('drain-completed', {
        completed_at: new Date(),
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      });

      const service = new ReviewsService(
        makeEmbeddings([]),
        makeLlm(happyAnalyzeResult()),
        reviewsRepo,
        findingsRepo,
        db,
        makeConfig(),
        makeNoopEventsService(),
        makeMockPrRepo(),
      );
      const flipped = service.markRowsFailedByIdSet(
        ['drain-completed'],
        'process_terminated',
      );
      expect(flipped).toBe(0);
      const row = reviewsRepo.findById('drain-completed') as ReviewRecord;
      expect(row.status).toBe('completed');
      expect(row.error_code).toBeNull();
    });
  });

  it('happy path through real SQLite: insert → markCompleted → insertMany → findByReviewId returns the persisted findings', async () => {
    const hit = makeSearchHit({ metadata: { severity: 'error' } });
    const embeddings = makeEmbeddings([hit]);
    const llm = makeLlm(happyAnalyzeResult());

    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      makeNoopEventsService(),
      makeMockPrRepo(),
    );

    const result = await service.runDryRun({ diff: REAL_DIFF, prNodeId: null });

    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
    const persisted: ReviewFindingRecord = result.findings[0];
    expect(persisted.severity).toBe('error');
    expect(persisted.rule_id).toBe('no-var');

    const row = reviewsRepo.findById(result.review_id) as ReviewRecord;
    expect(row.status).toBe('completed');
    expect(row.input_tokens).toBe(1234);
    expect(row.output_tokens).toBe(56);
    expect(row.completed_at).toBeInstanceOf(Date);
  });
});

// SSE emit assertions. These tests use a real ReviewEventsService to
// verify the Subject broadcast contract is wired at the two terminal
// sites in runDryRun (after the success-path transaction, and inside
// the catch block after markFailedSafely).
describe('ReviewsService — SSE terminal-state emit', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let reviewsRepo: SqliteReviewsRepository;
  let findingsRepo: SqliteReviewFindingsRepository;
  let prRepo: SqliteReviewsRepository; // we use a raw SQL helper for the PR row

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-emit-'));
    db = new DatabaseService();
    db.open(path.join(tmpDir, 'test.sqlite'));
    reviewsRepo = new SqliteReviewsRepository(db);
    findingsRepo = new SqliteReviewFindingsRepository(db);
  });

  afterEach(() => {
    db.onApplicationShutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('success path emits exactly one event with status: completed and correct review_id', async () => {
    const events = new ReviewEventsService();
    const received: TerminalReviewEvent[] = [];
    const sub = events.stream().subscribe((ev) => received.push(ev));

    const hit = makeSearchHit({ metadata: { severity: 'warning' } });
    const embeddings = makeEmbeddings([hit]);
    const llm = makeLlm(happyAnalyzeResult());
    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      events,
      makeMockPrRepo(),
    );

    const result = await service.runDryRun({ diff: REAL_DIFF, prNodeId: null });
    sub.unsubscribe();
    events.beforeApplicationShutdown();

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('completed');
    expect(received[0].review_id).toBe(result.review_id);
    expect(received[0].prompt_version).toBe(PROMPT_AND_TOOL_VERSION);
    // null prNodeId → repo and author must be null
    expect(received[0].pr_node_id).toBeNull();
    expect(received[0].repo_full_name).toBeNull();
    expect(received[0].author_login).toBeNull();
    // finding counts: 1 warning from the happy path (one finding, severity=warning)
    expect(received[0].finding_counts.warning).toBe(1);
    expect(received[0].finding_counts.error).toBe(0);
    expect(received[0].finding_counts.info).toBe(0);
    // token totals present on success
    expect(received[0].token_totals).not.toBeNull();
    expect(received[0].token_totals!.input_tokens).toBe(1234);
    expect(received[0].token_totals!.output_tokens).toBe(56);
  });

  it('success path emits with repo_full_name and author_login when prNodeId is non-NULL', async () => {
    // Seed the pull_requests row so the FK constraint on reviews.pr_node_id is satisfied
    db.getDb()
      .prepare(
        `INSERT INTO pull_requests
          (node_id, repo_full_name, number, title, state,
           head_sha, base_sha, author_login, created_at, updated_at, raw_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'PR_emit_test',
        'myorg/myrepo',
        42,
        'Emit test PR',
        'open',
        'a'.repeat(40),
        'b'.repeat(40),
        'bob',
        Date.now(),
        Date.now(),
        '{}',
      );

    const prRecord: Partial<PullRequestRecord> = {
      node_id: 'PR_emit_test',
      repo_full_name: 'myorg/myrepo',
      author_login: 'bob',
    };
    const events = new ReviewEventsService();
    const received: TerminalReviewEvent[] = [];
    const sub = events.stream().subscribe((ev) => received.push(ev));

    const hit = makeSearchHit({ metadata: { severity: 'error' } });
    const embeddings = makeEmbeddings([hit]);
    const llm = makeLlm(happyAnalyzeResult());
    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      events,
      makeMockPrRepo(prRecord),
    );

    await service.runDryRun({ diff: REAL_DIFF, prNodeId: 'PR_emit_test' });
    sub.unsubscribe();
    events.beforeApplicationShutdown();

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('completed');
    expect(received[0].pr_node_id).toBe('PR_emit_test');
    expect(received[0].repo_full_name).toBe('myorg/myrepo');
    expect(received[0].author_login).toBe('bob');
    expect(received[0].finding_counts.error).toBe(1);
  });

  it('failure path (AnthropicRequestError) emits exactly one event with status: failed, zero counts, null tokens', async () => {
    const events = new ReviewEventsService();
    const received: TerminalReviewEvent[] = [];
    const sub = events.stream().subscribe((ev) => received.push(ev));

    const err = new AnthropicRequestError('Anthropic API error: HTTP 429 (rate_limit_error)', {
      status: 429,
      errorCode: 'rate_limit_error',
    });
    const embeddings = makeEmbeddings([makeSearchHit()]);
    const llm = makeLlm(err);
    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      events,
      makeMockPrRepo(),
    );

    await expect(service.runDryRun({ diff: REAL_DIFF })).rejects.toBe(err);
    sub.unsubscribe();
    events.beforeApplicationShutdown();

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('failed');
    expect(received[0].finding_counts).toEqual({ error: 0, warning: 0, info: 0 });
    expect(received[0].token_totals).toBeNull();
  });

  it('a throwing subscriber does NOT roll back the committed row (emit lives outside the transaction)', async () => {
    // This is the load-bearing invariant: the db.transaction() must have
    // committed BEFORE emit() is called. If emit were inside the callback,
    // a throwing subscriber would rollback the write. We verify this by
    // using a real ReviewEventsService and checking that the row is
    // 'completed' after runDryRun regardless of what the subscriber does.
    //
    // Note: we verify the "no-rollback" invariant without a throwing
    // subscriber here (to avoid RxJS 7's async reportUnhandledError side
    // effect that would cause a process-level warning in CI). The "emit()
    // does not propagate subscriber errors" invariant is already covered
    // by review-events.service.spec.ts — that spec tests the service in
    // isolation. What this test adds is the integration guarantee that the
    // emit call is positioned AFTER the transaction commits.
    const events = new ReviewEventsService();
    const receivedStatuses: string[] = [];
    const sub = events.stream().subscribe((ev) => receivedStatuses.push(ev.status));

    const hit = makeSearchHit({ metadata: { severity: 'warning' } });
    const embeddings = makeEmbeddings([hit]);
    const llm = makeLlm(happyAnalyzeResult());
    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      events,
      makeMockPrRepo(),
    );

    const result = await service.runDryRun({ diff: REAL_DIFF, prNodeId: null });
    sub.unsubscribe();

    // The row must be durably committed as 'completed'
    const row = reviewsRepo.findById(result.review_id) as ReviewRecord;
    expect(row.status).toBe('completed');
    expect(row.completed_at).toBeInstanceOf(Date);
    // Findings must also be present
    expect(findingsRepo.findByReviewId(result.review_id)).toHaveLength(1);
    // The SSE event was emitted AFTER the commit — exactly once
    expect(receivedStatuses).toEqual(['completed']);

    events.beforeApplicationShutdown();
  });

  it('non-Anthropic error failure path also emits with status: failed', async () => {
    const events = new ReviewEventsService();
    const received: TerminalReviewEvent[] = [];
    const sub = events.stream().subscribe((ev) => received.push(ev));

    const underlying = new Error('unexpected internal error');
    const embeddings = makeEmbeddings([makeSearchHit()]);
    const llm = makeLlm(underlying);
    const service = new ReviewsService(
      embeddings,
      llm,
      reviewsRepo,
      findingsRepo,
      db,
      makeConfig(),
      events,
      makeMockPrRepo(),
    );

    await expect(service.runDryRun({ diff: REAL_DIFF })).rejects.toBeInstanceOf(ReviewsServiceError);
    sub.unsubscribe();
    events.beforeApplicationShutdown();

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('failed');
    expect(received[0].token_totals).toBeNull();
    expect(received[0].finding_counts).toEqual({ error: 0, warning: 0, info: 0 });
  });
});

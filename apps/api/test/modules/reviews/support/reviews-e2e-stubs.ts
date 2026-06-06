// Shared stubs + helpers for the reviews e2e specs. This is a SUPPORT
// module — it contains NO `describe`/`it`, so the test runner does not
// pick it up directly. Both `reviews.e2e-spec.ts` and
// `reviews.processor.e2e-spec.ts` import from here so the ~250-line
// stub surface lives in exactly one place.
//
// The stubs are intentionally offline-deterministic: a bag-of-words
// embedding provider, an in-memory cosine vector store, and a scripted
// LLM reviewer. Together they let the e2e specs boot the full review
// pipeline against real SQLite repositories with no Voyage / Chroma /
// Anthropic calls.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IEmbeddingProvider,
} from '@/modules/embeddings/types/embedding-provider';
import {
  IVectorStore,
  VectorStoreHit,
  VectorStoreItem,
  VectorStoreQueryOptions,
} from '@/modules/embeddings/types/vector-store';
import {
  AnalyzeDiffInput,
  AnalyzeDiffResult,
  Finding,
  ILlmReviewer,
  PROMPT_AND_TOOL_VERSION,
} from '@/modules/reviews/types/llm-reviewer';
import { LlmRequestError } from '@/infrastructure/llm';
import { ToolCallRecord } from '@/modules/reviews/types/review.types';
import { IRepoContextProvider } from '@/modules/reviews/types/repo-context-provider';

export const STUB_DIMENSION = 64;

export class StubEmbeddingProvider implements IEmbeddingProvider {
  readonly modelName = 'stub-embedding';
  readonly dimension = STUB_DIMENSION;
  async embedDocuments(texts: string[]) {
    return {
      vectors: texts.map((t) => this.embed(t)),
      tokensUsed: texts.reduce((sum, t) => sum + t.length, 0),
    };
  }
  async embedQuery(text: string) {
    return { vector: this.embed(text), tokensUsed: text.length };
  }
  private embed(text: string): number[] {
    const v = new Array(STUB_DIMENSION).fill(0) as number[];
    const preNormalized = text
      .toLowerCase()
      .replace(/===/g, ' tk_streq ')
      .replace(/!==/g, ' tk_strneq ')
      .replace(/==/g, ' tk_eqeq ')
      .replace(/!=/g, ' tk_neq ');
    const tokens = preNormalized
      .replace(/[^a-z0-9_]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 0);
    for (const tok of tokens) v[hashToken(tok) % STUB_DIMENSION] += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm === 0) return v;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }
}

export function hashToken(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class StubVectorStore implements IVectorStore {
  private items = new Map<string, VectorStoreItem>();
  async ensureCollection() {
    /* no-op */
  }
  async upsert(items: VectorStoreItem[]) {
    for (const item of items) this.items.set(item.id, item);
  }
  async query(opts: VectorStoreQueryOptions): Promise<VectorStoreHit[]> {
    const hits: VectorStoreHit[] = [];
    for (const item of this.items.values()) {
      hits.push({
        id: item.id,
        score: cosineSimilarity(opts.embedding, item.embedding),
        document: item.document,
        metadata: item.metadata,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.k);
  }
  async deleteAll() {
    this.items.clear();
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const n = Math.sqrt(na) * Math.sqrt(nb);
  return n === 0 ? 0 : dot / n;
}

// Deterministic stub LLM. Echoes back one finding for every retrieved
// rule whose rule_id is in `expectedTriggers` AND which appears in the
// diff text (the diff contains the rule's vocabulary by construction —
// see test/fixtures/diffs/README.md). Default behavior emits a finding
// for every retrieved rule (lets the happy-path tests assert against a
// single matched rule); set `mode` to other behaviors for specific
// scenarios.
//
// The stub never emits `severity` — matches the production adapter
// contract from U4.
export type StubMode =
  | 'echo-first-only'
  | 'echo-all'
  | 'echo-none'
  | 'throw-rate-limit'
  | 'delay-then-echo'
  | 'multi-turn-script'
  | 'throw-turn-cap-exceeded';

// One step of a scripted multi-turn run. `tool` steps invoke the
// configured `input.repoContext` and record the result as a
// ToolCallRecord (with is_error reflecting the provider response).
// `emit` is the terminal step — the stub returns its findings as the
// final result.
export type ScriptedTurn =
  | {
      kind: 'tool';
      name: 'fetch_related_file' | 'fetch_function_definition' | 'fetch_prior_review';
      input: Record<string, unknown>;
    }
  | { kind: 'emit'; findings: Finding[] };

export class StubLlmReviewer implements ILlmReviewer {
  public mode: StubMode = 'echo-first-only';
  public delayMs = 0;
  public lastInput?: AnalyzeDiffInput;
  public script: ScriptedTurn[] = [];
  // Pre-built error used by 'throw-turn-cap-exceeded' so the
  // turn-cap scenario can assert against a specific
  // turnCount + toolCalls shape.
  public turnCapToolCalls: ToolCallRecord[] = [];

  async analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    this.lastInput = input;
    if (this.mode === 'throw-rate-limit') {
      throw new LlmRequestError('Anthropic API error: HTTP 429 (rate_limit_error)', {
        status: 429,
        errorCode: 'rate_limit_error',
      });
    }
    if (this.mode === 'throw-turn-cap-exceeded') {
      throw new LlmRequestError(
        'Agent loop exceeded 6 turns without emit_finding',
        {
          status: 200,
          errorCode: 'turn_cap_exceeded',
          turnCount: 6,
          toolCalls: this.turnCapToolCalls,
        },
      );
    }
    if (this.mode === 'multi-turn-script') {
      return this.runScript(input);
    }
    if (this.mode === 'delay-then-echo' && this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    const rulesToFlag =
      this.mode === 'echo-none'
        ? []
        : this.mode === 'echo-all' || this.mode === 'delay-then-echo'
          ? input.rules
          : input.rules.slice(0, 1);

    return {
      findings: rulesToFlag.map((rule) => ({
        rule_id: rule.rule_id,
        title: rule.title ?? rule.rule_id,
        message: `Flagged by stub: ${rule.rule_id}`,
        location_hint: null,
        citation: null,
      })),
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      model: 'stub-model',
      promptVersion: PROMPT_AND_TOOL_VERSION,
      // Degenerate single-turn case. The 'multi-turn-script' mode
      // below walks a scripted sequence for the multi-turn scenarios.
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
    };
  }

  // Walks the configured script, invoking `input.repoContext` on tool
  // steps and accumulating a ToolCallRecord per step. The terminal
  // 'emit' step's findings flow through to the result (with
  // hallucination filtering — drop any rule_id not in input.rules).
  private async runScript(input: AnalyzeDiffInput): Promise<AnalyzeDiffResult> {
    const repoContext = input.repoContext;
    const inputRuleIds = new Set(input.rules.map((r) => r.rule_id));
    const toolCalls: ToolCallRecord[] = [];
    let turn = 0;
    let emittedFindings: Finding[] = [];

    for (const step of this.script) {
      turn += 1;
      if (step.kind === 'tool') {
        const dispatch = await this.dispatchScriptedTool(step, repoContext);
        toolCalls.push({
          turn_idx: turn,
          tool_name: step.name,
          input_hash: hashScriptInput(step.input),
          result_bytes: dispatch.bytes,
          latency_ms: 0,
          stop_reason: 'tool_use',
          ...(dispatch.isError ? { is_error: true } : {}),
        });
        continue;
      }
      // emit step — the terminal turn. Filter hallucinations.
      emittedFindings = step.findings.filter((f) => inputRuleIds.has(f.rule_id));
      toolCalls.push({
        turn_idx: turn,
        tool_name: 'emit_finding',
        input_hash: hashScriptInput({ findings: step.findings }),
        result_bytes: 0,
        latency_ms: 0,
        stop_reason: 'tool_use',
      });
      break;
    }

    return {
      findings: emittedFindings,
      usage: {
        input_tokens: 1500 * turn,
        output_tokens: 100 * turn,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      model: 'stub-model',
      promptVersion: PROMPT_AND_TOOL_VERSION,
      turnCount: turn,
      toolCalls,
      hallucinatedFindingCount: 0,
      cacheHitCount: 0,
    };
  }

  private async dispatchScriptedTool(
    step: Extract<ScriptedTurn, { kind: 'tool' }>,
    repoContext: IRepoContextProvider | undefined,
  ): Promise<{ bytes: number; isError: boolean }> {
    if (!repoContext) {
      return { bytes: 32, isError: true };
    }
    if (step.name === 'fetch_related_file') {
      const result = await repoContext.fetchFile(
        (step.input.path as string) ?? '',
      );
      return {
        bytes: result.ok ? Buffer.byteLength(result.content, 'utf8') : 64,
        isError: !result.ok,
      };
    }
    if (step.name === 'fetch_function_definition') {
      const result = await repoContext.fetchFunctionDefinition(
        (step.input.name as string) ?? '',
        step.input.file as string | undefined,
      );
      return {
        bytes: result.ok ? Buffer.byteLength(result.content, 'utf8') : 64,
        isError: !result.ok,
      };
    }
    // fetch_prior_review
    const result = await repoContext.fetchPriorReview(step.input as Parameters<IRepoContextProvider['fetchPriorReview']>[0]);
    return {
      bytes: result.ok ? Buffer.byteLength(JSON.stringify(result.content), 'utf8') : 64,
      isError: !result.ok,
    };
  }
}

export function hashScriptInput(input: unknown): string {
  // Reproducible-but-cheap hash for the per-turn record. Doesn't need
  // to match the production sha256 algorithm — these are stub-side
  // assertions.
  return Buffer.from(JSON.stringify(input)).toString('hex').slice(0, 16).padEnd(16, '0');
}

export function loadFixture(name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'fixtures', 'diffs', name),
    'utf8',
  );
}

// Env snapshot / restore — beforeAll / afterAll pattern used across
// the e2e specs. ConfigService reads process.env in its constructor
// and ReviewsModule.forRoot() reads it at decorator evaluation time,
// so test env values must be set BEFORE
// `Test.createTestingModule({ imports: [makeTestModule()] })`.
export type EnvState = Record<string, string | undefined>;
export function snapshotEnv(keys: string[]): EnvState {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}
export function restoreEnv(snapshot: EnvState): void {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

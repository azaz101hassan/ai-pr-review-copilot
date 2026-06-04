/**
 * Gated capture entry point — boots a lean Nest context, loops the
 * corpus calling `analyzeDiff` directly, runs the faithfulness judge
 * per finding, and writes committed recordings.
 *
 * Gated behind RUN_EVAL_CAPTURE=true (or RUN_ANTHROPIC_INTEGRATION=true).
 * Default off — never runs in CI.
 *
 * Usage:
 *   npm run eval:capture --workspace apps/api
 *
 * Pattern: follows `apps/api/src/modules/reviews/scripts/dry-run.ts`
 * (dotenv first, NestFactory.createApplicationContext, require.main === module).
 */

import 'dotenv/config';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import Anthropic from '@anthropic-ai/sdk';

import { ConfigService } from '@/config';
import { EmbeddingsService } from '@/modules/embeddings';
import type { SearchHit } from '@/modules/embeddings';
import { LLM_REVIEWER } from '@/modules/reviews/types/llm-reviewer';
import type {
  AnalyzeDiffInput,
  AnalyzeDiffResult,
  ILlmReviewer,
} from '@/modules/reviews/types/llm-reviewer';
import { PROMPT_AND_TOOL_VERSION } from '@/modules/reviews/types/llm-reviewer';
import { SessionRateLimitGuard } from '@/infrastructure/anthropic';
import { LlmRequestError } from '@/infrastructure/llm';
import { FilesystemRepoContextProvider } from '@/infrastructure/repo-context';
import { VoyageRequestError } from '@/infrastructure/voyage/voyage-embedding.provider';
import { CorpusLoader } from '@/modules/embeddings/helpers/corpus-loader';
import type { NormalizedChunk } from '@/modules/embeddings/helpers/corpus-loader';

import { loadManifest, computeExpectedSetHash } from './manifest';
import type { LoadedManifestEntry, FixtureCategory } from './manifest';
import { writeRecording } from './recording';
import type {
  Recording,
  EmittedRecording,
  ThrewRecording,
  RecordedFinding,
  RecordingProvenance,
  FaithfulnessResult,
} from './recording';
import { judgeFinding } from './faithfulness-judge';
import { FAITHFULNESS_JUDGE_VERSION } from './faithfulness-judge.prompt';
import { EvalCaptureModule } from './eval-capture.module';
import {
  computeTrackedPathsHash,
  getTrackedPathsForProvider,
} from './staleness';

// ── Constants ──────────────────────────────────────────────────────────

/** Pinned seed corpus version. 43 chunks = 33 airbnb + 10 team-standards. */
export const SEED_CORPUS_VERSION = 'v1';

/**
 * Returns the configured model id for the active LLM provider.
 * Used to populate provenance on failure / pre-result paths where no
 * SDK response is available yet. Once `analyzeDiff` returns, always
 * prefer `result.model` (the id the provider actually used) over this.
 */
export function resolveActiveModel(config: ConfigService): string {
  return config.activeModel();
}

export const EXPECTED_CHUNK_COUNT = 43;

/** Sentinel in manifest's injectedRules that means "use the full corpus". */
export const FULL_CORPUS_MARKER = '__FULL_CORPUS__';

/** Default judge model. */
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/** Delay between fixture captures to respect Voyage free-tier rate limits. */
const INTER_FIXTURE_DELAY_MS = Number(process.env.CAPTURE_DELAY_MS) || 3_000;

const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 10_000;

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit =
        err instanceof VoyageRequestError && err.status === 429;
      if (!isRateLimit || attempt === RETRY_MAX_ATTEMPTS) throw err;
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `  [retry] ${label}: Voyage 429 — waiting ${delay / 1000}s (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

// ── Types ──────────────────────────────────────────────────────────────

/** Rule shape passed to `analyzeDiff`. */
export interface AnalyzeDiffRule {
  rule_id: string;
  source: string;
  document: string;
  title?: string;
}

/** Which rule set to use for a fixture. */
export type RuleSetResolution =
  | { kind: 'retrieval' }
  | { kind: 'full-corpus'; rules: AnalyzeDiffRule[] }
  | { kind: 'injected'; rules: AnalyzeDiffRule[] };

// ── Exported pure helpers (tested in capture.spec.ts) ──────────────────

/**
 * Determine the rule-set strategy for a given fixture category.
 *
 * - `violating`   -> retrieval (real search)
 * - `clean`       -> full corpus (all 43 rules injected)
 * - `agent-loop`  -> injected (manifest's declared rule set)
 * - `suppression` -> injected (manifest's declared rule set)
 */
export function resolveRuleSet(
  entry: LoadedManifestEntry,
  allChunks: NormalizedChunk[],
): RuleSetResolution {
  switch (entry.category) {
    case 'violating':
      return { kind: 'retrieval' };

    case 'clean':
      return {
        kind: 'full-corpus',
        rules: chunksToRules(allChunks),
      };

    case 'agent-loop':
    case 'suppression': {
      const injectedIds = entry.injectedRules ?? [];
      const matched = allChunks.filter((c) => injectedIds.includes(c.rule_id));
      return {
        kind: 'injected',
        rules: chunksToRules(matched),
      };
    }
  }
}

/**
 * Build an AnalyzeDiffRule[] from search hits (violating category).
 * Sorts by `${source}:${rule_id}` for prompt-cache stability.
 */
export function searchHitsToSortedRules(hits: SearchHit[]): AnalyzeDiffRule[] {
  const sorted = [...hits].sort((a, b) =>
    `${a.source}:${a.rule_id}`.localeCompare(`${b.source}:${b.rule_id}`),
  );
  return sorted.map((hit) => ({
    rule_id: hit.rule_id,
    source: hit.source,
    document: hit.document,
    title: hit.title,
  }));
}

/**
 * Assemble an emitted recording from an AnalyzeDiffResult + judge verdicts.
 */
export function assembleEmittedRecording(
  fixtureId: string,
  result: AnalyzeDiffResult,
  judgments: FaithfulnessResult[],
  ruleSet: string[],
  provenance: RecordingProvenance,
  extras?: { priorReviewSnapshot?: unknown },
): EmittedRecording {
  const findings: RecordedFinding[] = result.findings.map((f, i) => ({
    rule_id: f.rule_id,
    title: f.title,
    message: f.message,
    location_hint: f.location_hint ?? null,
    citation: f.citation ?? null,
    faithfulness: judgments[i] ?? { score: null, claims: [] },
  }));

  const recording: EmittedRecording = {
    status: 'emitted',
    fixtureId,
    findings,
    ruleSet: [...ruleSet].sort(),
    provenance,
  };

  if (extras?.priorReviewSnapshot !== undefined) {
    recording.priorReviewSnapshot = extras.priorReviewSnapshot;
  }

  return recording;
}

/**
 * Assemble a threw recording from an LlmRequestError.
 */
export function assembleThrewRecording(
  fixtureId: string,
  error: LlmRequestError,
  provenance: RecordingProvenance,
): ThrewRecording {
  return {
    status: 'threw',
    fixtureId,
    error: {
      errorCode: error.errorCode ?? 'llm_error',
      turnCount: error.turnCount ?? null,
      toolCalls: error.toolCalls ?? null,
    },
    provenance,
  };
}

/**
 * Assemble a threw recording from a generic (pre-loop) error.
 */
export function assembleThrewRecordingFromGenericError(
  fixtureId: string,
  errorCode: string,
  provenance: RecordingProvenance,
): ThrewRecording {
  return {
    status: 'threw',
    fixtureId,
    error: {
      errorCode,
      turnCount: null,
      toolCalls: null,
    },
    provenance,
  };
}

/**
 * Preflight: assert seed corpus version matches the expected chunk count.
 */
export function assertCorpusVersion(
  chunks: NormalizedChunk[],
  expectedCount: number = EXPECTED_CHUNK_COUNT,
): void {
  if (chunks.length !== expectedCount) {
    throw new Error(
      `Seed corpus version mismatch: expected ${expectedCount} chunks ` +
        `(seedCorpusVersion: ${SEED_CORPUS_VERSION}), found ${chunks.length}. ` +
        `The corpus may have changed since the last capture.`,
    );
  }
}

/**
 * Preflight: assert no cross-source rule_id slug collision.
 * The matching identity is bare `rule_id`, so a collision across sources
 * would cause mis-scoring.
 */
export function assertNoRuleIdCollisions(chunks: NormalizedChunk[]): void {
  const seen = new Map<string, string>(); // rule_id -> source_id
  for (const chunk of chunks) {
    const prev = seen.get(chunk.rule_id);
    if (prev && prev !== chunk.source_id) {
      throw new Error(
        `Cross-source rule_id collision: "${chunk.rule_id}" appears in ` +
          `both "${prev}" and "${chunk.source_id}". Bare rule_id matching ` +
          `would mis-score. Fix the seed corpus before capturing.`,
      );
    }
    seen.set(chunk.rule_id, chunk.source_id);
  }
}

/**
 * Parse the optional `--only` CLI flag from process argv. Accepts both
 * `--only foo,bar` and `--only=foo,bar`. Returns a list of fixture ids;
 * empty when the flag is absent. Throws on `--only` with no value, so
 * a typo (`--only --debug`) fails loudly rather than capturing nothing.
 *
 * The flag is for targeted re-capture during iteration — without it,
 * tuning a single fixture forces a re-record of the entire corpus.
 */
export function parseOnlyFlag(argv: readonly string[]): string[] {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only') {
      raw = argv[i + 1];
      break;
    }
    if (arg.startsWith('--only=')) {
      raw = arg.slice('--only='.length);
      break;
    }
  }
  // Flag not present at all → silently no-op.
  if (raw === undefined) {
    // Distinguish "flag absent" from "flag present with no value": only
    // the latter is an error. We need to re-scan to know.
    const present = argv.some((a) => a === '--only' || a.startsWith('--only='));
    if (!present) return [];
    throw new Error('--only requires a value (comma-separated fixture ids)');
  }
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new Error('--only requires a value (comma-separated fixture ids)');
  }
  return tokens;
}

/**
 * Filter manifest entries down to the given fixture ids, preserving the
 * manifest's source-order. Reports unknown ids back to the caller so
 * `main()` can fail loudly on a typo'd `--only foo,brvo` rather than
 * silently capturing only the recognised ids.
 *
 * Deduplicates repeated ids; missing-id detection is also deduped.
 */
export function filterEntriesByFixtureIds(
  entries: readonly LoadedManifestEntry[],
  ids: readonly string[],
): { filtered: LoadedManifestEntry[]; missing: string[] } {
  if (ids.length === 0) {
    return { filtered: [...entries], missing: [] };
  }
  const wanted = new Set(ids);
  const filtered = entries.filter((e) => wanted.has(e.fixtureId));
  const present = new Set(filtered.map((e) => e.fixtureId));
  // Iterate `ids` (not the Set) so missing ids are reported in caller's
  // order, deduped.
  const missingSeen = new Set<string>();
  const missing: string[] = [];
  for (const id of ids) {
    if (!present.has(id) && !missingSeen.has(id)) {
      missingSeen.add(id);
      missing.push(id);
    }
  }
  return { filtered, missing };
}

// ── Internal helpers ───────────────────────────────────────────────────

function chunksToRules(chunks: NormalizedChunk[]): AnalyzeDiffRule[] {
  return chunks.map((c) => ({
    rule_id: c.rule_id,
    source: c.source_id,
    document: c.body,
    title: c.title,
  }));
}

function getGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function resolveFixturePath(entry: LoadedManifestEntry, apiRoot: string): string {
  // Manifest paths are relative to apps/api/, e.g. "test/fixtures/diffs/..."
  const resolved = path.resolve(apiRoot, entry.path);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Fixture file not found: "${entry.path}" (resolved to "${resolved}")`,
    );
  }
  return resolved;
}

function resolveRepoDir(entry: LoadedManifestEntry, apiRoot: string): string | undefined {
  if (!entry.needsRepoContext) return undefined;
  // Convention: .repo/ directory sits next to the .patch file, named
  // <fixture-stem>.repo/. E.g. silent-signature-change.patch ->
  // silent-signature-change.repo/
  const patchPath = path.resolve(apiRoot, entry.path);
  const repoDir = patchPath.replace(/\.patch$/, '.repo');
  if (!fs.existsSync(repoDir)) {
    throw new Error(
      `Fixture "${entry.fixtureId}" declares needsRepoContext=true but ` +
        `"${repoDir}" does not exist.`,
    );
  }
  return repoDir;
}

// ── Main capture loop ──────────────────────────────────────────────────

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[eval:capture] starting...');

  // Resolve paths relative to apps/api/
  const apiRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const evalFixturesDir = path.resolve(apiRoot, 'test', 'fixtures', 'eval');
  const manifestPath = path.resolve(evalFixturesDir, 'expectations.manifest.json');

  // ── 1. Boot lean Nest context ──────────────────────────────────────

  const app = await NestFactory.createApplicationContext(EvalCaptureModule, {
    logger: ['error', 'warn'],
  });

  try {
    const embeddings = app.get(EmbeddingsService);
    const llm = app.get<ILlmReviewer>(LLM_REVIEWER);
    const config = app.get(ConfigService);

    // eslint-disable-next-line no-console
    console.log(`[eval:capture] model: ${resolveActiveModel(config)}`);

    // ── 2. Preflight checks ────────────────────────────────────────

    // 2a. Chroma reachability
    try {
      await withRetry('preflight', () =>
        embeddings.search('preflight-test-query', { k: 1 }),
      );
      // eslint-disable-next-line no-console
      console.log('[eval:capture] preflight: Chroma reachable');
    } catch (err) {
      throw new Error(
        `Preflight failed: Chroma is not reachable. ` +
          `Ensure Chroma is running and seeded. Error: ${err instanceof Error ? err.message : err}`,
      );
    }

    // 2b. Seed corpus version
    const corpusLoader = new CorpusLoader();
    const corpus = corpusLoader.load();
    assertCorpusVersion(corpus.chunks);
    // eslint-disable-next-line no-console
    console.log(`[eval:capture] preflight: corpus version OK (${corpus.chunks.length} chunks)`);

    // 2c. No cross-source rule_id collisions
    assertNoRuleIdCollisions(corpus.chunks);
    // eslint-disable-next-line no-console
    console.log('[eval:capture] preflight: no rule_id collisions');

    // 2d. Git SHA + provider-aware tracked-paths content hash
    const gitSha = getGitSha();
    // eslint-disable-next-line no-console
    console.log(`[eval:capture] gitSha: ${gitSha}`);
    const repoRoot = path.resolve(apiRoot, '..', '..');
    const activeProvider = config.llmProvider;
    const providerTrackedPaths = getTrackedPathsForProvider(activeProvider);
    const trackedPathsHash = computeTrackedPathsHash(
      repoRoot,
      'HEAD',
      providerTrackedPaths,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[eval:capture] llmProvider=${activeProvider} trackedPathsHash: ${trackedPathsHash || '(unavailable)'}`,
    );

    // ── 3. Load manifest ───────────────────────────────────────────

    const manifest = loadManifest(manifestPath);
    const gatingEntries = manifest.entries.filter((e) => e.gates);
    // eslint-disable-next-line no-console
    console.log(
      `[eval:capture] manifest loaded: ${manifest.entries.length} entries ` +
        `(${gatingEntries.length} gating, ${manifest.entries.length - gatingEntries.length} held-out)`,
    );

    // Optional per-fixture targeting. `--only fixture-a,fixture-b`
    // restricts the loop so iteration on a single fixture doesn't
    // require re-recording the entire corpus.
    const onlyIds = parseOnlyFlag(process.argv);
    let allEntries = manifest.entries;
    if (onlyIds.length > 0) {
      const { filtered, missing } = filterEntriesByFixtureIds(
        manifest.entries,
        onlyIds,
      );
      if (missing.length > 0) {
        throw new Error(
          `--only specified unknown fixture(s): ${missing.join(', ')}. ` +
            `Known ids: ${manifest.entries.map((e) => e.fixtureId).join(', ')}`,
        );
      }
      allEntries = filtered;
      // eslint-disable-next-line no-console
      console.log(
        `[eval:capture] --only filter applied: capturing ${filtered.length} ` +
          `of ${manifest.entries.length} fixtures ` +
          `(${filtered.map((e) => e.fixtureId).join(', ')})`,
      );
    }

    // ── 4. Rate limit guard ────────────────────────────────────────

    // Clean fixtures do A/B (2 calls each), so budget needs headroom.
    // Count: 6 violating + 1 agent-loop + 1 suppression + 5 clean * 2 = 18
    // Plus judge calls: ~18 * avg 2 findings = ~36 judge calls.
    // Plus a few external-validity fixtures bring the total to ~60-80.
    //
    // The rolling-window cap (maxCalls/windowMs) is defensive — it
    // catches `jest --watch` accidents that fan out to the real API.
    // The previous 10/60s threshold throttled the legitimate full
    // capture before it could finish (each fixture issues 2-4 calls
    // back-to-back). 30/60s is high enough to let the capture flow
    // without losing the runaway-loop signal.
    const sessionGuard = new SessionRateLimitGuard({
      windowMs: 60_000,
      maxCalls: 30, // rolling window
      budgetCap: 80, // corpus-wide budget
    });

    // ── 5. Anthropic client for the judge ──────────────────────────

    const anthropicClient = new Anthropic({
      apiKey: config.anthropicApiKey,
    });

    // ── 6. Per-fixture loop ────────────────────────────────────────

    const recordings: Recording[] = [];

    for (const entry of allEntries) {
      // eslint-disable-next-line no-console
      console.log(
        `\n[eval:capture] fixture: ${entry.fixtureId} (${entry.category})`,
      );

      const fixturePath = resolveFixturePath(entry, apiRoot);
      const diff = fs.readFileSync(fixturePath, 'utf-8');

      // The provenance model is a best-effort placeholder for the failure
      // path (assembleThrewRecording) where no SDK response is available.
      // For successful runs, assembleEmittedRecording spreads the actual
      // model id from result.model over this value before writing.
      const provenance: RecordingProvenance = {
        promptVersion: PROMPT_AND_TOOL_VERSION,
        model: resolveActiveModel(config),
        judgeModel: DEFAULT_JUDGE_MODEL,
        judgePromptVersion: FAITHFULNESS_JUDGE_VERSION,
        seedCorpusVersion: SEED_CORPUS_VERSION,
        expectedSetHash: computeExpectedSetHash(entry.expected),
        gitSha,
        ...(trackedPathsHash ? { trackedPathsHash } : {}),
        llmProvider: activeProvider,
      };

      if (entry.category === 'clean') {
        // A/B capture: full corpus + real retrieval top-10
        await captureCleanFixture(
          entry,
          diff,
          corpus.chunks,
          embeddings,
          llm,
          anthropicClient,
          sessionGuard,
          provenance,
          evalFixturesDir,
          apiRoot,
          recordings,
        );
      } else {
        await captureFixture(
          entry,
          diff,
          corpus.chunks,
          embeddings,
          llm,
          anthropicClient,
          sessionGuard,
          provenance,
          evalFixturesDir,
          apiRoot,
          recordings,
        );
      }

      // Respect Voyage free-tier rate limits between fixtures
      if (INTER_FIXTURE_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, INTER_FIXTURE_DELAY_MS));
      }
    }

    // ── 7. Write summary ───────────────────────────────────────────

    const emitted = recordings.filter((r) => r.status === 'emitted').length;
    const threw = recordings.filter((r) => r.status === 'threw').length;
    // eslint-disable-next-line no-console
    console.log(
      `\n[eval:capture] done: ${recordings.length} recordings ` +
        `(${emitted} emitted, ${threw} threw)`,
    );
  } finally {
    await app.close();
  }
}

async function captureFixture(
  entry: LoadedManifestEntry,
  diff: string,
  allChunks: NormalizedChunk[],
  embeddings: EmbeddingsService,
  llm: ILlmReviewer,
  anthropicClient: Anthropic,
  sessionGuard: SessionRateLimitGuard,
  provenance: RecordingProvenance,
  evalFixturesDir: string,
  apiRoot: string,
  recordings: Recording[],
): Promise<void> {
  const resolution = resolveRuleSet(entry, allChunks);
  let rules: AnalyzeDiffRule[];
  let ruleSet: string[];

  if (resolution.kind === 'retrieval') {
    // Violating: real retrieval
    const hits = await withRetry(entry.fixtureId, () => embeddings.search(diff));
    rules = searchHitsToSortedRules(hits);
    ruleSet = rules.map((r) => r.rule_id);
  } else {
    rules = resolution.rules;
    ruleSet = rules.map((r) => r.rule_id);
  }

  // eslint-disable-next-line no-console
  console.log(`  rule set (${ruleSet.length}): ${ruleSet.join(', ')}`);

  // Repo context for .repo fixtures
  const repoDir = resolveRepoDir(entry, apiRoot);
  const repoContext = repoDir
    ? new FilesystemRepoContextProvider(repoDir)
    : undefined;

  const input: AnalyzeDiffInput = { diff, rules, repoContext };

  try {
    sessionGuard.acquire();
    const result = await llm.analyzeDiff(input);

    // eslint-disable-next-line no-console
    console.log(
      `  findings: ${result.findings.length}, turns: ${result.turnCount}`,
    );

    // Run faithfulness judge over each finding
    const judgments = await judgeFindings(
      result,
      rules,
      diff,
      anthropicClient,
      sessionGuard,
    );

    // Suppression enrichment: read reviews.json independently
    let priorReviewSnapshot: unknown;
    if (entry.category === 'suppression' && repoDir) {
      const reviewsPath = path.join(repoDir, 'reviews.json');
      if (fs.existsSync(reviewsPath)) {
        priorReviewSnapshot = JSON.parse(
          fs.readFileSync(reviewsPath, 'utf-8'),
        );
      }
    }

    const recording = assembleEmittedRecording(
      entry.fixtureId,
      result,
      judgments,
      ruleSet,
      // Stamp the actual model id echoed by the provider SDK so the
      // recording captures what really ran, not the config placeholder.
      { ...provenance, model: result.model },
      { priorReviewSnapshot },
    );

    const filePath = writeRecording(evalFixturesDir, recording);
    recordings.push(recording);
    // eslint-disable-next-line no-console
    console.log(`  -> ${path.relative(apiRoot, filePath)}`);
  } catch (err) {
    if (err instanceof LlmRequestError) {
      // eslint-disable-next-line no-console
      console.log(
        `  THREW: ${err.errorCode ?? 'unknown'} (turnCount=${err.turnCount ?? 'n/a'})`,
      );
      const recording = assembleThrewRecording(
        entry.fixtureId,
        err,
        provenance,
      );
      const filePath = writeRecording(evalFixturesDir, recording);
      recordings.push(recording);
      // eslint-disable-next-line no-console
      console.log(`  -> ${path.relative(apiRoot, filePath)}`);
    } else {
      throw err;
    }
  }
}

async function captureCleanFixture(
  entry: LoadedManifestEntry,
  diff: string,
  allChunks: NormalizedChunk[],
  embeddings: EmbeddingsService,
  llm: ILlmReviewer,
  anthropicClient: Anthropic,
  sessionGuard: SessionRateLimitGuard,
  provenance: RecordingProvenance,
  evalFixturesDir: string,
  apiRoot: string,
  recordings: Recording[],
): Promise<void> {
  // A/B capture for clean fixtures:
  // Run A: full 43-rule corpus injected (the headline clean-fixture path)
  // Run B: real retrieval top-10 (production-shape sanity check)

  // ── Run A: full corpus ───────────────────────────────────────────

  // eslint-disable-next-line no-console
  console.log('  [A] full-corpus run...');

  const fullCorpusRules = chunksToRules(allChunks);
  const fullCorpusRuleSet = fullCorpusRules.map((r) => r.rule_id);
  const inputA: AnalyzeDiffInput = { diff, rules: fullCorpusRules };

  try {
    sessionGuard.acquire();
    const resultA = await llm.analyzeDiff(inputA);

    // eslint-disable-next-line no-console
    console.log(
      `  [A] findings: ${resultA.findings.length}, turns: ${resultA.turnCount}`,
    );

    const judgmentsA = await judgeFindings(
      resultA,
      fullCorpusRules,
      diff,
      anthropicClient,
      sessionGuard,
    );

    const recordingA = assembleEmittedRecording(
      entry.fixtureId,
      resultA,
      judgmentsA,
      fullCorpusRuleSet,
      { ...provenance, model: resultA.model },
    );

    const filePathA = writeRecording(evalFixturesDir, recordingA);
    recordings.push(recordingA);
    // eslint-disable-next-line no-console
    console.log(`  [A] -> ${path.relative(apiRoot, filePathA)}`);
  } catch (err) {
    if (err instanceof LlmRequestError) {
      // eslint-disable-next-line no-console
      console.log(`  [A] THREW: ${err.errorCode ?? 'unknown'}`);
      const recording = assembleThrewRecording(
        entry.fixtureId,
        err,
        provenance,
      );
      writeRecording(evalFixturesDir, recording);
      recordings.push(recording);
    } else {
      throw err;
    }
  }

  // ── Run B: real retrieval top-10 ─────────────────────────────────

  // eslint-disable-next-line no-console
  console.log('  [B] retrieval top-10 run...');

  const hits = await withRetry(`${entry.fixtureId}__top10`, () =>
    embeddings.search(diff),
  );
  const retrievalRules = searchHitsToSortedRules(hits);
  const retrievalRuleSet = retrievalRules.map((r) => r.rule_id);
  const inputB: AnalyzeDiffInput = { diff, rules: retrievalRules };

  const abFixtureId = `${entry.fixtureId}__top10`;
  const abProvenance: RecordingProvenance = {
    ...provenance,
    expectedSetHash: computeExpectedSetHash(entry.expected),
  };

  try {
    sessionGuard.acquire();
    const resultB = await llm.analyzeDiff(inputB);

    // eslint-disable-next-line no-console
    console.log(
      `  [B] findings: ${resultB.findings.length}, turns: ${resultB.turnCount}`,
    );

    const judgmentsB = await judgeFindings(
      resultB,
      retrievalRules,
      diff,
      anthropicClient,
      sessionGuard,
    );

    const recordingB = assembleEmittedRecording(
      abFixtureId,
      resultB,
      judgmentsB,
      retrievalRuleSet,
      { ...abProvenance, model: resultB.model },
    );

    const filePathB = writeRecording(evalFixturesDir, recordingB);
    recordings.push(recordingB);
    // eslint-disable-next-line no-console
    console.log(`  [B] -> ${path.relative(apiRoot, filePathB)}`);
  } catch (err) {
    if (err instanceof LlmRequestError) {
      // eslint-disable-next-line no-console
      console.log(`  [B] THREW: ${err.errorCode ?? 'unknown'}`);
      const recording = assembleThrewRecording(
        abFixtureId,
        err,
        abProvenance,
      );
      writeRecording(evalFixturesDir, recording);
      recordings.push(recording);
    } else {
      throw err;
    }
  }
}

async function judgeFindings(
  result: AnalyzeDiffResult,
  rules: AnalyzeDiffRule[],
  diff: string,
  client: Anthropic,
  sessionGuard: SessionRateLimitGuard,
): Promise<FaithfulnessResult[]> {
  const judgments: FaithfulnessResult[] = [];

  for (const finding of result.findings) {
    // Find the rule document for the cited rule_id
    const matchedRule = rules.find((r) => r.rule_id === finding.rule_id);
    const ruleDocText = matchedRule?.document ?? '';

    try {
      sessionGuard.acquire();
      const verdict = await judgeFinding({
        finding: {
          rule_id: finding.rule_id,
          title: finding.title,
          message: finding.message,
          location_hint: finding.location_hint,
          citation: finding.citation,
        },
        ruleDocText,
        diff,
        client: client as unknown as Parameters<typeof judgeFinding>[0]['client'],
        model: DEFAULT_JUDGE_MODEL,
      });
      judgments.push(verdict);
    } catch (err) {
      // Judge failure: record as null score with the error in claims
      // eslint-disable-next-line no-console
      console.log(
        `  judge error on finding "${finding.rule_id}": ${err instanceof Error ? err.message : err}`,
      );
      judgments.push({
        score: null,
        claims: [],
      });
    }
  }

  return judgments;
}

// Only call main() when this file is the entry point.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      const errType = err instanceof Error ? err.name : typeof err;
      // eslint-disable-next-line no-console
      console.error(
        `eval:capture failed: ${errType}: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    });
}

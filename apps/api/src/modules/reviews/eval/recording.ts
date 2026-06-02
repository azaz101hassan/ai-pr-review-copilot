/**
 * Recording schema — the contract between `capture.ts` and `score.ts`.
 *
 * A recording is a discriminated union on `status`:
 *   - `emitted`: the reviewer produced findings (possibly zero).
 *   - `threw`:   the reviewer threw an error.
 *
 * Both branches carry a shared provenance block and a fixtureId.
 *
 * Type-only imports from the reviews module's own types/ directory
 * keep the tier dependency rule intact.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type { ToolCallRecord, ReviewErrorCode } from '@/modules/reviews/types/review.types';

// ── Faithfulness verdict on a single claim ──────────────────────────

export type FaithfulnessVerdict = 'supported' | 'not_supported' | 'unclear';

export interface FaithfulnessClaim {
  claim: string;
  kind: string; // e.g. 'rule_restatement', 'diff_assertion' — reserved for future tagging
  reason: string;
  verdict: FaithfulnessVerdict;
}

export interface FaithfulnessResult {
  score: number | null; // null when zero claims (NaN is not JSON-serializable)
  claims: FaithfulnessClaim[];
}

// ── Per-finding entry in an emitted recording ───────────────────────

/**
 * Mirrors `Finding` from `@/modules/reviews/types/llm-reviewer` with
 * an additional `faithfulness` block that the capture step populates
 * via the LLM-as-judge. Fields are duplicated (not re-exported) so
 * the recording schema is self-contained for offline scoring.
 */
export interface RecordedFinding {
  rule_id: string;
  title: string;
  message: string;
  location_hint?: string | null;
  citation?: string | null;
  faithfulness: FaithfulnessResult;
}

// ── Provenance block (shared by both statuses) ──────────────────────

export interface RecordingProvenance {
  promptVersion: string;
  model: string;
  judgeModel: string;
  judgePromptVersion: string;
  seedCorpusVersion: string;
  expectedSetHash: string;
  gitSha: string;
  /**
   * Deterministic hash of the staleness-tracked paths' tree at capture time.
   *
   * The staleness checker prefers this when present so it can detect
   * "tracked content has not changed" without needing the recording's
   * gitSha to be reachable. Squash-merged feature branches leave their
   * original commits orphan on the remote; without this field, fresh CI
   * clones cannot resolve them and the SHA-based fallback throws.
   *
   * Optional for backward compatibility with recordings captured before
   * this field was added. Missing means the checker falls back to the
   * gitSha-based logic.
   */
  trackedPathsHash?: string;
}

// ── Threw branch ────────────────────────────────────────────────────

export interface ThrewPayload {
  errorCode: ReviewErrorCode;
  turnCount: number | null;
  toolCalls: ToolCallRecord[] | null;
}

// ── Discriminated union ─────────────────────────────────────────────

export interface EmittedRecording {
  status: 'emitted';
  fixtureId: string;
  findings: RecordedFinding[];
  /** Sorted set of rule_ids that were retrieved/injected into the prompt. */
  ruleSet: string[];
  provenance: RecordingProvenance;
  /** Optional: for suppression fixtures, the prior-review snapshot. */
  priorReviewSnapshot?: unknown;
}

export interface ThrewRecording {
  status: 'threw';
  fixtureId: string;
  error: ThrewPayload;
  provenance: RecordingProvenance;
}

export type Recording = EmittedRecording | ThrewRecording;

// ── Type guards ─────────────────────────────────────────────────────

export function isEmittedRecording(r: Recording): r is EmittedRecording {
  return r.status === 'emitted';
}

export function isThrewRecording(r: Recording): r is ThrewRecording {
  return r.status === 'threw';
}

// ── I/O helpers ─────────────────────────────────────────────────────

const RECORDINGS_DIR_NAME = 'recordings';

/**
 * Resolve the recordings directory from a base eval fixtures dir.
 * E.g. `<repo>/apps/api/test/fixtures/eval/` -> `.../eval/recordings/`.
 */
function recordingsDir(baseDir: string): string {
  return path.join(baseDir, RECORDINGS_DIR_NAME);
}

function recordingFilename(fixtureId: string): string {
  return `${fixtureId}.recording.json`;
}

/**
 * Write a single recording to disk. One file per fixture.
 */
export function writeRecording(
  baseDir: string,
  recording: Recording,
): string {
  const dir = recordingsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, recordingFilename(recording.fixtureId));
  fs.writeFileSync(filePath, JSON.stringify(recording, null, 2) + '\n', 'utf-8');
  return filePath;
}

/**
 * Read a single recording by fixtureId.
 * Returns null if the file does not exist.
 */
export function readRecording(
  baseDir: string,
  fixtureId: string,
): Recording | null {
  const filePath = path.join(recordingsDir(baseDir), recordingFilename(fixtureId));
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Recording;
}

/**
 * Read all recordings from the recordings directory.
 * Returns an empty array if the directory does not exist.
 */
export function readAllRecordings(baseDir: string): Recording[] {
  const dir = recordingsDir(baseDir);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.recording.json'))
    .sort()
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      return JSON.parse(raw) as Recording;
    });
}

/**
 * Hash a recording's content (used for integrity checks, not for
 * matching). Deterministic: keys are sorted by JSON.stringify.
 */
export function hashRecording(recording: Recording): string {
  const canonical = JSON.stringify(recording);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

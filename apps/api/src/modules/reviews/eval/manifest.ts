/**
 * Expectations manifest — the single source of truth for what the
 * eval harness expects each fixture to produce.
 *
 * The manifest is a JSON array of entries, one per fixture. The loader
 * validates category<->expected coherence and computes stable hashes.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

// ── Types ───────────────────────────────────────────────────────────

export type FixtureCategory =
  | 'violating'
  | 'clean'
  | 'suppression'
  | 'agent-loop';

export interface ManifestEntry {
  fixtureId: string;
  path: string;
  category: FixtureCategory;
  /** Expected bare rule_ids. Empty for clean/suppression. */
  expected: string[];
  needsRepoContext: boolean;
  /** Required for agent-loop; optional for others. */
  injectedRules?: string[];
  /** Whether this fixture gates CI. Defaults to true. */
  gates?: boolean;
}

export interface LoadedManifestEntry extends ManifestEntry {
  /** Stable, order-independent hash of the sorted expected rule_ids. */
  expectedSetHash: string;
  /** gates resolved to a boolean (defaulted). */
  gates: boolean;
}

export interface LoadedManifest {
  entries: LoadedManifestEntry[];
  /** Hash of the full manifest content (for drift detection). */
  manifestVersion: string;
}

// ── Validation errors ───────────────────────────────────────────────

export class ManifestValidationError extends Error {
  constructor(
    public readonly fixtureId: string,
    message: string,
  ) {
    super(`Manifest validation failed for fixture "${fixtureId}": ${message}`);
    this.name = 'ManifestValidationError';
  }
}

// ── Hash computation ────────────────────────────────────────────────

/**
 * Compute a stable, order-independent hash of a set of rule_ids.
 * Sorting ensures that `['a', 'b']` and `['b', 'a']` produce the
 * same hash. Deduplicates before hashing.
 */
export function computeExpectedSetHash(ruleIds: string[]): string {
  const sorted = [...new Set(ruleIds)].sort();
  const payload = sorted.join('\0'); // NUL separator avoids collisions
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Compute a hash of the full manifest content. Used as
 * `manifestVersion` for drift detection.
 */
export function computeManifestVersion(rawContent: string): string {
  return crypto
    .createHash('sha256')
    .update(rawContent)
    .digest('hex');
}

// ── Validation ──────────────────────────────────────────────────────

const VALID_CATEGORIES: ReadonlySet<string> = new Set<FixtureCategory>([
  'violating',
  'clean',
  'suppression',
  'agent-loop',
]);

function validateEntry(entry: ManifestEntry): void {
  // Category must be valid
  if (!VALID_CATEGORIES.has(entry.category)) {
    throw new ManifestValidationError(
      entry.fixtureId,
      `unknown category "${entry.category}"; expected one of: ${[...VALID_CATEGORIES].join(', ')}`,
    );
  }

  // clean / suppression => expected must be empty
  if (
    (entry.category === 'clean' || entry.category === 'suppression') &&
    entry.expected.length > 0
  ) {
    throw new ManifestValidationError(
      entry.fixtureId,
      `category "${entry.category}" requires an empty expected set, but got [${entry.expected.join(', ')}]`,
    );
  }

  // agent-loop => injectedRules must be present and non-empty
  if (entry.category === 'agent-loop') {
    if (!entry.injectedRules || entry.injectedRules.length === 0) {
      throw new ManifestValidationError(
        entry.fixtureId,
        `category "agent-loop" requires a non-empty injectedRules array`,
      );
    }
  }

  // fixtureId must be non-empty
  if (!entry.fixtureId || entry.fixtureId.trim() === '') {
    throw new ManifestValidationError(
      entry.fixtureId || '<empty>',
      `fixtureId must be a non-empty string`,
    );
  }

  // path must be non-empty
  if (!entry.path || entry.path.trim() === '') {
    throw new ManifestValidationError(
      entry.fixtureId,
      `path must be a non-empty string`,
    );
  }
}

// ── Loader ──────────────────────────────────────────────────────────

/**
 * Load and validate the expectations manifest from a JSON file.
 *
 * Validates category<->expected coherence, computes per-fixture
 * `expectedSetHash`, defaults `gates` to true, and computes the
 * overall `manifestVersion`.
 */
export function loadManifest(manifestPath: string): LoadedManifest {
  const rawContent = fs.readFileSync(manifestPath, 'utf-8');
  return loadManifestFromString(rawContent);
}

/**
 * Load and validate the manifest from a raw JSON string.
 * Useful for testing without touching the filesystem.
 */
export function loadManifestFromString(rawContent: string): LoadedManifest {
  const parsed: unknown = JSON.parse(rawContent);

  if (!Array.isArray(parsed)) {
    throw new Error(
      'Manifest must be a JSON array of ManifestEntry objects',
    );
  }

  const entries: LoadedManifestEntry[] = (parsed as ManifestEntry[]).map(
    (raw) => {
      validateEntry(raw);

      return {
        ...raw,
        gates: raw.gates !== false, // default true
        expectedSetHash: computeExpectedSetHash(raw.expected),
      };
    },
  );

  // Check for duplicate fixtureIds
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.fixtureId)) {
      throw new ManifestValidationError(
        entry.fixtureId,
        `duplicate fixtureId`,
      );
    }
    ids.add(entry.fixtureId);
  }

  return {
    entries,
    manifestVersion: computeManifestVersion(rawContent),
  };
}

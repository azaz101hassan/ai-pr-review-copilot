import * as path from 'path';
import {
  loadManifest,
  loadManifestFromString,
  computeExpectedSetHash,
  ManifestValidationError,
} from '@/modules/reviews/eval/manifest';

// ── Helpers ─────────────────────────────────────────────────────────

function minimalViolating(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: 'test-violating',
    path: 'test/fixtures/diffs/test.patch',
    category: 'violating',
    expected: ['no-var'],
    needsRepoContext: false,
    ...overrides,
  };
}

function minimalClean(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: 'test-clean',
    path: 'test/fixtures/diffs/clean.patch',
    category: 'clean',
    expected: [],
    needsRepoContext: false,
    ...overrides,
  };
}

function minimalSuppression(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: 'test-suppression',
    path: 'test/fixtures/diffs/suppression.patch',
    category: 'suppression',
    expected: [],
    needsRepoContext: true,
    ...overrides,
  };
}

function minimalAgentLoop(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: 'test-agent-loop',
    path: 'test/fixtures/diffs/agent-loop.patch',
    category: 'agent-loop',
    expected: ['no-param-reassign'],
    needsRepoContext: true,
    injectedRules: ['no-param-reassign'],
    ...overrides,
  };
}

function toManifestJson(entries: Record<string, unknown>[]): string {
  return JSON.stringify(entries);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('manifest loader', () => {
  describe('happy path: well-formed manifest with all categories', () => {
    it('parses and returns typed entries with expectedSetHash and gates defaulted', () => {
      const raw = toManifestJson([
        minimalViolating(),
        minimalClean(),
        minimalSuppression(),
        minimalAgentLoop(),
      ]);

      const manifest = loadManifestFromString(raw);

      expect(manifest.entries).toHaveLength(4);

      // violating
      const violating = manifest.entries[0];
      expect(violating.category).toBe('violating');
      expect(violating.expected).toEqual(['no-var']);
      expect(violating.gates).toBe(true);
      expect(violating.expectedSetHash).toBeTruthy();

      // clean
      const clean = manifest.entries[1];
      expect(clean.category).toBe('clean');
      expect(clean.expected).toEqual([]);
      expect(clean.gates).toBe(true);

      // suppression
      const suppression = manifest.entries[2];
      expect(suppression.category).toBe('suppression');
      expect(suppression.expected).toEqual([]);

      // agent-loop
      const agentLoop = manifest.entries[3];
      expect(agentLoop.category).toBe('agent-loop');
      expect(agentLoop.injectedRules).toEqual(['no-param-reassign']);
    });

    it('computes a manifestVersion hash', () => {
      const raw = toManifestJson([minimalViolating()]);
      const manifest = loadManifestFromString(raw);
      expect(manifest.manifestVersion).toMatch(/^[0-9a-f]{64}$/);
    });

    it('defaults gates to true when omitted', () => {
      const raw = toManifestJson([minimalViolating()]);
      const manifest = loadManifestFromString(raw);
      expect(manifest.entries[0].gates).toBe(true);
    });

    it('preserves gates: false when set explicitly', () => {
      const raw = toManifestJson([minimalViolating({ gates: false })]);
      const manifest = loadManifestFromString(raw);
      expect(manifest.entries[0].gates).toBe(false);
    });
  });

  describe('category <-> expected coherence', () => {
    it('rejects a clean entry with non-empty expected', () => {
      const raw = toManifestJson([
        minimalClean({ expected: ['some-rule'] }),
      ]);

      expect(() => loadManifestFromString(raw)).toThrow(
        ManifestValidationError,
      );
      expect(() => loadManifestFromString(raw)).toThrow(
        /category "clean" requires an empty expected set/,
      );
    });

    it('rejects a suppression entry with non-empty expected', () => {
      const raw = toManifestJson([
        minimalSuppression({ expected: ['eqeqeq'] }),
      ]);

      expect(() => loadManifestFromString(raw)).toThrow(
        ManifestValidationError,
      );
      expect(() => loadManifestFromString(raw)).toThrow(
        /category "suppression" requires an empty expected set/,
      );
    });

    it('rejects an agent-loop entry missing injectedRules', () => {
      const raw = toManifestJson([
        minimalAgentLoop({ injectedRules: undefined }),
      ]);

      expect(() => loadManifestFromString(raw)).toThrow(
        ManifestValidationError,
      );
      expect(() => loadManifestFromString(raw)).toThrow(
        /category "agent-loop" requires a non-empty injectedRules array/,
      );
    });

    it('rejects an agent-loop entry with empty injectedRules', () => {
      const raw = toManifestJson([
        minimalAgentLoop({ injectedRules: [] }),
      ]);

      expect(() => loadManifestFromString(raw)).toThrow(
        ManifestValidationError,
      );
    });
  });

  describe('duplicate fixtureId detection', () => {
    it('rejects duplicate fixtureIds', () => {
      const raw = toManifestJson([
        minimalViolating({ fixtureId: 'dup' }),
        minimalClean({ fixtureId: 'dup' }),
      ]);

      expect(() => loadManifestFromString(raw)).toThrow(
        ManifestValidationError,
      );
      expect(() => loadManifestFromString(raw)).toThrow(/duplicate fixtureId/);
    });
  });

  describe('non-array input', () => {
    it('rejects a non-array manifest', () => {
      expect(() => loadManifestFromString('{}')).toThrow(
        /Manifest must be a JSON array/,
      );
    });
  });

  describe('loads the real expectations manifest', () => {
    it('loads and validates the committed manifest for all committed fixtures', () => {
      const manifestPath = path.join(
        __dirname,
        '../../../fixtures/eval/expectations.manifest.json',
      );
      const manifest = loadManifest(manifestPath);

      expect(manifest.entries).toHaveLength(18);
      expect(manifest.manifestVersion).toMatch(/^[0-9a-f]{64}$/);

      // Verify the in-repo verbatim external-validity fixtures are present
      // (added alongside the synthetic real-pr-* set to anchor the eval
      // against actual diffs from this repo's own git history).
      const inRepoIds = manifest.entries
        .map((e) => e.fixtureId)
        .filter((id) => id === 'voyage-batching-clean' || id === 'queue-process-env-violation');
      expect(inRepoIds).toEqual(
        expect.arrayContaining([
          'voyage-batching-clean',
          'queue-process-env-violation',
        ]),
      );

      // Verify the multi-rule fixture
      const thinControllers = manifest.entries.find(
        (e) => e.fixtureId === 'thin-controllers-violation',
      );
      expect(thinControllers).toBeDefined();
      expect(thinControllers!.expected).toEqual(
        expect.arrayContaining([
          'thin-controllers',
          'no-crud-on-database-service',
          'repository-pattern',
          'config-service-only',
        ]),
      );
      expect(thinControllers!.expected).toHaveLength(4);

      // Verify the suppression fixture
      const suppression = manifest.entries.find(
        (e) => e.fixtureId === 'dismissed-eqeqeq-rerun',
      );
      expect(suppression).toBeDefined();
      expect(suppression!.category).toBe('suppression');
      expect(suppression!.expected).toEqual([]);

      // Verify the agent-loop fixture
      const agentLoop = manifest.entries.find(
        (e) => e.fixtureId === 'silent-signature-change',
      );
      expect(agentLoop).toBeDefined();
      expect(agentLoop!.category).toBe('agent-loop');
      expect(agentLoop!.injectedRules).toEqual(['no-param-reassign']);
      expect(agentLoop!.needsRepoContext).toBe(true);

      // All 11 violating entries (6 gating + 5 held-out real-PR: 3
      // synthetic + 2 in-repo verbatim).
      const violating = manifest.entries.filter(
        (e) => e.category === 'violating',
      );
      expect(violating).toHaveLength(11);
      const gatingViolating = violating.filter((v) => v.gates);
      expect(gatingViolating).toHaveLength(6);
      const heldOut = violating.filter((v) => !v.gates);
      expect(heldOut).toHaveLength(5);
    });
  });
});

describe('expectedSetHash', () => {
  it('is order-independent: same rules in different order produce the same hash', () => {
    const hash1 = computeExpectedSetHash(['a', 'b', 'c']);
    const hash2 = computeExpectedSetHash(['c', 'a', 'b']);
    const hash3 = computeExpectedSetHash(['b', 'c', 'a']);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it('changes when a rule_id is added', () => {
    const hash1 = computeExpectedSetHash(['a', 'b']);
    const hash2 = computeExpectedSetHash(['a', 'b', 'c']);

    expect(hash1).not.toBe(hash2);
  });

  it('changes when a rule_id is removed', () => {
    const hash1 = computeExpectedSetHash(['a', 'b', 'c']);
    const hash2 = computeExpectedSetHash(['a', 'b']);

    expect(hash1).not.toBe(hash2);
  });

  it('deduplicates rule_ids before hashing', () => {
    const hash1 = computeExpectedSetHash(['a', 'b']);
    const hash2 = computeExpectedSetHash(['a', 'b', 'a']);

    expect(hash1).toBe(hash2);
  });

  it('produces a 64-char hex string (sha256)', () => {
    const hash = computeExpectedSetHash(['some-rule']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable hash for an empty set', () => {
    const hash1 = computeExpectedSetHash([]);
    const hash2 = computeExpectedSetHash([]);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });
});

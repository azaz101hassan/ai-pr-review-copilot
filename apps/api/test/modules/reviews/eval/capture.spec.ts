/**
 * Unit tests for the pure helpers exported by capture.ts.
 *
 * Tests ONLY the exported pure functions — not the live capture loop.
 * The live loop is gated behind RUN_EVAL_CAPTURE / RUN_ANTHROPIC_INTEGRATION
 * and exercised during U9 baseline capture.
 */

import type { NormalizedChunk } from '@/modules/embeddings/helpers/corpus-loader';
import type { AnalyzeDiffResult } from '@/modules/reviews/types/llm-reviewer';
import type { ToolCallRecord } from '@/modules/reviews/types/review.types';
import type { SearchHit } from '@/modules/embeddings';
import { AnthropicRequestError } from '@/infrastructure/anthropic';
import type { LoadedManifestEntry } from '@/modules/reviews/eval/manifest';
import type { RecordingProvenance } from '@/modules/reviews/eval/recording';

import {
  resolveRuleSet,
  searchHitsToSortedRules,
  assembleEmittedRecording,
  assembleThrewRecording,
  assembleThrewRecordingFromGenericError,
  assertCorpusVersion,
  assertNoRuleIdCollisions,
  parseOnlyFlag,
  filterEntriesByFixtureIds,
  SEED_CORPUS_VERSION,
  EXPECTED_CHUNK_COUNT,
  FULL_CORPUS_MARKER,
} from '@/modules/reviews/eval/capture';

// ── Test helpers ───────────────────────────────────────────────────────

function makeChunk(overrides: Partial<NormalizedChunk> = {}): NormalizedChunk {
  return {
    id: 'test-source:test-rule',
    source_id: 'test-source',
    rule_id: 'test-rule',
    title: 'Test Rule',
    body: 'Test rule body text',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<LoadedManifestEntry> = {}): LoadedManifestEntry {
  return {
    fixtureId: 'test-fixture',
    path: 'test/fixtures/diffs/test.patch',
    category: 'violating',
    expected: ['test-rule'],
    needsRepoContext: false,
    gates: true,
    expectedSetHash: 'abc123',
    ...overrides,
  };
}

function makeProvenance(overrides: Partial<RecordingProvenance> = {}): RecordingProvenance {
  return {
    promptVersion: 'v3',
    model: 'claude-haiku-4-5-20251001',
    judgeModel: 'claude-haiku-4-5-20251001',
    judgePromptVersion: 'v1',
    seedCorpusVersion: SEED_CORPUS_VERSION,
    expectedSetHash: 'abc123',
    gitSha: 'deadbeef',
    ...overrides,
  };
}

function makeAnalyzeDiffResult(
  overrides: Partial<AnalyzeDiffResult> = {},
): AnalyzeDiffResult {
  return {
    findings: [
      {
        rule_id: 'no-var',
        title: 'Use let or const, never var',
        message: 'Replace `var` with `let` or `const`.',
        location_hint: 'src/foo.js:3',
        citation: 'var sum = 0;',
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    model: 'claude-haiku-4-5-20251001',
    promptVersion: 'v3',
    turnCount: 1,
    toolCalls: [
      {
        turn_idx: 0,
        tool_name: 'emit_finding',
        input_hash: 'abc',
        result_bytes: 0,
        latency_ms: 500,
        stop_reason: 'tool_use',
      },
    ],
    hallucinatedFindingCount: 0,
    cacheHitCount: 0,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('capture.ts pure helpers', () => {
  describe('resolveRuleSet', () => {
    const chunks: NormalizedChunk[] = [
      makeChunk({ rule_id: 'no-var', source_id: 'team-standards', id: 'team-standards:no-var' }),
      makeChunk({ rule_id: 'eqeqeq', source_id: 'airbnb-eslint', id: 'airbnb-eslint:eqeqeq' }),
      makeChunk({ rule_id: 'no-param-reassign', source_id: 'airbnb-eslint', id: 'airbnb-eslint:no-param-reassign' }),
    ];

    it('returns retrieval for violating fixtures', () => {
      const entry = makeEntry({ category: 'violating' });
      const result = resolveRuleSet(entry, chunks);
      expect(result.kind).toBe('retrieval');
    });

    it('returns full-corpus with all rules for clean fixtures', () => {
      const entry = makeEntry({
        category: 'clean',
        expected: [],
        injectedRules: [FULL_CORPUS_MARKER],
      });
      const result = resolveRuleSet(entry, chunks);
      expect(result.kind).toBe('full-corpus');
      if (result.kind === 'full-corpus') {
        expect(result.rules).toHaveLength(3);
        expect(result.rules.map((r) => r.rule_id).sort()).toEqual([
          'eqeqeq',
          'no-param-reassign',
          'no-var',
        ]);
      }
    });

    it('returns injected rules for agent-loop fixtures', () => {
      const entry = makeEntry({
        category: 'agent-loop',
        expected: ['no-param-reassign'],
        injectedRules: ['no-param-reassign'],
      });
      const result = resolveRuleSet(entry, chunks);
      expect(result.kind).toBe('injected');
      if (result.kind === 'injected') {
        expect(result.rules).toHaveLength(1);
        expect(result.rules[0].rule_id).toBe('no-param-reassign');
      }
    });

    it('returns injected rules for suppression fixtures', () => {
      const entry = makeEntry({
        category: 'suppression',
        expected: [],
        injectedRules: ['eqeqeq'],
      });
      const result = resolveRuleSet(entry, chunks);
      expect(result.kind).toBe('injected');
      if (result.kind === 'injected') {
        expect(result.rules).toHaveLength(1);
        expect(result.rules[0].rule_id).toBe('eqeqeq');
      }
    });
  });

  describe('searchHitsToSortedRules', () => {
    it('sorts hits by source:rule_id for prompt-cache stability', () => {
      const hits: SearchHit[] = [
        {
          rule_id: 'no-var',
          source: 'team-standards',
          score: 0.9,
          title: 'No var',
          document: 'no var doc',
          metadata: {},
        },
        {
          rule_id: 'eqeqeq',
          source: 'airbnb-eslint',
          score: 0.8,
          title: 'Strict equality',
          document: 'eqeqeq doc',
          metadata: {},
        },
        {
          rule_id: 'prefer-const',
          source: 'airbnb-eslint',
          score: 0.7,
          title: 'Prefer const',
          document: 'prefer const doc',
          metadata: {},
        },
      ];

      const rules = searchHitsToSortedRules(hits);
      expect(rules.map((r) => `${r.source}:${r.rule_id}`)).toEqual([
        'airbnb-eslint:eqeqeq',
        'airbnb-eslint:prefer-const',
        'team-standards:no-var',
      ]);
    });
  });

  describe('assembleEmittedRecording', () => {
    it('carries findings with bare rule_id, sorted rule set, and full provenance', () => {
      const result = makeAnalyzeDiffResult({
        findings: [
          {
            rule_id: 'no-var',
            title: 'Use const',
            message: 'Replace var with const.',
            location_hint: 'src/a.js:1',
            citation: 'var x = 1;',
          },
          {
            rule_id: 'eqeqeq',
            title: 'Strict equality',
            message: 'Use === instead of ==.',
            location_hint: null,
            citation: null,
          },
        ],
      });

      const judgments = [
        { score: 1.0, claims: [{ claim: 'var is bad', kind: '', reason: 'rule says so', verdict: 'supported' as const }] },
        { score: 0.5, claims: [{ claim: '== is loose', kind: '', reason: 'rule says so', verdict: 'supported' as const }, { claim: 'always wrong', kind: '', reason: 'not stated', verdict: 'not_supported' as const }] },
      ];

      const provenance = makeProvenance();
      const ruleSet = ['no-var', 'eqeqeq'];

      const recording = assembleEmittedRecording(
        'test-fixture',
        result,
        judgments,
        ruleSet,
        provenance,
      );

      expect(recording.status).toBe('emitted');
      expect(recording.fixtureId).toBe('test-fixture');
      expect(recording.findings).toHaveLength(2);
      expect(recording.findings[0].rule_id).toBe('no-var');
      expect(recording.findings[0].faithfulness.score).toBe(1.0);
      expect(recording.findings[1].rule_id).toBe('eqeqeq');
      expect(recording.findings[1].faithfulness.score).toBe(0.5);
      // Rule set is sorted
      expect(recording.ruleSet).toEqual(['eqeqeq', 'no-var']);
      expect(recording.provenance).toEqual(provenance);
    });

    it('includes priorReviewSnapshot when provided for suppression fixtures', () => {
      const result = makeAnalyzeDiffResult({ findings: [] });
      const provenance = makeProvenance();
      const snapshot = [
        {
          review_id: 'rev-1',
          finding_id: 'f-1',
          rule_id: 'eqeqeq',
          file_path: 'src/checkout.js',
          location_hint: 'src/checkout.js:15',
          dismissed_at: 1779712800000,
          message: 'Use === instead of ==.',
        },
      ];

      const recording = assembleEmittedRecording(
        'suppression-fixture',
        result,
        [],
        ['eqeqeq'],
        provenance,
        { priorReviewSnapshot: snapshot },
      );

      expect(recording.priorReviewSnapshot).toEqual(snapshot);
    });

    it('omits priorReviewSnapshot when not provided', () => {
      const result = makeAnalyzeDiffResult({ findings: [] });
      const provenance = makeProvenance();

      const recording = assembleEmittedRecording(
        'clean-fixture',
        result,
        [],
        ['no-var'],
        provenance,
      );

      expect(recording.priorReviewSnapshot).toBeUndefined();
    });
  });

  describe('assembleThrewRecording (from AnthropicRequestError)', () => {
    it('records turn_cap_exceeded with partial state', () => {
      const toolCalls: ToolCallRecord[] = [
        {
          turn_idx: 0,
          tool_name: 'fetch_related_file',
          input_hash: 'abc',
          result_bytes: 500,
          latency_ms: 200,
          stop_reason: 'tool_use',
        },
        {
          turn_idx: 1,
          tool_name: 'fetch_function_definition',
          input_hash: 'def',
          result_bytes: 300,
          latency_ms: 150,
          stop_reason: 'tool_use',
        },
      ];

      const error = new AnthropicRequestError('Turn cap exceeded', {
        status: 200,
        errorCode: 'turn_cap_exceeded',
        turnCount: 6,
        toolCalls,
      });

      const provenance = makeProvenance();
      const recording = assembleThrewRecording('agent-fixture', error, provenance);

      expect(recording.status).toBe('threw');
      expect(recording.fixtureId).toBe('agent-fixture');
      expect(recording.error.errorCode).toBe('turn_cap_exceeded');
      expect(recording.error.turnCount).toBe(6);
      expect(recording.error.toolCalls).toEqual(toolCalls);
      expect(recording.provenance).toEqual(provenance);
    });

    it('records pre-loop throw with null turnCount/toolCalls', () => {
      const error = new AnthropicRequestError('Auth failed', {
        status: 401,
        errorCode: 'authentication_error',
      });

      const provenance = makeProvenance();
      const recording = assembleThrewRecording('some-fixture', error, provenance);

      expect(recording.status).toBe('threw');
      expect(recording.error.errorCode).toBe('authentication_error');
      expect(recording.error.turnCount).toBeNull();
      expect(recording.error.toolCalls).toBeNull();
    });
  });

  describe('assembleThrewRecordingFromGenericError', () => {
    it('records a generic pre-loop error with null partial state', () => {
      const provenance = makeProvenance();
      const recording = assembleThrewRecordingFromGenericError(
        'some-fixture',
        'internal_error',
        provenance,
      );

      expect(recording.status).toBe('threw');
      expect(recording.error.errorCode).toBe('internal_error');
      expect(recording.error.turnCount).toBeNull();
      expect(recording.error.toolCalls).toBeNull();
    });
  });

  describe('assertCorpusVersion (preflight)', () => {
    it('passes when chunk count matches the expected count', () => {
      const chunks = Array.from({ length: 43 }, (_, i) =>
        makeChunk({ rule_id: `rule-${i}`, id: `source:rule-${i}` }),
      );
      expect(() => assertCorpusVersion(chunks, 43)).not.toThrow();
    });

    it('throws when chunk count mismatches', () => {
      const chunks = Array.from({ length: 42 }, (_, i) =>
        makeChunk({ rule_id: `rule-${i}`, id: `source:rule-${i}` }),
      );
      expect(() => assertCorpusVersion(chunks, 43)).toThrow(
        /Seed corpus version mismatch.*expected 43.*found 42/,
      );
    });

    it('throws before any API call would happen', () => {
      // 0 chunks is an extreme version mismatch
      expect(() => assertCorpusVersion([], 43)).toThrow(
        /Seed corpus version mismatch/,
      );
    });
  });

  describe('assertNoRuleIdCollisions (preflight)', () => {
    it('passes when no rule_id appears in multiple sources', () => {
      const chunks = [
        makeChunk({ rule_id: 'no-var', source_id: 'team-standards' }),
        makeChunk({ rule_id: 'eqeqeq', source_id: 'airbnb-eslint' }),
      ];
      expect(() => assertNoRuleIdCollisions(chunks)).not.toThrow();
    });

    it('passes when the same rule_id appears in the same source', () => {
      const chunks = [
        makeChunk({ rule_id: 'no-var', source_id: 'team-standards' }),
        makeChunk({ rule_id: 'no-var', source_id: 'team-standards' }),
      ];
      expect(() => assertNoRuleIdCollisions(chunks)).not.toThrow();
    });

    it('throws on a cross-source collision', () => {
      const chunks = [
        makeChunk({ rule_id: 'no-var', source_id: 'team-standards' }),
        makeChunk({ rule_id: 'no-var', source_id: 'airbnb-eslint' }),
      ];
      expect(() => assertNoRuleIdCollisions(chunks)).toThrow(
        /Cross-source rule_id collision.*no-var/,
      );
    });
  });

  describe('parseOnlyFlag', () => {
    it('returns an empty array when --only is absent', () => {
      expect(parseOnlyFlag(['node', 'capture.js'])).toEqual([]);
    });

    it('parses a comma-separated list passed via "--only value"', () => {
      const argv = ['node', 'capture.js', '--only', 'foo,bar,baz'];
      expect(parseOnlyFlag(argv)).toEqual(['foo', 'bar', 'baz']);
    });

    it('parses a comma-separated list passed via "--only=value"', () => {
      const argv = ['node', 'capture.js', '--only=foo,bar'];
      expect(parseOnlyFlag(argv)).toEqual(['foo', 'bar']);
    });

    it('parses a single value', () => {
      expect(parseOnlyFlag(['node', 'capture.js', '--only', 'foo'])).toEqual(['foo']);
    });

    it('trims whitespace around comma-separated values', () => {
      const argv = ['node', 'capture.js', '--only', ' foo , bar , baz '];
      expect(parseOnlyFlag(argv)).toEqual(['foo', 'bar', 'baz']);
    });

    it('drops empty tokens produced by stray commas', () => {
      const argv = ['node', 'capture.js', '--only', 'foo,,bar,'];
      expect(parseOnlyFlag(argv)).toEqual(['foo', 'bar']);
    });

    it('throws when --only is passed with no value', () => {
      expect(() => parseOnlyFlag(['node', 'capture.js', '--only'])).toThrow(
        /--only requires a value/,
      );
    });

    it('throws when --only is passed with an empty value', () => {
      expect(() => parseOnlyFlag(['node', 'capture.js', '--only', ''])).toThrow(
        /--only requires a value/,
      );
    });

    it('throws when --only= is passed with an empty value', () => {
      expect(() => parseOnlyFlag(['node', 'capture.js', '--only='])).toThrow(
        /--only requires a value/,
      );
    });

    it('ignores unrelated flags', () => {
      const argv = ['node', 'capture.js', '--verbose', '--only', 'foo', '--debug'];
      expect(parseOnlyFlag(argv)).toEqual(['foo']);
    });
  });

  describe('filterEntriesByFixtureIds', () => {
    const entries: LoadedManifestEntry[] = [
      makeEntry({ fixtureId: 'alpha' }),
      makeEntry({ fixtureId: 'bravo' }),
      makeEntry({ fixtureId: 'charlie' }),
    ];

    it('returns all entries unchanged when ids is empty', () => {
      const result = filterEntriesByFixtureIds(entries, []);
      expect(result.filtered).toEqual(entries);
      expect(result.missing).toEqual([]);
    });

    it('returns only the requested entries, preserving manifest order', () => {
      const result = filterEntriesByFixtureIds(entries, ['charlie', 'alpha']);
      expect(result.filtered.map((e) => e.fixtureId)).toEqual(['alpha', 'charlie']);
      expect(result.missing).toEqual([]);
    });

    it('reports missing ids without throwing', () => {
      const result = filterEntriesByFixtureIds(entries, ['alpha', 'delta', 'echo']);
      expect(result.filtered.map((e) => e.fixtureId)).toEqual(['alpha']);
      expect(result.missing).toEqual(['delta', 'echo']);
    });

    it('deduplicates repeated ids', () => {
      const result = filterEntriesByFixtureIds(entries, ['alpha', 'alpha', 'bravo']);
      expect(result.filtered.map((e) => e.fixtureId)).toEqual(['alpha', 'bravo']);
      expect(result.missing).toEqual([]);
    });
  });
});

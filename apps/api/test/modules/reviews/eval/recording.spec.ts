import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeRecording,
  readRecording,
  readAllRecordings,
  isEmittedRecording,
  isThrewRecording,
} from '@/modules/reviews/eval/recording';
import type {
  Recording,
  EmittedRecording,
  ThrewRecording,
  RecordingProvenance,
} from '@/modules/reviews/eval/recording';

// ── Helpers ─────────────────────────────────────────────────────────

function makeProvenance(
  overrides: Partial<RecordingProvenance> = {},
): RecordingProvenance {
  return {
    promptVersion: 'v3',
    model: 'claude-haiku-4-5-20251001',
    judgeModel: 'claude-haiku-4-5-20251001',
    judgePromptVersion: 'v1',
    seedCorpusVersion: 'v1',
    expectedSetHash: 'abc123',
    gitSha: 'deadbeef',
    ...overrides,
  };
}

function makeEmittedRecording(
  overrides: Partial<EmittedRecording> = {},
): EmittedRecording {
  return {
    status: 'emitted',
    fixtureId: 'test-fixture',
    findings: [
      {
        rule_id: 'no-var',
        title: 'Avoid var',
        message: 'Use const or let instead of var.',
        location_hint: 'src/utils.ts:10',
        citation: 'The var keyword...',
        faithfulness: {
          score: 1.0,
          claims: [
            {
              claim: 'The code uses var instead of const or let.',
              kind: 'diff_assertion',
              reason: 'The diff shows var being used at line 10.',
              verdict: 'supported',
            },
          ],
        },
      },
    ],
    ruleSet: ['eqeqeq', 'no-var', 'prefer-const'],
    provenance: makeProvenance(),
    ...overrides,
  };
}

function makeThrewRecording(
  overrides: Partial<ThrewRecording> = {},
): ThrewRecording {
  return {
    status: 'threw',
    fixtureId: 'test-fixture-threw',
    error: {
      errorCode: 'turn_cap_exceeded',
      turnCount: 6,
      toolCalls: [
        {
          turn_idx: 0,
          tool_name: 'fetch_related_file',
          input_hash: 'abc',
          result_bytes: 1024,
          latency_ms: 150,
          stop_reason: 'tool_use',
        },
      ],
    },
    provenance: makeProvenance(),
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-recording-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────

describe('recording round-trip', () => {
  it('round-trips an emitted recording through write -> read', () => {
    const original = makeEmittedRecording();

    writeRecording(tmpDir, original);
    const loaded = readRecording(tmpDir, original.fixtureId);

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(original);
  });

  it('round-trips a threw recording through write -> read', () => {
    const original = makeThrewRecording();

    writeRecording(tmpDir, original);
    const loaded = readRecording(tmpDir, original.fixtureId);

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(original);
  });

  it('round-trips a threw recording with turnCount: null', () => {
    const original = makeThrewRecording({
      error: {
        errorCode: 'credit_balance_too_low',
        turnCount: null,
        toolCalls: null,
      },
    });

    writeRecording(tmpDir, original);
    const loaded = readRecording(tmpDir, original.fixtureId);

    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('threw');
    const threw = loaded as ThrewRecording;
    expect(threw.error.turnCount).toBeNull();
    expect(threw.error.toolCalls).toBeNull();
  });

  it('round-trips a threw recording with toolCalls: null (pre-loop throw)', () => {
    const original = makeThrewRecording({
      error: {
        errorCode: 'authentication_error',
        turnCount: null,
        toolCalls: null,
      },
    });

    writeRecording(tmpDir, original);
    const loaded = readRecording(tmpDir, original.fixtureId);

    expect(loaded).toEqual(original);
    const threw = loaded as ThrewRecording;
    expect(threw.error.toolCalls).toBeNull();
    expect(threw.error.turnCount).toBeNull();
  });

  it('round-trips an emitted recording with zero findings', () => {
    const original = makeEmittedRecording({
      fixtureId: 'clean-fixture',
      findings: [],
    });

    writeRecording(tmpDir, original);
    const loaded = readRecording(tmpDir, original.fixtureId);

    expect(loaded).toEqual(original);
    expect((loaded as EmittedRecording).findings).toEqual([]);
  });

  it('round-trips an emitted recording with null location_hint and citation', () => {
    const original = makeEmittedRecording({
      findings: [
        {
          rule_id: 'eqeqeq',
          title: 'Use ===',
          message: 'Use strict equality.',
          location_hint: null,
          citation: null,
          faithfulness: {
            score: null,
            claims: [],
          },
        },
      ],
    });

    writeRecording(tmpDir, original);
    const loaded = readRecording(tmpDir, original.fixtureId);

    expect(loaded).toEqual(original);
    const emitted = loaded as EmittedRecording;
    expect(emitted.findings[0].location_hint).toBeNull();
    expect(emitted.findings[0].citation).toBeNull();
    expect(emitted.findings[0].faithfulness.score).toBeNull();
  });

  it('preserves priorReviewSnapshot when present', () => {
    const original = makeEmittedRecording({
      fixtureId: 'suppression-test',
      findings: [],
      priorReviewSnapshot: [
        {
          rule_id: 'eqeqeq',
          dismissed_at: 1717000000000,
          location: 'src/checkout.js:42',
        },
      ],
    });

    writeRecording(tmpDir, original);
    const loaded = readRecording(tmpDir, original.fixtureId);

    expect(loaded).toEqual(original);
    expect((loaded as EmittedRecording).priorReviewSnapshot).toEqual([
      {
        rule_id: 'eqeqeq',
        dismissed_at: 1717000000000,
        location: 'src/checkout.js:42',
      },
    ]);
  });
});

describe('readRecording for missing file', () => {
  it('returns null when the fixture file does not exist', () => {
    const result = readRecording(tmpDir, 'nonexistent');
    expect(result).toBeNull();
  });
});

describe('readAllRecordings', () => {
  it('reads all recordings from the directory', () => {
    const emitted = makeEmittedRecording({ fixtureId: 'fixture-a' });
    const threw = makeThrewRecording({ fixtureId: 'fixture-b' });

    writeRecording(tmpDir, emitted);
    writeRecording(tmpDir, threw);

    const all = readAllRecordings(tmpDir);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.fixtureId).sort()).toEqual([
      'fixture-a',
      'fixture-b',
    ]);
  });

  it('returns an empty array when the directory does not exist', () => {
    const missing = path.join(tmpDir, 'nonexistent');
    const all = readAllRecordings(missing);
    expect(all).toEqual([]);
  });
});

describe('type guards', () => {
  it('isEmittedRecording narrows correctly', () => {
    const emitted = makeEmittedRecording();
    const threw = makeThrewRecording();

    expect(isEmittedRecording(emitted)).toBe(true);
    expect(isEmittedRecording(threw)).toBe(false);
  });

  it('isThrewRecording narrows correctly', () => {
    const emitted = makeEmittedRecording();
    const threw = makeThrewRecording();

    expect(isThrewRecording(threw)).toBe(true);
    expect(isThrewRecording(emitted)).toBe(false);
  });
});

describe('write overwrites existing recording', () => {
  it('overwrites a recording with the same fixtureId', () => {
    const v1 = makeEmittedRecording({ fixtureId: 'overwrite-me' });
    const v2 = makeEmittedRecording({
      fixtureId: 'overwrite-me',
      findings: [],
    });

    writeRecording(tmpDir, v1);
    writeRecording(tmpDir, v2);

    const loaded = readRecording(tmpDir, 'overwrite-me');
    expect((loaded as EmittedRecording).findings).toEqual([]);
  });
});

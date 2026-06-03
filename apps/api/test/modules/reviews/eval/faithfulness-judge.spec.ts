import { judgeFinding } from '../../../../src/modules/reviews/eval/faithfulness-judge';
import type { FaithfulnessResult } from '../../../../src/modules/reviews/eval/recording';

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a mock Anthropic client that returns a single tool_use response. */
function mockClient(toolInput: unknown) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        id: 'msg_test',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_test',
            name: 'faithfulness_verdict',
            input: toolInput,
          },
        ],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    },
  };
}

/** Build a mock client that returns a text block instead of tool_use. */
function mockClientTextOnly() {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        id: 'msg_test',
        content: [
          {
            type: 'text',
            text: 'I cannot process this finding.',
          },
        ],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      }),
    },
  };
}

const SAMPLE_FINDING = {
  rule_id: 'no-var',
  title: 'Use let or const, never var',
  message:
    'Replace `var` with `let` or `const`. `var` is function-scoped and hoisted, leading to subtle bugs.',
  location_hint: 'src/totals.js:3',
  citation: 'var sum = 0;',
};

const SAMPLE_RULE_DOC =
  '## no-var\n\nDo not use `var` declarations. Use `let` for mutable variables and `const` for immutable ones. `var` is function-scoped and hoisted, which leads to subtle re-declaration and closure bugs.';

const SAMPLE_DIFF = `diff --git a/src/totals.js b/src/totals.js
--- a/src/totals.js
+++ b/src/totals.js
@@ -1,3 +1,3 @@
-const sum = 0;
+var sum = 0;
 const items = [1, 2, 3];`;

// ── Tests ──────────────────────────────────────────────────────────────

describe('judgeFinding', () => {
  it('happy path: all claims supported → score 1.0', async () => {
    const client = mockClient({
      claims: [
        {
          claim:
            'The diff replaces a `const` declaration with `var` in src/totals.js.',
          reason:
            'The diff clearly shows `const sum = 0;` changed to `var sum = 0;`.',
          verdict: 'supported',
        },
        {
          claim:
            '`var` is function-scoped and hoisted, leading to subtle bugs.',
          reason:
            'The rule document explicitly states that `var` is function-scoped and hoisted, leading to subtle re-declaration and closure bugs.',
          verdict: 'supported',
        },
      ],
    });

    const result: FaithfulnessResult = await judgeFinding({
      finding: SAMPLE_FINDING,
      ruleDocText: SAMPLE_RULE_DOC,
      diff: SAMPLE_DIFF,
      client,
    });

    expect(result.score).toBe(1.0);
    expect(result.claims).toHaveLength(2);
    expect(result.claims.every((c) => c.verdict === 'supported')).toBe(true);
    // kind is empty string (claim-kind tagging deferred)
    expect(result.claims.every((c) => c.kind === '')).toBe(true);
  });

  it('edge case: unsupported claims → score near 0', async () => {
    const client = mockClient({
      claims: [
        {
          claim:
            'The function uses deprecated Node.js APIs that will be removed in v22.',
          reason:
            'Neither the rule document nor the diff mention deprecated Node.js APIs.',
          verdict: 'not_supported',
        },
        {
          claim: 'The code violates the team security policy.',
          reason:
            'The rule document is about var vs let/const, not security.',
          verdict: 'not_supported',
        },
      ],
    });

    const result: FaithfulnessResult = await judgeFinding({
      finding: SAMPLE_FINDING,
      ruleDocText: SAMPLE_RULE_DOC,
      diff: SAMPLE_DIFF,
      client,
    });

    expect(result.score).toBe(0);
    expect(result.claims).toHaveLength(2);
    expect(result.claims.every((c) => c.verdict === 'not_supported')).toBe(
      true,
    );
  });

  it('edge case: unclear verdict counts as not_supported in score', async () => {
    const client = mockClient({
      claims: [
        {
          claim:
            'The diff replaces `const` with `var` in src/totals.js line 3.',
          reason: 'The diff clearly shows this change.',
          verdict: 'supported',
        },
        {
          claim:
            'This change might cause issues with closures in the surrounding code.',
          reason:
            'The rule mentions closure bugs, but the diff context is too limited to confirm this specific claim.',
          verdict: 'unclear',
        },
        {
          claim: 'The variable is reassigned later in the function.',
          reason:
            'The diff does not show enough context to determine if the variable is reassigned.',
          verdict: 'unclear',
        },
      ],
    });

    const result: FaithfulnessResult = await judgeFinding({
      finding: SAMPLE_FINDING,
      ruleDocText: SAMPLE_RULE_DOC,
      diff: SAMPLE_DIFF,
      client,
    });

    // 1 supported out of 3 total; unclear counts as not_supported
    expect(result.score).toBeCloseTo(1 / 3, 5);
    expect(result.claims).toHaveLength(3);
    expect(result.claims.filter((c) => c.verdict === 'supported')).toHaveLength(
      1,
    );
    expect(result.claims.filter((c) => c.verdict === 'unclear')).toHaveLength(
      2,
    );
  });

  it('edge case: zero claims → score is null', async () => {
    const client = mockClient({
      claims: [],
    });

    const result: FaithfulnessResult = await judgeFinding({
      finding: SAMPLE_FINDING,
      ruleDocText: SAMPLE_RULE_DOC,
      diff: SAMPLE_DIFF,
      client,
    });

    expect(result.score).toBeNull();
    expect(result.claims).toHaveLength(0);
  });

  it('error path: malformed judge response (no tool_use block) → throws', async () => {
    const client = mockClientTextOnly();

    await expect(
      judgeFinding({
        finding: SAMPLE_FINDING,
        ruleDocText: SAMPLE_RULE_DOC,
        diff: SAMPLE_DIFF,
        client,
      }),
    ).rejects.toThrow(/faithfulness judge/i);
  });

  it('error path: malformed tool input (missing claims array) → throws', async () => {
    const client = mockClient({ something_else: 'not claims' });

    await expect(
      judgeFinding({
        finding: SAMPLE_FINDING,
        ruleDocText: SAMPLE_RULE_DOC,
        diff: SAMPLE_DIFF,
        client,
      }),
    ).rejects.toThrow(/faithfulness judge/i);
  });

  it('error path: malformed claim (missing verdict) → throws', async () => {
    const client = mockClient({
      claims: [
        {
          claim: 'Some claim.',
          reason: 'Some reason.',
          // verdict is missing
        },
      ],
    });

    await expect(
      judgeFinding({
        finding: SAMPLE_FINDING,
        ruleDocText: SAMPLE_RULE_DOC,
        diff: SAMPLE_DIFF,
        client,
      }),
    ).rejects.toThrow(/faithfulness judge/i);
  });

  it('error path: invalid verdict value → throws', async () => {
    const client = mockClient({
      claims: [
        {
          claim: 'Some claim.',
          reason: 'Some reason.',
          verdict: 'maybe',
        },
      ],
    });

    await expect(
      judgeFinding({
        finding: SAMPLE_FINDING,
        ruleDocText: SAMPLE_RULE_DOC,
        diff: SAMPLE_DIFF,
        client,
      }),
    ).rejects.toThrow(/faithfulness judge/i);
  });

  it('passes correct parameters to the Anthropic client', async () => {
    const client = mockClient({
      claims: [
        {
          claim: 'A claim.',
          reason: 'A reason.',
          verdict: 'supported',
        },
      ],
    });

    await judgeFinding({
      finding: SAMPLE_FINDING,
      ruleDocText: SAMPLE_RULE_DOC,
      diff: SAMPLE_DIFF,
      client,
    });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const [body, options] = client.messages.create.mock.calls[0];

    // Model default
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    // Temperature 0
    expect(body.temperature).toBe(0);
    // max_tokens set
    expect(body.max_tokens).toBeGreaterThan(0);
    // tool_choice forces the faithfulness_verdict tool
    expect(body.tool_choice).toEqual({
      type: 'tool',
      name: 'faithfulness_verdict',
    });
    // System prompt is a string
    expect(typeof body.system).toBe('string');
    expect(body.system.length).toBeGreaterThan(0);
    // Messages contain the finding + context
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    // Tools include faithfulness_verdict
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('faithfulness_verdict');
  });

  it('accepts finding without optional location_hint and citation', async () => {
    const finding = {
      rule_id: 'no-var',
      title: 'Use let or const',
      message: 'Do not use var.',
    };

    const client = mockClient({
      claims: [
        {
          claim: 'The finding says not to use var.',
          reason: 'The rule doc says to use let or const.',
          verdict: 'supported',
        },
      ],
    });

    const result = await judgeFinding({
      finding,
      ruleDocText: SAMPLE_RULE_DOC,
      diff: SAMPLE_DIFF,
      client,
    });

    expect(result.score).toBe(1.0);
    expect(result.claims).toHaveLength(1);
  });

  it('mixed verdicts produce correct score', async () => {
    const client = mockClient({
      claims: [
        {
          claim: 'Claim 1 is correct.',
          reason: 'The diff shows it.',
          verdict: 'supported',
        },
        {
          claim: 'Claim 2 is fabricated.',
          reason: 'Not in the diff or rule.',
          verdict: 'not_supported',
        },
        {
          claim: 'Claim 3 is ambiguous.',
          reason: 'Partially inferable.',
          verdict: 'unclear',
        },
        {
          claim: 'Claim 4 is correct.',
          reason: 'The rule doc states this.',
          verdict: 'supported',
        },
      ],
    });

    const result: FaithfulnessResult = await judgeFinding({
      finding: SAMPLE_FINDING,
      ruleDocText: SAMPLE_RULE_DOC,
      diff: SAMPLE_DIFF,
      client,
    });

    // 2 supported out of 4 total (unclear counts as not_supported)
    expect(result.score).toBe(0.5);
    expect(result.claims).toHaveLength(4);
  });
});

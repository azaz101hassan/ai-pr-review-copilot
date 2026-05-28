import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnthropicLlmReviewer } from '../../../src/infrastructure/anthropic/anthropic-llm-reviewer';
import { ConfigService } from '@/config';

// Real-Anthropic smoke spec. Talks to the actual Messages API — no
// mocked client. Gated by RUN_ANTHROPIC_INTEGRATION=true so a local
// `npm test` from a developer who hasn't set ANTHROPIC_API_KEY doesn't
// fail, and CI never burns budget (the workflow explicitly unsets the
// flag).
//
// Mirrors the Chroma-integration gate pattern; the difference is the
// session rate-limit guard below — Anthropic costs real money, so a
// `jest --watch` loop that quietly fires 50 calls in a minute is a
// genuine risk worth foreclosing.
const ENABLED = process.env.RUN_ANTHROPIC_INTEGRATION === 'true';
const describeIf = ENABLED ? describe : describe.skip;

// Module-scoped session counter. If the spec runs more than 5 times in
// any rolling 60-second window we abort with a clear error — that's
// almost certainly a `jest --watch` loop, not intended behaviour.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 5;
const callTimestamps: number[] = [];

function enforceSessionRateLimit(): void {
  const now = Date.now();
  // Drop timestamps that fell out of the window.
  while (callTimestamps.length && now - callTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    callTimestamps.shift();
  }
  if (callTimestamps.length >= RATE_LIMIT_MAX_CALLS) {
    throw new Error(
      `SessionRateLimitExceeded: too many real Anthropic calls in this jest session ` +
        `(${callTimestamps.length} within ${RATE_LIMIT_WINDOW_MS / 1000}s, max ${RATE_LIMIT_MAX_CALLS}) — ` +
        `likely a jest --watch loop. Restart Jest and reset the counter.`,
    );
  }
  callTimestamps.push(now);
}

function makeConfig(): ConfigService {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — required when RUN_ANTHROPIC_INTEGRATION=true.',
    );
  }
  return {
    anthropicApiKey: apiKey,
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
  } as ConfigService;
}

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../fixtures/diffs', name), 'utf8');
}

describeIf('AnthropicLlmReviewer — real-Anthropic smoke (RUN_ANTHROPIC_INTEGRATION=true)', () => {
  // jest's default per-test timeout is 5s; real API calls + retries
  // need more headroom.
  jest.setTimeout(60_000);

  it('returns at least one finding citing the matched rule on a violation diff', async () => {
    enforceSessionRateLimit();
    const reviewer = new AnthropicLlmReviewer(makeConfig());
    const diff = loadFixture('no-var-violation.patch');

    const result = await reviewer.analyzeDiff({
      diff,
      rules: [
        {
          rule_id: 'no-var',
          source: 'team-standards',
          document:
            'Prefer let and const over var. `var` is function-scoped and hoisted, which leads to subtle bugs around closures and re-declaration. Use `const` for bindings that do not change, `let` otherwise.',
          title: 'No var declarations',
        },
      ],
    });

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].rule_id).toBe('no-var');
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.output_tokens).toBeGreaterThan(0);
  });

  it('first call writes cache_creation_input_tokens > 0; second call reads from cache', async () => {
    enforceSessionRateLimit();
    const reviewer = new AnthropicLlmReviewer(makeConfig());
    const diff = loadFixture('no-var-violation.patch');
    const rules = [
      {
        rule_id: 'no-var',
        source: 'team-standards',
        document:
          'Prefer let and const over var. `var` is function-scoped and hoisted, which leads to subtle bugs around closures and re-declaration. Use `const` for bindings that do not change, `let` otherwise.',
        title: 'No var declarations',
      },
    ];

    const first = await reviewer.analyzeDiff({ diff, rules });
    if (!first.usage.cache_creation_input_tokens || first.usage.cache_creation_input_tokens === 0) {
      // The prompt prefix is below Sonnet's 1024-token cache threshold.
      // Pad SYSTEM_PROMPT in anthropic-llm-reviewer.ts with explicit
      // constraint examples until this clears — then `jest -u` the
      // snapshot AND bump PROMPT_AND_TOOL_VERSION in the same commit.
      throw new Error(
        `cache_creation_input_tokens was ${first.usage.cache_creation_input_tokens} on the first call — ` +
          `the cacheable prefix is below the minimum caching threshold (1024 tokens on Sonnet, lower on Haiku). ` +
          `Pad SYSTEM_PROMPT with explicit constraint examples until this clears, then regenerate the snapshot AND ` +
          `bump PROMPT_AND_TOOL_VERSION in the same commit.`,
      );
    }

    enforceSessionRateLimit();
    const second = await reviewer.analyzeDiff({ diff, rules });
    expect(second.usage.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
  });
});

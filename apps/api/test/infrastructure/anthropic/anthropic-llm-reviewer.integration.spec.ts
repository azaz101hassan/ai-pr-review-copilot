import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnthropicLlmReviewer, SessionRateLimitGuard } from '@/infrastructure/anthropic';
import { FilesystemRepoContextProvider } from '@/infrastructure/repo-context';
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

// Module-scoped guard instance — instantiated ONCE at the file's
// top level so its state lifetime matches the previous module-scoped
// `callTimestamps` array. Tests call `sessionGuard.acquire()`.
const sessionGuard = new SessionRateLimitGuard({
  windowMs: 60_000,
  maxCalls: 5,
});

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
    anthropicAgentTurnCap: 6,
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
    sessionGuard.acquire();
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
    sessionGuard.acquire();
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

    sessionGuard.acquire();
    const second = await reviewer.analyzeDiff({ diff, rules });
    expect(second.usage.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
  });

  // Day-4: proves the multi-turn loop actually fires against the real
  // Anthropic API. The `silent-signature-change.patch` fixture is
  // designed so the violation is only visible after fetching
  // surrounding context (chargeCard's definition + the unchanged
  // callers in src/retry-queue.js). A correct multi-turn run lands
  // turn_count > 1 AND at least one non-emit_finding tool call.
  it('multi-turn loop fires on silent-signature-change against the real Haiku model', async () => {
    sessionGuard.acquire();
    const reviewer = new AnthropicLlmReviewer(makeConfig());
    const diff = loadFixture('silent-signature-change.patch');
    const repoDir = resolve(
      __dirname,
      '../../fixtures/diffs/silent-signature-change.repo',
    );
    const repoContext = new FilesystemRepoContextProvider(repoDir);
    const rules = [
      {
        rule_id: 'no-param-reassign',
        source: 'airbnb-eslint',
        document:
          'When a function signature evolves to require a new argument or option, every caller must be updated consistently. Inconsistent argument shapes across call sites cause silent runtime bugs that pass code review.',
        title: 'Update all callers when changing a function signature',
      },
    ];

    const result = await reviewer.analyzeDiff({ diff, rules, repoContext });

    expect(result.turnCount).toBeGreaterThan(1);
    const nonTerminal = result.toolCalls.filter(
      (c) => c.tool_name !== 'emit_finding',
    );
    expect(nonTerminal.length).toBeGreaterThanOrEqual(1);
  });
});

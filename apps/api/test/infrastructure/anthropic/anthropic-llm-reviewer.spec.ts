import { Logger } from '@nestjs/common';
import { APIError } from '@anthropic-ai/sdk';
import {
  AnthropicLlmReviewer,
  SYSTEM_PROMPT,
  REGISTERED_TOOLS,
  FETCH_FILE_TOOL,
  FETCH_FUNCTION_TOOL,
  FETCH_PRIOR_REVIEW_TOOL,
  EMIT_FINDING_TOOL,
  FETCH_FILE_TOOL_NAME,
  FETCH_FUNCTION_TOOL_NAME,
  FETCH_PRIOR_REVIEW_TOOL_NAME,
  EMIT_FINDING_TOOL_NAME,
} from '../../../src/infrastructure/anthropic/anthropic-llm-reviewer';
import { AnthropicRequestError } from '../../../src/infrastructure/anthropic/anthropic-request.error';
import { PROMPT_AND_TOOL_VERSION } from '../../../src/modules/reviews/types/llm-reviewer';
import { ConfigService } from '@/config';
import { IRepoContextProvider } from '@/modules/reviews/types/repo-context-provider';

// Multi-turn loop spec. The SDK client is mocked at the
// `createClient()` seam. These tests own:
//   - request shape (cache_control breakpoints, tool_choice, tools list)
//   - loop control (turn cap, terminal vs non-terminal, mixed same-turn)
//   - tool dispatch (repoContext invocation, validation, is_error flow)
//   - response parsing (emit_finding payload validation, hallucination filter)
//   - error wrapping (carried forward from Day-3)
//   - cache invariant (request args byte-identical across calls)

const REAL_DIFF = 'diff --git a/x.js b/x.js\n@@ -1 +1 @@\n-let x = 1\n+var x = 1\n';
const REAL_RULES = [
  {
    rule_id: 'no-var',
    source: 'team-standards',
    document: 'Prefer let/const over var.',
    title: 'No var',
  },
];

interface MockClient {
  messages: { create: jest.Mock };
}

function makeMockClient(): MockClient {
  return {
    messages: {
      create: jest.fn(),
    },
  };
}

function makeConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    anthropicApiKey: 'sk-ant-test-key-0123456789abcdef',
    anthropicModel: 'claude-haiku-4-5-20251001',
    anthropicAgentTurnCap: 6,
    ...overrides,
  } as ConfigService;
}

class TestableAnthropicLlmReviewer extends AnthropicLlmReviewer {
  constructor(
    config: ConfigService,
    private readonly stubClient: MockClient,
  ) {
    super(config);
  }
  protected override createClient(): never {
    return this.stubClient as never;
  }
}

// Helpers to build mock Anthropic responses.

let nextToolUseId = 0;
function nextId(): string {
  nextToolUseId += 1;
  return `toolu_test_${nextToolUseId}`;
}

function emitFindingResponse(
  findings: unknown[],
  usageOverrides: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  }> = {},
) {
  return {
    id: 'msg_emit',
    content: [
      {
        type: 'tool_use',
        id: nextId(),
        name: EMIT_FINDING_TOOL_NAME,
        input: { findings },
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 1234,
      output_tokens: 56,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      ...usageOverrides,
    },
  };
}

function nonTerminalToolUseResponse(
  toolName: string,
  toolInput: unknown,
  usageOverrides: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  }> = {},
) {
  return {
    id: 'msg_tool',
    content: [
      {
        type: 'tool_use',
        id: nextId(),
        name: toolName,
        input: toolInput,
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 800,
      output_tokens: 40,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      ...usageOverrides,
    },
  };
}

function makeRepoContextProvider(
  overrides: Partial<IRepoContextProvider> = {},
): IRepoContextProvider {
  return {
    fetchFile: jest.fn(async (p: string) => ({
      ok: true as const,
      content: `file content for ${p}`,
      path: p,
    })),
    fetchFunctionDefinition: jest.fn(async (name: string) => ({
      ok: true as const,
      content: `function ${name}() {}`,
      path: 'src/checkout.js',
      startLine: 1,
      endLine: 1,
    })),
    fetchPriorReview: jest.fn(async () => ({
      ok: true as const,
      content: [],
    })),
    ...overrides,
  };
}

describe('AnthropicLlmReviewer (multi-turn loop)', () => {
  describe('request shape — cache invariant', () => {
    it('every messages.create call carries three cache_control markers (end of tools, end of system, end of initial user)', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(emitFindingResponse([]));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      const args = client.messages.create.mock.calls[0][0];
      // BP1: end of tools — cache_control on the LAST tool.
      const lastTool = args.tools[args.tools.length - 1];
      expect(lastTool.cache_control).toEqual({ type: 'ephemeral' });
      // Non-last tools must NOT carry cache_control (single breakpoint).
      for (let i = 0; i < args.tools.length - 1; i++) {
        expect(args.tools[i].cache_control).toBeUndefined();
      }
      // BP2: end of system — single text block with cache_control.
      expect(args.system).toEqual([
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ]);
      // BP3: end of initial user message — the first content block.
      expect(args.messages[0].role).toBe('user');
      expect(args.messages[0].content[0].cache_control).toEqual({
        type: 'ephemeral',
      });
    });

    it('uses tool_choice: { type: "any" }', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(emitFindingResponse([]));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      const args = client.messages.create.mock.calls[0][0];
      expect(args.tool_choice).toEqual({ type: 'any' });
    });

    it('passes timeout as a RequestOptions argument, never inside the request body', async () => {
      // Regression: `timeout` was once placed inside the messages.create
      // body. It is NOT a valid body field — Anthropic rejects unknown
      // body keys with HTTP 400 (invalid_request_error), so every real
      // API call failed at turn 0. The SDK takes a per-request timeout
      // only via RequestOptions (the 2nd positional arg). An `as`-cast on
      // the body let the malformed shape compile, and every unit test
      // stubs the client, so only the gated real-API integration spec
      // could have caught it. This asserts the structural contract here,
      // in the always-on suite.
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(emitFindingResponse([]));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      const [body, options] = client.messages.create.mock.calls[0];
      expect(body).not.toHaveProperty('timeout');
      expect(typeof options?.timeout).toBe('number');
      expect(options.timeout).toBeGreaterThan(0);
    });

    it('registers all four tools (fetch_*, emit_finding)', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(emitFindingResponse([]));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      const args = client.messages.create.mock.calls[0][0];
      // Strip cache_control marker so we compare by schema content.
      const sentTools = args.tools.map((t: Record<string, unknown>) => {
        const { cache_control, ...rest } = t;
        return rest;
      });
      expect(sentTools).toEqual([
        FETCH_FILE_TOOL,
        FETCH_FUNCTION_TOOL,
        FETCH_PRIOR_REVIEW_TOOL,
        EMIT_FINDING_TOOL,
      ]);
    });

    it('EMIT_FINDING_TOOL has no `severity` field on findings items (D1 invariant)', () => {
      const findingProps = EMIT_FINDING_TOOL.input_schema.properties.findings
        .items.properties as Record<string, unknown>;
      expect(findingProps.severity).toBeUndefined();
      expect(
        EMIT_FINDING_TOOL.input_schema.properties.findings.items.required,
      ).not.toContain('severity');
    });

    it('turn-1 request args are byte-identical across two consecutive analyzeDiff invocations (cache hit invariant)', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(emitFindingResponse([]))
        .mockResolvedValueOnce(emitFindingResponse([]));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });
      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      const first = client.messages.create.mock.calls[0][0];
      const second = client.messages.create.mock.calls[1][0];
      expect(first.system).toEqual(second.system);
      expect(first.tools).toEqual(second.tools);
      expect(first.tool_choice).toEqual(second.tool_choice);
      expect(first.messages[0]).toEqual(second.messages[0]);
    });
  });

  describe('loop — happy paths', () => {
    it('emit_finding on turn 1 returns immediately with turnCount=1', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        emitFindingResponse([
          {
            rule_id: 'no-var',
            title: 'Use let/const',
            message: 'Replace `var` with `let` or `const`.',
          },
        ]),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext: makeRepoContextProvider(),
      });

      expect(result.turnCount).toBe(1);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].tool_name).toBe(EMIT_FINDING_TOOL_NAME);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].rule_id).toBe('no-var');
      expect(result.promptVersion).toBe(PROMPT_AND_TOOL_VERSION);
      expect(client.messages.create).toHaveBeenCalledTimes(1);
    });

    it('fetch_related_file on turn 1, emit_finding on turn 2 — invokes provider and returns turnCount=2', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, {
            path: 'src/checkout.js',
          }),
        )
        .mockResolvedValueOnce(
          emitFindingResponse([
            {
              rule_id: 'no-var',
              title: 'Use let/const',
              message: 'Replace `var` per src/checkout.js context.',
            },
          ]),
        );
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(result.turnCount).toBe(2);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].tool_name).toBe(FETCH_FILE_TOOL_NAME);
      expect(result.toolCalls[1].tool_name).toBe(EMIT_FINDING_TOOL_NAME);
      expect(repoContext.fetchFile).toHaveBeenCalledWith('src/checkout.js');
      // Turn 2's request includes the assistant turn-1 message + a
      // user tool_result message — verify we sent that lineage.
      const turn2Args = client.messages.create.mock.calls[1][0];
      expect(turn2Args.messages).toHaveLength(3); // initial user + assistant + tool_result user
      expect(turn2Args.messages[1].role).toBe('assistant');
      expect(turn2Args.messages[2].role).toBe('user');
      expect(turn2Args.messages[2].content[0].type).toBe('tool_result');
    });

    it('accumulates UsageStats across turns (input/output/cache_creation/cache_read summed)', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(
            FETCH_FILE_TOOL_NAME,
            { path: 'src/checkout.js' },
            {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 25,
            },
          ),
        )
        .mockResolvedValueOnce(
          emitFindingResponse([], {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 25,
          }),
        );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext: makeRepoContextProvider(),
      });

      expect(result.usage).toEqual({
        input_tokens: 200,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 50,
      });
    });

    it('emit_finding with 10 findings persists all 10', async () => {
      const tenFindings = Array.from({ length: 10 }, (_, i) => ({
        rule_id: 'no-var',
        title: `T${i}`,
        message: `m${i}`,
      }));
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        emitFindingResponse(tenFindings),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext: makeRepoContextProvider(),
      });

      expect(result.findings).toHaveLength(10);
    });
  });

  describe('loop — tool-call dedup cache', () => {
    it('cache hit: second call with same (tool, input) skips the provider, returns prior content + steering hint, records cache_hit=true', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 'src/checkout.js' }),
        )
        // Turn 2: requests the same file again — should hit the cache.
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 'src/checkout.js' }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(result.turnCount).toBe(3);
      expect(repoContext.fetchFile).toHaveBeenCalledTimes(1);
      const [t1, t2, t3] = result.toolCalls;
      expect(t1.tool_name).toBe(FETCH_FILE_TOOL_NAME);
      expect(t1.cache_hit).toBeUndefined();
      expect(t2.tool_name).toBe(FETCH_FILE_TOOL_NAME);
      expect(t2.cache_hit).toBe(true);
      expect(t2.input_hash).toBe(t1.input_hash);
      expect(t3.cache_hit).toBeUndefined();

      // Turn 3's tool_result message (the user message replying to turn 2)
      // carries the cached content prefixed with the steering hint.
      const turn3Args = client.messages.create.mock.calls[2][0];
      const turn3UserMessage = turn3Args.messages[turn3Args.messages.length - 1];
      const toolResult = turn3UserMessage.content[0];
      expect(toolResult.type).toBe('tool_result');
      expect(toolResult.content[0].text).toMatch(/identical request was already served on turn 1/);
      expect(toolResult.content[0].text).toContain('file content for src/checkout.js');
    });

    it('different inputs to the same tool do NOT collide in the cache', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 'src/a.js' }),
        )
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 'src/b.js' }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(repoContext.fetchFile).toHaveBeenCalledTimes(2);
      expect(repoContext.fetchFile).toHaveBeenNthCalledWith(1, 'src/a.js');
      expect(repoContext.fetchFile).toHaveBeenNthCalledWith(2, 'src/b.js');
      expect(result.toolCalls[0].cache_hit).toBeUndefined();
      expect(result.toolCalls[1].cache_hit).toBeUndefined();
      expect(result.toolCalls[0].input_hash).not.toBe(result.toolCalls[1].input_hash);
    });

    it('error responses are NOT cached: a retried failing fetch hits the provider again', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 'src/missing.js' }),
        )
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 'src/missing.js' }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider({
        fetchFile: jest.fn(async () => ({
          ok: false as const,
          reason: 'not_found' as const,
          message: 'no such file',
        })),
      });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      // Both calls reached the provider — error didn't poison the cache.
      expect(repoContext.fetchFile).toHaveBeenCalledTimes(2);
      expect(result.toolCalls[0].is_error).toBe(true);
      expect(result.toolCalls[1].is_error).toBe(true);
      expect(result.toolCalls[0].cache_hit).toBeUndefined();
      expect(result.toolCalls[1].cache_hit).toBeUndefined();
    });

    it('dedup cache is scoped per-review: a second analyzeDiff call re-hits the provider', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 'src/a.js' }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]))
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 'src/a.js' }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });
      await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      // Two separate reviews, same path requested in each — the second
      // review must NOT inherit the first review's cache.
      expect(repoContext.fetchFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('loop — same-turn mixed content', () => {
    it('[fetch_related_file, emit_finding] in one turn — takes emit_finding, ignores the fetcher', async () => {
      const client = makeMockClient();
      // Response with BOTH a non-terminal and a terminal block in the
      // same `content[]` array. The loop should exit via emit_finding
      // without invoking the non-terminal (would orphan tool_result).
      client.messages.create.mockResolvedValueOnce({
        id: 'msg_mixed',
        content: [
          {
            type: 'tool_use',
            id: nextId(),
            name: FETCH_FILE_TOOL_NAME,
            input: { path: 'src/checkout.js' },
          },
          {
            type: 'tool_use',
            id: nextId(),
            name: EMIT_FINDING_TOOL_NAME,
            input: { findings: [] },
          },
        ],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(result.turnCount).toBe(1);
      expect(repoContext.fetchFile).not.toHaveBeenCalled();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].tool_name).toBe(EMIT_FINDING_TOOL_NAME);
    });

    it('[emit_finding, emit_finding] — takes the FIRST emit_finding payload', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce({
        id: 'msg_dup',
        content: [
          {
            type: 'tool_use',
            id: nextId(),
            name: EMIT_FINDING_TOOL_NAME,
            input: {
              findings: [
                {
                  rule_id: 'no-var',
                  title: 'first',
                  message: 'first',
                },
              ],
            },
          },
          {
            type: 'tool_use',
            id: nextId(),
            name: EMIT_FINDING_TOOL_NAME,
            input: {
              findings: [
                {
                  rule_id: 'no-var',
                  title: 'second',
                  message: 'second',
                },
              ],
            },
          },
        ],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext: makeRepoContextProvider(),
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].title).toBe('first');
    });
  });

  describe('loop — turn cap', () => {
    it('throws turn_cap_exceeded after 6 turns of non-terminal tool calls (turnCount=6)', async () => {
      const client = makeMockClient();
      for (let i = 0; i < 6; i++) {
        client.messages.create.mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, {
            path: `src/file-${i}.js`,
          }),
        );
      }
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      let caught: AnthropicRequestError | undefined;
      try {
        await reviewer.analyzeDiff({
          diff: REAL_DIFF,
          rules: REAL_RULES,
          repoContext: makeRepoContextProvider(),
        });
      } catch (err) {
        caught = err as AnthropicRequestError;
      }

      expect(caught).toBeDefined();
      expect(caught?.errorCode).toBe('turn_cap_exceeded');
      expect(caught?.turnCount).toBe(6);
      expect(caught?.toolCalls).toHaveLength(6);
      expect(client.messages.create).toHaveBeenCalledTimes(6);
    });
  });

  describe('hallucinated rule_id filtering', () => {
    it('drops findings whose rule_id is not in the retrieved set', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        emitFindingResponse([
          { rule_id: 'no-var', title: 'real', message: 'real' },
          { rule_id: 'made-up-rule', title: 'fake', message: 'fake' },
        ]),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext: makeRepoContextProvider(),
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].rule_id).toBe('no-var');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropped hallucinated rule_id="made-up-rule"'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('tool dispatch — validation', () => {
    it('non-terminal tool_use with invalid input (path: 123) returns is_error tool_result; loop continues', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, { path: 123 }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      // The validation rejected the bad input — provider was NOT called.
      expect(repoContext.fetchFile).not.toHaveBeenCalled();
      // Loop continued — turn 2 saw the is_error tool_result.
      expect(result.turnCount).toBe(2);
      // Turn 2's user message has a tool_result with is_error=true.
      const turn2 = client.messages.create.mock.calls[1][0];
      const toolResult = turn2.messages[2].content[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content[0].text).toContain('invalid_input');
    });

    it('terminal emit_finding with findings=null throws malformed_emit_finding', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce({
        id: 'msg_bad_emit',
        content: [
          {
            type: 'tool_use',
            id: nextId(),
            name: EMIT_FINDING_TOOL_NAME,
            input: { findings: null },
          },
        ],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(
        reviewer.analyzeDiff({
          diff: REAL_DIFF,
          rules: REAL_RULES,
          repoContext: makeRepoContextProvider(),
        }),
      ).rejects.toMatchObject({
        name: 'AnthropicRequestError',
        errorCode: 'malformed_emit_finding',
      });
    });

    it('malformed_emit_finding on turn N carries the partial turnCount + toolCalls (review-fix)', async () => {
      // Mirror turn_cap_exceeded: when the loop fails mid-flight, the
      // partial loop state must reach ReviewsService.markFailed so the
      // failed `reviews` row reflects how far the agent got. Without
      // this, a malformed emit on turn 5 is indistinguishable from a
      // pre-turn-1 auth failure (both look like turn_count=0).
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, {
            path: 'src/checkout.js',
          }),
        )
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, {
            path: 'src/retry-queue.js',
          }),
        )
        .mockResolvedValueOnce({
          id: 'msg_bad_emit_turn3',
          content: [
            {
              type: 'tool_use',
              id: nextId(),
              name: EMIT_FINDING_TOOL_NAME,
              input: { findings: [{ title: 'missing rule_id', message: 'oops' }] },
            },
          ],
          model: 'claude-haiku-4-5-20251001',
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
        });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      let caught: AnthropicRequestError | undefined;
      try {
        await reviewer.analyzeDiff({
          diff: REAL_DIFF,
          rules: REAL_RULES,
          repoContext: makeRepoContextProvider(),
        });
      } catch (err) {
        caught = err as AnthropicRequestError;
      }

      expect(caught?.errorCode).toBe('malformed_emit_finding');
      // turnCount is the turn at which the malformed emit happened.
      // toolCalls contains only the non-terminal records that
      // successfully landed BEFORE the throw — the malformed emit
      // itself doesn't push a record (the validation check throws
      // before the success-path push). So turnCount=3 with
      // toolCalls.length=2 is the truthful state: "two tool calls
      // succeeded, the third turn's emit was malformed".
      expect(caught?.turnCount).toBe(3);
      expect(caught?.toolCalls).toHaveLength(2);
      expect(caught?.toolCalls?.[0].tool_name).toBe(FETCH_FILE_TOOL_NAME);
      expect(caught?.toolCalls?.[1].tool_name).toBe(FETCH_FILE_TOOL_NAME);
    });

    it('terminal emit_finding with a finding missing rule_id throws malformed_emit_finding', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        emitFindingResponse([{ title: 'no rule', message: 'oops' }]),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(
        reviewer.analyzeDiff({
          diff: REAL_DIFF,
          rules: REAL_RULES,
          repoContext: makeRepoContextProvider(),
        }),
      ).rejects.toMatchObject({
        errorCode: 'malformed_emit_finding',
      });
    });
  });

  describe('tool dispatch — provider error handling', () => {
    it('repoContext undefined → every non-terminal tool returns is_error; loop continues', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, {
            path: 'src/x.js',
          }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        // no repoContext
      });

      expect(result.turnCount).toBe(2);
      const turn2 = client.messages.create.mock.calls[1][0];
      const toolResult = turn2.messages[2].content[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content[0].text).toMatch(/no repo context/i);
    });

    it('provider returns ok:false → tool_result carries is_error=true; loop continues', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, {
            path: 'src/missing.js',
          }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider({
        fetchFile: jest.fn(async () => ({
          ok: false as const,
          reason: 'not_found' as const,
          message: 'file not found: src/missing.js',
        })),
      });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(result.turnCount).toBe(2);
      const turn2 = client.messages.create.mock.calls[1][0];
      const toolResult = turn2.messages[2].content[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content[0].text).toContain('not_found');
    });

    it('provider throws unexpectedly → wrapped as is_error tool_result; loop continues', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FILE_TOOL_NAME, {
            path: 'src/x.js',
          }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider({
        fetchFile: jest.fn(async () => {
          throw new Error('provider crashed');
        }),
      });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(result.turnCount).toBe(2);
      const turn2 = client.messages.create.mock.calls[1][0];
      const toolResult = turn2.messages[2].content[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content[0].text).toContain('tool_invocation_error');
    });

    it('fetch_function_definition arm: happy path invokes provider with name + optional file', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FUNCTION_TOOL_NAME, {
            name: 'chargeCard',
            file: 'src/checkout.js',
          }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(repoContext.fetchFunctionDefinition).toHaveBeenCalledWith(
        'chargeCard',
        'src/checkout.js',
      );
    });

    it('fetch_function_definition arm: name=123 returns is_error invalid_input', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FUNCTION_TOOL_NAME, { name: 123 }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(repoContext.fetchFunctionDefinition).not.toHaveBeenCalled();
      const turn2 = client.messages.create.mock.calls[1][0];
      const toolResult = turn2.messages[2].content[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content[0].text).toContain('invalid_input');
      expect(toolResult.content[0].text).toContain('name');
    });

    it('fetch_function_definition arm: file=non-string returns is_error invalid_input', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_FUNCTION_TOOL_NAME, {
            name: 'chargeCard',
            file: 42,
          }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(repoContext.fetchFunctionDefinition).not.toHaveBeenCalled();
      const turn2 = client.messages.create.mock.calls[1][0];
      expect(turn2.messages[2].content[0].content[0].text).toContain('file');
    });

    it('fetch_prior_review arm: forwards typed query fields to the provider', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_PRIOR_REVIEW_TOOL_NAME, {
            file_path: 'src/x.js',
            rule_id: 'no-var',
          }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(repoContext.fetchPriorReview).toHaveBeenCalledWith({
        file_path: 'src/x.js',
        rule_id: 'no-var',
      });
    });

    it('fetch_prior_review arm: rule_id=123 returns is_error invalid_input', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(
          nonTerminalToolUseResponse(FETCH_PRIOR_REVIEW_TOOL_NAME, {
            rule_id: 123,
          }),
        )
        .mockResolvedValueOnce(emitFindingResponse([]));
      const repoContext = makeRepoContextProvider();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext,
      });

      expect(repoContext.fetchPriorReview).not.toHaveBeenCalled();
      const turn2 = client.messages.create.mock.calls[1][0];
      expect(turn2.messages[2].content[0].is_error).toBe(true);
    });

    it('unknown tool name returns is_error unknown_tool; loop continues', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce({
          id: 'msg_unknown',
          content: [
            {
              type: 'tool_use',
              id: nextId(),
              name: 'made_up_tool',
              input: { foo: 'bar' },
            },
          ],
          model: 'claude-haiku-4-5-20251001',
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
        })
        .mockResolvedValueOnce(emitFindingResponse([]));
      const reviewer = new TestableAnthropicLlmReviewer(
        makeConfig(),
        client,
      );

      const result = await reviewer.analyzeDiff({
        diff: REAL_DIFF,
        rules: REAL_RULES,
        repoContext: makeRepoContextProvider(),
      });

      expect(result.turnCount).toBe(2);
      const turn2 = client.messages.create.mock.calls[1][0];
      const toolResult = turn2.messages[2].content[0];
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content[0].text).toContain('unknown_tool');
      expect(toolResult.content[0].text).toContain('made_up_tool');
    });
  });

  describe('loop — response-shape edge cases', () => {
    it('text-only response under tool_choice:any throws unexpected_response_shape', async () => {
      // The system prompt requires Claude to call one of the four
      // tools every turn. If Claude returns only text blocks (no
      // tool_use), the loop has nothing to dispatch. Treat as a
      // protocol violation: throw unexpected_response_shape rather
      // than silently looping or completing with no findings.
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce({
        id: 'msg_text_only',
        content: [{ type: 'text', text: 'No tool call here.' }],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(
        reviewer.analyzeDiff({
          diff: REAL_DIFF,
          rules: REAL_RULES,
          repoContext: makeRepoContextProvider(),
        }),
      ).rejects.toMatchObject({
        name: 'AnthropicRequestError',
        errorCode: 'unexpected_response_shape',
      });
    });
  });

  describe('SDK error wrapping (carried forward from Day-3)', () => {
    it('wraps APIError(401, authentication_error) and scrubs the API key', async () => {
      const client = makeMockClient();
      const headers = new Headers({ 'request-id': 'req_xyz' });
      const apiError = new APIError(
        401,
        {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        },
        'whatever',
        headers,
      );
      client.messages.create.mockRejectedValueOnce(apiError);
      const config = makeConfig({
        anthropicApiKey: 'sk-ant-secret-value-please-do-not-log-this-001',
      } as Partial<ConfigService>);
      const reviewer = new TestableAnthropicLlmReviewer(config, client);

      let caught: AnthropicRequestError | undefined;
      try {
        await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });
      } catch (err) {
        caught = err as AnthropicRequestError;
      }

      expect(caught?.status).toBe(401);
      expect(caught?.errorCode).toBe('authentication_error');
      expect(caught?.message).not.toContain(
        'sk-ant-secret-value-please-do-not-log-this-001',
      );
      expect(caught?.serverMessage).toBe('invalid x-api-key');
    });

    it('maps 400 + "credit balance is too low" to credit_balance_too_low', async () => {
      const client = makeMockClient();
      const headers = new Headers({ 'request-id': 'req_credit' });
      client.messages.create.mockRejectedValueOnce(
        new APIError(
          400,
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message:
                'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
            },
          },
          'msg',
          headers,
        ),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(
        reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES }),
      ).rejects.toMatchObject({ errorCode: 'credit_balance_too_low' });
    });

    it('wraps a transport error with status 0 and preserves the cause', async () => {
      const client = makeMockClient();
      const transportError = new TypeError('fetch failed: ECONNRESET');
      client.messages.create.mockRejectedValueOnce(transportError);
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      let caught: AnthropicRequestError | undefined;
      try {
        await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });
      } catch (err) {
        caught = err as AnthropicRequestError;
      }

      expect(caught?.status).toBe(0);
      expect(caught?.cause).toBe(transportError);
    });
  });

  describe('lazy client construction', () => {
    it('does not call createClient on construction', () => {
      const client = makeMockClient();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);
      expect(client.messages.create).not.toHaveBeenCalled();
      expect(reviewer).toBeInstanceOf(AnthropicLlmReviewer);
    });
  });
});

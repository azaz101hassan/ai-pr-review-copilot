import { Logger } from '@nestjs/common';
import { APIError } from '@anthropic-ai/sdk';
import {
  AnthropicLlmReviewer,
  SYSTEM_PROMPT,
  REPORT_FINDINGS_TOOL,
} from '../../../src/infrastructure/anthropic/anthropic-llm-reviewer';
import { AnthropicRequestError } from '../../../src/infrastructure/anthropic/anthropic-request.error';
import { PROMPT_AND_TOOL_VERSION } from '../../../src/modules/reviews/types/llm-reviewer';
import { ConfigService } from '@/config';

// Spec for the Anthropic adapter. The SDK client is mocked at the
// `createClient()` seam — these tests own request shape (cache_control,
// tool_choice, tools, system blocks), response parsing (tool_use
// extraction, stop_reason gating, hallucinated rule_id filtering),
// error wrapping (scrub discipline), and the by-design prompt-cache
// invariant (system prompt + tool definition byte-identical across
// calls).

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
    ...overrides,
  } as ConfigService;
}

// Test seam: subclass that lets us substitute the SDK client without
// jest.mock() on @anthropic-ai/sdk. Same pattern as
// TestableChromaVectorStore.
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

function toolUseResponse(input: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test',
    content: [
      {
        type: 'tool_use',
        id: 'tool_test',
        name: 'report_findings',
        input,
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 1234,
      output_tokens: 56,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    ...overrides,
  };
}

describe('AnthropicLlmReviewer', () => {
  describe('analyzeDiff — request shape (the cache invariant)', () => {
    it('sends system content with cache_control: ephemeral and a single text block', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(toolUseResponse({ findings: [] }));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      expect(client.messages.create).toHaveBeenCalledTimes(1);
      const args = client.messages.create.mock.calls[0][0];
      expect(args.system).toEqual([
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('forces the report_findings tool via tool_choice', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(toolUseResponse({ findings: [] }));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      const args = client.messages.create.mock.calls[0][0];
      expect(args.tool_choice).toEqual({ type: 'tool', name: 'report_findings' });
      expect(args.tools).toEqual([REPORT_FINDINGS_TOOL]);
    });

    it('does NOT include `severity` in the tool schema sent to the SDK', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(toolUseResponse({ findings: [] }));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      const tool = client.messages.create.mock.calls[0][0].tools[0];
      const findingProps = tool.input_schema.properties.findings.items.properties;
      expect(findingProps.severity).toBeUndefined();
      expect(tool.input_schema.properties.findings.items.required).not.toContain('severity');
    });

    it('uses the model from ConfigService', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(toolUseResponse({ findings: [] }));
      const reviewer = new TestableAnthropicLlmReviewer(
        makeConfig({ anthropicModel: 'claude-sonnet-4-6' } as Partial<ConfigService>),
        client,
      );

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      expect(client.messages.create.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    });

    it('request args are byte-identical across two consecutive calls (cache-hit invariant)', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(toolUseResponse({ findings: [] }))
        .mockResolvedValueOnce(toolUseResponse({ findings: [] }));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });
      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      const first = client.messages.create.mock.calls[0][0];
      const second = client.messages.create.mock.calls[1][0];
      expect(first.system).toEqual(second.system);
      expect(first.tools).toEqual(second.tools);
      expect(first.tool_choice).toEqual(second.tool_choice);
    });
  });

  describe('analyzeDiff — happy paths', () => {
    it('returns a single finding from a single tool_use block', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        toolUseResponse({
          findings: [
            {
              rule_id: 'no-var',
              title: 'Use let/const',
              message: 'Replace `var` with `let` or `const`.',
            },
          ],
        }),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toEqual({
        rule_id: 'no-var',
        title: 'Use let/const',
        message: 'Replace `var` with `let` or `const`.',
        location_hint: null,
        citation: null,
      });
      // Severity is not on the Finding type.
      expect((result.findings[0] as unknown as Record<string, unknown>).severity).toBeUndefined();
      expect(result.model).toBe('claude-haiku-4-5-20251001');
      expect(result.promptVersion).toBe(PROMPT_AND_TOOL_VERSION);
    });

    it('returns an empty findings array when Claude reports no violations', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(toolUseResponse({ findings: [] }));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      expect(result.findings).toEqual([]);
    });

    it('preserves order across multiple findings', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        toolUseResponse({
          findings: [
            { rule_id: 'no-var', title: 'A', message: 'a' },
            { rule_id: 'no-var', title: 'B', message: 'b' },
            { rule_id: 'no-var', title: 'C', message: 'c' },
          ],
        }),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      expect(result.findings.map((f) => f.title)).toEqual(['A', 'B', 'C']);
    });

    it('propagates cache usage from the response', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        toolUseResponse(
          { findings: [] },
          {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 800,
              cache_read_input_tokens: 1200,
            },
          },
        ),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      expect(result.usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 800,
        cache_read_input_tokens: 1200,
      });
    });
  });

  describe('analyzeDiff — hallucinated rule_id filtering', () => {
    it('drops findings whose rule_id is not in the retrieved set and logs a warning', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        toolUseResponse({
          findings: [
            { rule_id: 'no-var', title: 'real', message: 'real' },
            { rule_id: 'made-up-rule', title: 'fake', message: 'fake' },
          ],
        }),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      const result = await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].rule_id).toBe('no-var');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropped hallucinated rule_id="made-up-rule"'),
      );
      warnSpy.mockRestore();
    });

    it('logs only the rule_id slug — never the finding body — on a dropped hallucination', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        toolUseResponse({
          findings: [
            {
              rule_id: 'fabricated',
              title: 'secret-API-key sk-leak-12345',
              message: REAL_DIFF, // would expose the diff if naively logged
              citation: REAL_DIFF,
            },
          ],
        }),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      for (const call of warnSpy.mock.calls) {
        const message = String(call[0] ?? '');
        expect(message).not.toContain('sk-leak-12345');
        expect(message).not.toContain('var x = 1');
        expect(message).not.toContain('let x = 1');
      }
      warnSpy.mockRestore();
    });
  });

  describe('analyzeDiff — response-shape failure modes', () => {
    it('throws unexpected_response_shape when the response contains no tool_use block', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Just commentary, no tool call.' }],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
      });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES })).rejects.toMatchObject(
        { name: 'AnthropicRequestError', status: 200, errorCode: 'unexpected_response_shape' },
      );
    });

    it('throws unexpected_response_shape when the tool_use block has the wrong tool name', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 't_x',
            name: 'some_other_tool',
            input: { findings: [] },
          },
        ],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 },
      });
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES })).rejects.toMatchObject(
        { name: 'AnthropicRequestError', status: 200, errorCode: 'unexpected_response_shape' },
      );
    });

    it('throws unexpected_response_shape when tool_use input has no `findings` array', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(toolUseResponse({ wrong_field: 'oops' }));
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES })).rejects.toMatchObject(
        { name: 'AnthropicRequestError', status: 200, errorCode: 'unexpected_response_shape' },
      );
    });

    it('throws truncated_response when stop_reason is max_tokens', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        toolUseResponse({ findings: [] }, { stop_reason: 'max_tokens' }),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES })).rejects.toMatchObject(
        { name: 'AnthropicRequestError', status: 200, errorCode: 'truncated_response' },
      );
    });

    it('throws truncated_response when stop_reason is refusal', async () => {
      const client = makeMockClient();
      client.messages.create.mockResolvedValueOnce(
        toolUseResponse({ findings: [] }, { stop_reason: 'refusal' }),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES })).rejects.toMatchObject(
        { name: 'AnthropicRequestError', status: 200, errorCode: 'truncated_response' },
      );
    });
  });

  describe('analyzeDiff — SDK error wrapping (scrub discipline)', () => {
    it('wraps APIError(401, authentication_error) without leaking the key, diff, or rule body', async () => {
      const client = makeMockClient();
      const headers = new Headers({ 'request-id': 'req_xyz' });
      const apiError = new APIError(
        401,
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        'whatever',
        headers,
      );
      client.messages.create.mockRejectedValueOnce(apiError);
      const config = makeConfig({ anthropicApiKey: 'sk-ant-secret-value-please-do-not-log-this-001' } as Partial<ConfigService>);
      const reviewer = new TestableAnthropicLlmReviewer(config, client);

      let caught: AnthropicRequestError | undefined;
      try {
        await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });
      } catch (err) {
        caught = err as AnthropicRequestError;
      }

      expect(caught).toBeDefined();
      expect(caught?.name).toBe('AnthropicRequestError');
      expect(caught?.status).toBe(401);
      expect(caught?.errorCode).toBe('authentication_error');
      // Scrub assertions: the API KEY VALUE, diff text, and rule body
      // must never appear in the error message. (The server's
      // textual `error.message` is included as `serverMessage` —
      // intentionally surfaced so operators can diagnose 400s
      // without re-running with verbose logging. The server message
      // is the server's explanation, not echoed input.)
      expect(caught?.message).not.toContain('sk-ant-secret-value-please-do-not-log-this-001');
      expect(caught?.message).not.toContain('var x = 1');
      expect(caught?.message).not.toContain('let x = 1');
      expect(caught?.message).not.toContain('Prefer let/const');
      // serverMessage IS the API's text explanation — surfaced.
      expect(caught?.serverMessage).toBe('invalid x-api-key');
    });

    it('maps 400 + "credit balance is too low" to errorCode=credit_balance_too_low', async () => {
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

      let caught: AnthropicRequestError | undefined;
      try {
        await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });
      } catch (err) {
        caught = err as AnthropicRequestError;
      }

      expect(caught?.status).toBe(400);
      expect(caught?.errorCode).toBe('credit_balance_too_low');
      expect(caught?.serverMessage).toMatch(/credit balance is too low/i);
      // Other 400 + invalid_request_error cases still get the raw code.
      expect(caught?.errorCode).not.toBe('invalid_request_error');
    });

    it('leaves other 400 + invalid_request_error responses with the raw errorCode', async () => {
      const client = makeMockClient();
      const headers = new Headers({ 'request-id': 'req_schema' });
      client.messages.create.mockRejectedValueOnce(
        new APIError(
          400,
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'tools.0.input_schema: invalid keyword "additionalProperties"',
            },
          },
          'msg',
          headers,
        ),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES })).rejects.toMatchObject(
        {
          status: 400,
          errorCode: 'invalid_request_error',
        },
      );
    });

    it('wraps APIError(429, rate_limit_error)', async () => {
      const client = makeMockClient();
      const headers = new Headers({ 'request-id': 'req_x' });
      client.messages.create.mockRejectedValueOnce(
        new APIError(
          429,
          { type: 'error', error: { type: 'rate_limit_error', message: 'too many' } },
          'msg',
          headers,
        ),
      );
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      await expect(reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES })).rejects.toMatchObject(
        { name: 'AnthropicRequestError', status: 429, errorCode: 'rate_limit_error' },
      );
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

      expect(caught?.name).toBe('AnthropicRequestError');
      expect(caught?.status).toBe(0);
      expect(caught?.cause).toBe(transportError);
    });
  });

  describe('lazy client construction', () => {
    it('does not call createClient on construction (DI bootstrap stays network-free)', () => {
      const client = makeMockClient();
      const reviewer = new TestableAnthropicLlmReviewer(makeConfig(), client);

      // No call has happened — the SDK construction is lazy. The mock
      // is captured but never invoked until the first analyzeDiff.
      expect(client.messages.create).not.toHaveBeenCalled();
      // Sanity: the reviewer is the right type.
      expect(reviewer).toBeInstanceOf(AnthropicLlmReviewer);
    });

    it('createClient is only called once even across multiple analyzeDiff invocations', async () => {
      const client = makeMockClient();
      client.messages.create
        .mockResolvedValueOnce(toolUseResponse({ findings: [] }))
        .mockResolvedValueOnce(toolUseResponse({ findings: [] }));
      const createSpy = jest.fn(() => client as never);
      class SpyReviewer extends AnthropicLlmReviewer {
        protected override createClient(): never {
          return createSpy() as never;
        }
      }
      const reviewer = new SpyReviewer(makeConfig());

      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });
      await reviewer.analyzeDiff({ diff: REAL_DIFF, rules: REAL_RULES });

      expect(createSpy).toHaveBeenCalledTimes(1);
    });
  });
});

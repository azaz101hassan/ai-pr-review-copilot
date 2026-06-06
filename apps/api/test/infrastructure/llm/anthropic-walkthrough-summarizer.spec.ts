// apps/api/test/infrastructure/llm/anthropic-walkthrough-summarizer.spec.ts
import { AnthropicWalkthroughSummarizer } from '@/infrastructure/llm/anthropic-walkthrough-summarizer';

const INPUT = {
  diff: 'diff --git a/x b/x\n+console.log(1);',
  findings: [
    { rule_id: 'no-console', title: 'No console', severity: 'warning' as const },
  ],
  retrievedRules: [
    { rule_id: 'no-console', source: 'a.json', title: 'No console' },
  ],
};

function makeClientStub(returns: string | Error) {
  return {
    messages: {
      create: jest.fn().mockImplementation(async () => {
        if (returns instanceof Error) throw returns;
        return {
          content: [{ type: 'text', text: returns }],
        };
      }),
    },
  };
}

function makeRawClientStub(rawResponse: unknown) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue(rawResponse),
    },
  };
}

describe('AnthropicWalkthroughSummarizer', () => {
  it('returns the intro on a clean text response', async () => {
    const client = makeClientStub('This PR adds a console statement.');
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toEqual({ intro: 'This PR adds a console statement.' });
  });

  it('returns null when the LLM throws', async () => {
    const client = makeClientStub(new Error('boom'));
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('returns null when the LLM call times out', async () => {
    const slowClient = {
      messages: {
        create: jest
          .fn()
          .mockImplementation(() => new Promise<never>(() => undefined)),
      },
    };
    const summarizer = new AnthropicWalkthroughSummarizer(slowClient as any, {
      model: 'test-model',
      timeoutMs: 50,
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('rejects a "no issues" intro when findings is non-empty', async () => {
    const client = makeClientStub('This is a clean refactor with no issues.');
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('accepts a "no issues" intro when findings is empty', async () => {
    const client = makeClientStub('A clean refactor with no issues.');
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize({ ...INPUT, findings: [] });
    expect(result).toEqual({ intro: 'A clean refactor with no issues.' });
  });

  it('caps max_tokens at 250 in the API call', async () => {
    const client = makeClientStub('Short intro.');
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await summarizer.summarize(INPUT);
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 250 }),
    );
  });

  it('returns null when the response is null (e.g. HTTP 204)', async () => {
    const client = makeRawClientStub(null);
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null when response.content is not an array', async () => {
    const client = makeRawClientStub({ content: 'oops' });
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null when there is no text block', async () => {
    const client = makeRawClientStub({ content: [] });
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null when the text block text is not a string', async () => {
    const client = makeRawClientStub({ content: [{ type: 'text', text: 123 }] });
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null on a whitespace-only intro', async () => {
    const client = makeRawClientStub({ content: [{ type: 'text', text: '   ' }] });
    const summarizer = new AnthropicWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });
});

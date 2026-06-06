// apps/api/test/infrastructure/llm/openrouter-walkthrough-summarizer.spec.ts
import { OpenRouterWalkthroughSummarizer } from '@/infrastructure/llm/openrouter-walkthrough-summarizer';

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
    chat: {
      completions: {
        create: jest.fn().mockImplementation(async () => {
          if (returns instanceof Error) throw returns;
          return {
            choices: [{ message: { content: returns } }],
          };
        }),
      },
    },
  };
}

function makeRawClientStub(rawResponse: unknown) {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue(rawResponse),
      },
    },
  };
}

describe('OpenRouterWalkthroughSummarizer', () => {
  it('returns the intro on a clean text response', async () => {
    const client = makeClientStub('This PR adds a console statement.');
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toEqual({ intro: 'This PR adds a console statement.' });
  });

  it('returns null when the LLM throws', async () => {
    const client = makeClientStub(new Error('boom'));
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('returns null when the LLM call times out', async () => {
    const slowClient = {
      chat: {
        completions: {
          create: jest
            .fn()
            .mockImplementation(() => new Promise<never>(() => undefined)),
        },
      },
    };
    const summarizer = new OpenRouterWalkthroughSummarizer(slowClient as any, {
      model: 'test-model',
      timeoutMs: 50,
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('rejects a "no issues" intro when findings is non-empty', async () => {
    const client = makeClientStub('This is a clean refactor with no issues.');
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize(INPUT);
    expect(result).toBeNull();
  });

  it('accepts a "no issues" intro when findings is empty', async () => {
    const client = makeClientStub('A clean refactor with no issues.');
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    const result = await summarizer.summarize({ ...INPUT, findings: [] });
    expect(result).toEqual({ intro: 'A clean refactor with no issues.' });
  });

  it('caps max_tokens at 250 in the API call', async () => {
    const client = makeClientStub('Short intro.');
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await summarizer.summarize(INPUT);
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 250 }),
    );
  });

  it('returns null when the response is null (e.g. HTTP 204)', async () => {
    const client = makeRawClientStub(null);
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null when response.choices is not an array', async () => {
    const client = makeRawClientStub({ choices: 'oops' });
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null when there are no choices', async () => {
    const client = makeRawClientStub({ choices: [] });
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null when message.content is not a string', async () => {
    const client = makeRawClientStub({
      choices: [{ message: { content: 123 } }],
    });
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null when message.content is null (e.g. tool response)', async () => {
    const client = makeRawClientStub({
      choices: [{ message: { content: null } }],
    });
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });

  it('returns null on a whitespace-only intro', async () => {
    const client = makeRawClientStub({
      choices: [{ message: { content: '   ' } }],
    });
    const summarizer = new OpenRouterWalkthroughSummarizer(client as any, {
      model: 'test-model',
    });
    await expect(summarizer.summarize(INPUT)).resolves.toBeNull();
  });
});

import { GitHubRepoContextProvider } from '@/infrastructure/github';
import type { IReviewFindingRepository } from '@/modules/reviews/types/review-finding.repository';
import type { Octokit } from 'octokit';
import type { PriorReviewEntry } from '@/modules/reviews/types/repo-context-provider';

// Test seam: construct the provider with a hand-rolled Octokit-like
// object that satisfies the narrow surface area we actually use
// (`octokit.rest.repos.getContent`). The real Octokit class is the
// CJS stub at test/stubs/octokit.cjs so any direct construction
// would throw — we never go through `new Octokit(...)` here.

interface FakeOctokitOpts {
  getContent?: (args: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }) => Promise<{ data: unknown }>;
}

function makeFakeOctokit(opts: FakeOctokitOpts = {}): Octokit {
  const getContent = opts.getContent ?? (async () => ({ data: null }));
  return {
    rest: {
      repos: {
        getContent: (args: {
          owner: string;
          repo: string;
          path: string;
          ref: string;
        }) => getContent(args),
      },
    },
  } as unknown as Octokit;
}

function makeProvider(opts: {
  octokit?: Octokit;
  priorRepo?: IReviewFindingRepository;
  pr_node_id?: string;
} = {}) {
  return new GitHubRepoContextProvider({
    octokit: opts.octokit ?? makeFakeOctokit(),
    owner: 'octocat',
    repo: 'demo',
    head_sha: 'abc123',
    pr_node_id: opts.pr_node_id ?? 'PR_default',
    priorReviewRepo:
      opts.priorRepo ??
      ({
        insertMany: () => undefined,
        findByReviewId: () => [],
        findByPrNodeIdForPriorReview: () => [],
      } as IReviewFindingRepository),
  });
}

describe('GitHubRepoContextProvider.fetchFile', () => {
  it('decodes a base64 file response', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => ({
          data: {
            type: 'file',
            size: 12,
            encoding: 'base64',
            content: Buffer.from('hello world\n').toString('base64'),
          },
        }),
      }),
    });
    const result = await provider.fetchFile('src/index.ts');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('hello world\n');
      expect(result.path).toBe('src/index.ts');
    }
  });

  it('returns invalid_input for an empty path', async () => {
    const provider = makeProvider();
    const result = await provider.fetchFile('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_input');
  });

  it('returns not_found when the API responds with a directory', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => ({ data: [{ type: 'file', name: 'a.ts' }] }),
      }),
    });
    const result = await provider.fetchFile('src');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('returns not_found when file size exceeds 1 MB', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => ({
          data: {
            type: 'file',
            size: 2_000_000,
            encoding: 'base64',
            content: 'irrelevant',
          },
        }),
      }),
    });
    const result = await provider.fetchFile('huge-bundle.js');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.message).toContain('1 MB');
    }
  });

  it('maps a 404 to not_found', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => {
          const err = new Error('Not Found') as Error & { status?: number };
          err.status = 404;
          throw err;
        },
      }),
    });
    const result = await provider.fetchFile('missing.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('maps a 429 to rate_limited with parsed retry-after', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => {
          const err = new Error('Rate limited') as Error & {
            status?: number;
            response?: { headers: Record<string, string> };
          };
          err.status = 429;
          err.response = { headers: { 'retry-after': '30' } };
          throw err;
        },
      }),
    });
    const result = await provider.fetchFile('src/index.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited');
      expect(result.retryAfterMs).toBe(30_000);
    }
  });

  it('maps 403 with x-ratelimit-remaining=0 to rate_limited', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => {
          const err = new Error('rate limit') as Error & {
            status?: number;
            response?: { headers: Record<string, string> };
          };
          err.status = 403;
          err.response = { headers: { 'x-ratelimit-remaining': '0' } };
          throw err;
        },
      }),
    });
    const result = await provider.fetchFile('src/index.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rate_limited');
  });

  it('maps a plain 403 to forbidden', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => {
          const err = new Error('forbidden') as Error & { status?: number };
          err.status = 403;
          throw err;
        },
      }),
    });
    const result = await provider.fetchFile('private.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('forbidden');
  });

  it('maps a 5xx to network', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => {
          const err = new Error('upstream') as Error & { status?: number };
          err.status = 503;
          throw err;
        },
      }),
    });
    const result = await provider.fetchFile('src/index.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('network');
  });

  it('maps an unknown transport error to network without throwing', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    });
    const result = await provider.fetchFile('src/index.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('network');
  });
});

describe('GitHubRepoContextProvider.fetchFunctionDefinition', () => {
  it('returns invalid_input when called without a file hint', async () => {
    const provider = makeProvider();
    const result = await provider.fetchFunctionDefinition('foo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_input');
  });

  it('returns invalid_input when name is missing', async () => {
    const provider = makeProvider();
    const result = await provider.fetchFunctionDefinition('', 'a.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_input');
  });

  it('returns parse_error when grep finds no match', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => ({
          data: {
            type: 'file',
            size: 32,
            encoding: 'base64',
            content: Buffer.from('// no function here').toString('base64'),
          },
        }),
      }),
    });
    const result = await provider.fetchFunctionDefinition('missing', 'a.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse_error');
  });

  it('composes fetchFile + grep on a happy match', async () => {
    const source = [
      '// preamble',
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
    ].join('\n');
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => ({
          data: {
            type: 'file',
            size: source.length,
            encoding: 'base64',
            content: Buffer.from(source).toString('base64'),
          },
        }),
      }),
    });
    const result = await provider.fetchFunctionDefinition('greet', 'a.ts');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe('a.ts');
      expect(result.content).toContain('greet(');
    }
  });

  it('propagates fetchFile errors directly (404 stays 404)', async () => {
    const provider = makeProvider({
      octokit: makeFakeOctokit({
        getContent: async () => {
          const err = new Error('Not Found') as Error & { status?: number };
          err.status = 404;
          throw err;
        },
      }),
    });
    const result = await provider.fetchFunctionDefinition('greet', 'a.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

describe('GitHubRepoContextProvider.fetchPriorReview', () => {
  function makePriorRepoWith(rows: PriorReviewEntry[]): IReviewFindingRepository {
    return {
      insertMany: () => undefined,
      findByReviewId: () => [],
      findByPrNodeIdForPriorReview: () => rows,
    };
  }

  it('returns an empty array when no prior runs exist', async () => {
    const provider = makeProvider({ priorRepo: makePriorRepoWith([]) });
    const result = await provider.fetchPriorReview({ pr_node_id: 'PR_abc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toEqual([]);
  });

  it('passes through rows untouched when no filters are provided', async () => {
    const sample: PriorReviewEntry[] = [
      {
        review_id: 'r1',
        finding_id: 'f1',
        rule_id: 'rule.no-console',
        file_path: 'src/a.ts',
        location_hint: 'src/a.ts:12',
        message: 'avoid console.log',
        dismissed_at: null,
      },
    ];
    const provider = makeProvider({ priorRepo: makePriorRepoWith(sample) });
    const result = await provider.fetchPriorReview({ pr_node_id: 'PR_abc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toHaveLength(1);
  });

  it('filters by file_path', async () => {
    const sample: PriorReviewEntry[] = [
      {
        review_id: 'r1',
        finding_id: 'f1',
        rule_id: 'rule.x',
        file_path: 'src/a.ts',
        location_hint: 'src/a.ts:1',
        message: '',
        dismissed_at: null,
      },
      {
        review_id: 'r1',
        finding_id: 'f2',
        rule_id: 'rule.x',
        file_path: 'src/b.ts',
        location_hint: 'src/b.ts:1',
        message: '',
        dismissed_at: null,
      },
    ];
    const provider = makeProvider({ priorRepo: makePriorRepoWith(sample) });
    const result = await provider.fetchPriorReview({
      pr_node_id: 'PR_abc',
      file_path: 'src/a.ts',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toHaveLength(1);
      expect(result.content[0].file_path).toBe('src/a.ts');
    }
  });

  it('filters by rule_id', async () => {
    const sample: PriorReviewEntry[] = [
      {
        review_id: 'r1',
        finding_id: 'f1',
        rule_id: 'rule.x',
        file_path: 'src/a.ts',
        location_hint: 'src/a.ts:1',
        message: '',
        dismissed_at: null,
      },
      {
        review_id: 'r1',
        finding_id: 'f2',
        rule_id: 'rule.y',
        file_path: 'src/a.ts',
        location_hint: 'src/a.ts:5',
        message: '',
        dismissed_at: null,
      },
    ];
    const provider = makeProvider({ priorRepo: makePriorRepoWith(sample) });
    const result = await provider.fetchPriorReview({
      pr_node_id: 'PR_abc',
      rule_id: 'rule.y',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toHaveLength(1);
      expect(result.content[0].rule_id).toBe('rule.y');
    }
  });

  it('uses the run-scoped pr_node_id when the query omits it', async () => {
    let receivedNodeId: string | undefined;
    const repo: IReviewFindingRepository = {
      insertMany: () => undefined,
      findByReviewId: () => [],
      findByPrNodeIdForPriorReview: (id) => {
        receivedNodeId = id;
        return [];
      },
    };
    const provider = makeProvider({
      priorRepo: repo,
      pr_node_id: 'PR_run_scope',
    });
    await provider.fetchPriorReview({});
    expect(receivedNodeId).toBe('PR_run_scope');
  });

  it('wraps a repository failure as network rather than throwing', async () => {
    const repo: IReviewFindingRepository = {
      insertMany: () => undefined,
      findByReviewId: () => [],
      findByPrNodeIdForPriorReview: () => {
        throw new Error('SQLITE_BUSY');
      },
    };
    const provider = makeProvider({ priorRepo: repo });
    const result = await provider.fetchPriorReview({ pr_node_id: 'PR_x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('network');
  });
});

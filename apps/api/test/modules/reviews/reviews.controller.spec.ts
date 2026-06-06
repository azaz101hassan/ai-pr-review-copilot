import { ReviewsController } from '@/modules/reviews/reviews.controller';
import { ReviewsService, RunDryRunResult } from '@/modules/reviews/reviews.service';
import { LlmRequestError } from '@/infrastructure/llm';
import { IRepoContextProvider } from '@/modules/reviews/types/repo-context-provider';

// Unit spec — the service is mocked so this test owns only the
// controller's DTO-to-service mapping and pass-through semantics. The
// full HTTP pipeline (ValidationPipe, throttler, gating) is covered by
// the e2e spec in U7.

function makeServiceStub(result: RunDryRunResult | Error): ReviewsService {
  return {
    runDryRun:
      result instanceof Error
        ? jest.fn().mockRejectedValue(result)
        : jest.fn().mockResolvedValue(result),
  } as unknown as ReviewsService;
}

// Stand-in for whatever RepoContextProvider is bound to the
// REPO_CONTEXT_PROVIDER token. The controller passes it through;
// these tests don't inspect it.
const STUB_REPO_CTX: IRepoContextProvider = {
  fetchFile: jest.fn(),
  fetchFunctionDefinition: jest.fn(),
  fetchPriorReview: jest.fn(),
} as unknown as IRepoContextProvider;

function happyResult(): RunDryRunResult {
  return {
    review_id: 'rev-1',
    status: 'completed',
    findings: [],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    model: 'claude-haiku-4-5-20251001',
    prompt_version: 'v1',
    turn_count: 1,
    tool_calls: null,
    retrievedRules: [],
  };
}

describe('ReviewsController', () => {
  it('maps snake_case pr_node_id → camelCase prNodeId at the service call site', async () => {
    const service = makeServiceStub(happyResult());
    const controller = new ReviewsController(service, STUB_REPO_CTX);

    await controller.dryRun({ diff: 'diff', k: 5, pr_node_id: 'PR_abc' });

    expect(service.runDryRun).toHaveBeenCalledWith({
      diff: 'diff',
      k: 5,
      prNodeId: 'PR_abc',
      repoContext: STUB_REPO_CTX,
    });
  });

  it('maps absent pr_node_id to prNodeId: null', async () => {
    const service = makeServiceStub(happyResult());
    const controller = new ReviewsController(service, STUB_REPO_CTX);

    await controller.dryRun({ diff: 'diff' });

    expect(service.runDryRun).toHaveBeenCalledWith({
      diff: 'diff',
      k: undefined,
      prNodeId: null,
      repoContext: STUB_REPO_CTX,
    });
  });

  it('passes the injected REPO_CONTEXT_PROVIDER through to runDryRun (HTTP path uses NullRepoContextProvider in production)', async () => {
    const service = makeServiceStub(happyResult());
    const controller = new ReviewsController(service, STUB_REPO_CTX);

    await controller.dryRun({ diff: 'diff' });

    const args = (service.runDryRun as jest.Mock).mock.calls[0][0];
    expect(args.repoContext).toBe(STUB_REPO_CTX);
  });

  it('returns the service result unchanged (thin controller)', async () => {
    const result = happyResult();
    const service = makeServiceStub(result);
    const controller = new ReviewsController(service, STUB_REPO_CTX);

    const response = await controller.dryRun({ diff: 'diff' });
    expect(response).toBe(result);
  });

  it('does not swallow LlmRequestError — propagates to the caller', async () => {
    const err = new LlmRequestError('Anthropic API error: HTTP 429 (rate_limit_error)', {
      status: 429,
      errorCode: 'rate_limit_error',
    });
    const service = makeServiceStub(err);
    const controller = new ReviewsController(service, STUB_REPO_CTX);

    await expect(controller.dryRun({ diff: 'diff' })).rejects.toBe(err);
  });
});

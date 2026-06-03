import { Injectable } from '@nestjs/common';
import {
  IRepoContextProvider,
  PriorReviewQuery,
  RepoFileResult,
  RepoFunctionResult,
  RepoPriorReviewResult,
} from '@/modules/reviews/types/repo-context-provider';

// Deterministic-degraded default for callers that have no repo
// context (the HTTP `POST /reviews/dry-run` path). The real-PR
// worker path uses `GitHubRepoContextProvider` instead.
//
// File / function fetches return a truthful `not_found` so Claude
// reads the capability as broken and falls through to `emit_finding`
// instead of probing alternative paths — which keeps the HTTP path's
// turn count low and predictable. Prior-review fetches return an
// empty array (the truthful "no prior reviews" answer, not an error)
// so the dismissal-detection codepath doesn't false-trip on a
// `parse_error` and bail the loop.
@Injectable()
export class NullRepoContextProvider implements IRepoContextProvider {
  private static readonly UNAVAILABLE_MESSAGE =
    'no repo context available on HTTP path';

  async fetchFile(_path: string): Promise<RepoFileResult> {
    return {
      ok: false,
      reason: 'not_found',
      message: NullRepoContextProvider.UNAVAILABLE_MESSAGE,
    };
  }

  async fetchFunctionDefinition(
    _name: string,
    _file?: string,
  ): Promise<RepoFunctionResult> {
    return {
      ok: false,
      reason: 'not_found',
      message: NullRepoContextProvider.UNAVAILABLE_MESSAGE,
    };
  }

  async fetchPriorReview(
    _query: PriorReviewQuery,
  ): Promise<RepoPriorReviewResult> {
    return { ok: true, content: [] };
  }
}

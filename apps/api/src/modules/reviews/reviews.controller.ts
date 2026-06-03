import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ReviewsService, RunDryRunResult } from './reviews.service';
import { DryRunReviewRequestDto } from './types/dto/dry-run-review-request.dto';
import {
  IRepoContextProvider,
  REPO_CONTEXT_PROVIDER,
} from './types/repo-context-provider';

@Controller('reviews')
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    @Inject(REPO_CONTEXT_PROVIDER)
    private readonly repoContext: IRepoContextProvider,
  ) {}

  // POST /reviews/dry-run
  //
  // The route is only registered when ConfigService.enableDryRun is
  // true. The DynamicModule gate lives in ReviewsModule.forRoot();
  // see that file for the rationale.
  //
  // Validation lives entirely on DryRunReviewRequestDto. The global
  // ValidationPipe in main.ts (transform + whitelist +
  // forbidNonWhitelisted) enforces it; this method maps the
  // snake_case DTO field `pr_node_id` to the service's camelCase
  // `prNodeId` and delegates.
  //
  // POST + @HttpCode(200) is the same shape as /embeddings/search —
  // we accept a body and return data without creating a new
  // top-level resource (the persisted reviews row is an
  // implementation detail, not the HTTP-level resource identity).
  @Post('dry-run')
  @HttpCode(HttpStatus.OK)
  async dryRun(@Body() dto: DryRunReviewRequestDto): Promise<RunDryRunResult> {
    return this.reviews.runDryRun({
      diff: dto.diff,
      k: dto.k,
      prNodeId: dto.pr_node_id ?? null,
      // The HTTP path uses NullRepoContextProvider (bound in
      // ReviewsModule). Truthful "no repo context" tool_results keep
      // turn counts low and predictable here — real-PR reviews flow
      // through the worker, not this controller.
      repoContext: this.repoContext,
    });
  }
}

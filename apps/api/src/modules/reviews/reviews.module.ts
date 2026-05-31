import { DynamicModule, Logger, Module } from '@nestjs/common';
import {
  ConfigModule,
  parseEnableDryRun,
  parseSkipRedisProbe,
} from '@/config';
import { AnthropicModule } from '@/infrastructure/anthropic';
import { GithubModule } from '@/infrastructure/github';
import { QueueModule } from '@/infrastructure/queue';
import { RepoContextModule } from '@/infrastructure/repo-context';
import { EmbeddingsModule } from '@/modules/embeddings';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsProcessor } from './reviews.processor';
import { ReviewEventsModule } from './events/review-events.module';

// ReviewsModule.forRoot() is a DynamicModule so it can branch on
// ENABLE_DRY_RUN at module construction time:
//
//   - When ENABLE_DRY_RUN is true (dev default, off elsewhere): the
//     controller is included and `POST /reviews/dry-run` is exposed.
//   - When false: the controller is omitted entirely — the route is
//     never registered in the Nest router. ReviewsService is still
//     provided and exported so internal callers (Day 4 / Day 5 modules)
//     can use it; only the HTTP surface is gated.
//
// This forecloses the accidental-deploy-to-prod denial-of-wallet path
// before Day 5 ships auth. See plan: Schema contract for Day 5.
//
// We read ENABLE_DRY_RUN here via the shared `parseEnableDryRun` helper
// rather than constructing a ConfigService. Reason: forRoot() is invoked
// at module-definition time (when AppModule's @Module decorator is
// evaluated) — constructing a ConfigService there would fail-fast on
// any unrelated missing env var (e.g., during a test that only cares
// about a subset of the surface). The parse helper preserves the
// "single source of parsing logic" discipline that the no-bare-env rule
// is trying to enforce.
@Module({})
export class ReviewsModule {
  private static readonly logger = new Logger(ReviewsModule.name);

  static forRoot(): DynamicModule {
    const enableDryRun = parseEnableDryRun(
      process.env.ENABLE_DRY_RUN,
      process.env.NODE_ENV,
    );
    // Day-5: register the BullMQ ReviewsProcessor only when the queue
    // is actually wired (SKIP_REDIS_PROBE=false → BullMQ path). In
    // test mode the QueueModule binds REVIEW_QUEUE to NoopReviewQueue
    // and no Worker would have a queue to consume from; the
    // processor's @Processor() metadata would also trigger
    // @nestjs/bullmq's explorer to try to construct a Worker against
    // a non-existent queue.
    const skipRedis = parseSkipRedisProbe(process.env.SKIP_REDIS_PROBE, false);

    ReviewsModule.logger.log(
      `ReviewsModule: dry-run HTTP surface ${enableDryRun ? 'ENABLED' : 'DISABLED'}; ` +
        `BullMQ worker ${skipRedis ? 'DISABLED (test mode)' : 'ENABLED'}`,
    );

    return {
      module: ReviewsModule,
      imports: [
        ConfigModule,
        EmbeddingsModule,
        AnthropicModule,
        // Day-4: the HTTP path resolves `REPO_CONTEXT_PROVIDER` to
        // `NullRepoContextProvider` (deterministic-degraded). The
        // CLI bypasses this and constructs a
        // `FilesystemRepoContextProvider` directly with the
        // resolved `--repo` path. Day-5 keeps NullRepoContextProvider
        // as the DI binding — the worker constructs
        // `GitHubRepoContextProvider` per-job in U7.
        RepoContextModule,
        // Day-5: real-PR worker dependencies. GithubModule provides
        // GITHUB_AUTH_PROVIDER (Octokit factory); QueueModule
        // provides the REVIEW_QUEUE token + BullMQ wiring the
        // processor consumes. Both are imported regardless of the
        // skipRedis flag — the QueueModule itself decides whether to
        // load real BullMQ or the no-op fallback.
        GithubModule,
        QueueModule.forRoot(),
        // ReviewEventsModule is @Global() and provides the singleton
        // ReviewEventsService. Imported here so ReviewsService can
        // inject it; DashboardModule imports it too without triggering
        // the double-instantiation that would occur if it imported the
        // heavyweight ReviewsModule.forRoot() directly.
        ReviewEventsModule,
      ],
      controllers: enableDryRun ? [ReviewsController] : [],
      providers: skipRedis
        ? [ReviewsService]
        : [ReviewsService, ReviewsProcessor],
      // Export ReviewEventsService (via ReviewEventsModule's global scope)
      // so callers that import ReviewsModule.forRoot() can also inject it.
      exports: [ReviewsService, ReviewEventsModule],
    };
  }
}

import { DynamicModule, Logger, Module } from '@nestjs/common';
import {
  ConfigModule,
  parseEnableDryRun,
  parseSkipRedisProbe,
} from '@/config';
import { LlmProviderModule } from '@/infrastructure/llm';
import { GithubModule } from '@/infrastructure/github';
import { QueueModule } from '@/infrastructure/queue';
import { RepoContextModule } from '@/infrastructure/repo-context';
import { EmbeddingsModule } from '@/modules/embeddings';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsProcessor } from './reviews.processor';
import { ReviewEventsModule } from './events/review-events.module';

// ReviewsModule.forRoot() branches on ENABLE_DRY_RUN at module
// construction so the dry-run HTTP surface stays out of non-dev
// deployments (denial-of-wallet defense for an unauthenticated route).
// The parse helpers read process.env directly so this code doesn't
// instantiate ConfigService at module-eval time — that would fail-fast
// on any unrelated missing env var.
@Module({})
export class ReviewsModule {
  private static readonly logger = new Logger(ReviewsModule.name);

  static forRoot(): DynamicModule {
    const enableDryRun = parseEnableDryRun(
      process.env.ENABLE_DRY_RUN,
      process.env.NODE_ENV,
    );
    // Register the BullMQ ReviewsProcessor only when the queue is
    // actually wired (SKIP_REDIS_PROBE=false → BullMQ path). In test
    // mode the QueueModule binds REVIEW_QUEUE to NoopReviewQueue and
    // no Worker would have a queue to consume from; the processor's
    // @Processor() metadata would also trigger @nestjs/bullmq's
    // explorer to try to construct a Worker against a non-existent
    // queue.
    // Skip the BullMQ processor when SKIP_REDIS_PROBE is on; otherwise
    // the @Processor decorator would have @nestjs/bullmq's explorer
    // construct a Worker against the no-op queue.
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
        LlmProviderModule.forRoot(),
        RepoContextModule,
        GithubModule,
        QueueModule.forRoot(),
        ReviewEventsModule,
      ],
      controllers: enableDryRun ? [ReviewsController] : [],
      providers: skipRedis
        ? [ReviewsService]
        : [ReviewsService, ReviewsProcessor],
      exports: [ReviewsService, ReviewEventsModule],
    };
  }
}

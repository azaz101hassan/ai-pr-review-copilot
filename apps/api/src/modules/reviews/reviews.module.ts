import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ConfigModule, parseEnableDryRun } from '@/config';
import { AnthropicModule } from '@/infrastructure/anthropic';
import { EmbeddingsModule } from '@/modules/embeddings';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';

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
    ReviewsModule.logger.log(
      `ReviewsModule: dry-run HTTP surface ${enableDryRun ? 'ENABLED' : 'DISABLED'}`,
    );

    return {
      module: ReviewsModule,
      imports: [ConfigModule, EmbeddingsModule, AnthropicModule],
      controllers: enableDryRun ? [ReviewsController] : [],
      providers: [ReviewsService],
      exports: [ReviewsService],
    };
  }
}

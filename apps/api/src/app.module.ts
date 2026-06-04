import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from '@/config';
import { DatabaseModule } from '@/infrastructure/db';
import { GithubModule } from '@/infrastructure/github';
import { WebhookModule } from '@/modules/webhooks';
import { EmbeddingsModule } from '@/modules/embeddings';
import { ReviewsModule } from '@/modules/reviews';
import { DashboardModule } from '@/modules/dashboard';
import { OrdersModule } from '@/modules/orders';
import { HealthController } from '@/system';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    // Global rate limit: 30 req per 60s per IP. Defense-in-depth
    // complement to the Anthropic console hard-cap documented in
    // docs/setup/claude.md. Applies to every HTTP route via the
    // APP_GUARD provider below — /health and /embeddings/search are
    // also covered (well above realistic health-check load). CLI
    // callers bypass entirely (no HTTP).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 30 }]),
    // GitHub App auth seam + boot probe. Loaded before WebhookModule
    // so the GET /app probe blocks startup before any webhook route
    // binds — a malformed PEM surfaces in the first second of boot,
    // not at first webhook arrival.
    GithubModule,
    WebhookModule,
    // ReviewsModule must come AFTER EmbeddingsModule so Nest resolves
    // EmbeddingsService (exported from EmbeddingsModule) before
    // ReviewsService's constructor needs it. ReviewsModule.forRoot()
    // is a DynamicModule that gates `POST /reviews/dry-run` on
    // ConfigService.enableDryRun — see modules/reviews/reviews.module.ts.
    EmbeddingsModule,
    ReviewsModule.forRoot(),
    // Read-only dashboard REST surface (reviews list, detail,
    // analytics, filter population, settings). Repositories come
    // from DatabaseModule (@Global); ConfigService from ConfigModule
    // (@Global).
    DashboardModule,
    // Dummy probe surface for end-to-end bot testing. Mounts
    // `/orders` with an in-memory repository; modifications to this
    // module in a test PR exercise the reviewer against a realistic
    // feature shape.
    OrdersModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ReviewEventsModule } from '@/modules/reviews/events/review-events.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import {
  DashboardEventsController,
  SSE_HEARTBEAT_INTERVAL_MS,
} from './dashboard-events.controller';

// Read-only dashboard REST + SSE module (R5, R7, R8, R10, R11, R12, R15).
//
// All repository tokens (REVIEW_REPOSITORY, PULL_REQUEST_REPOSITORY,
// KNOWLEDGE_CHUNK_REPOSITORY, KNOWLEDGE_SOURCE_REPOSITORY) are provided
// globally by DatabaseModule (@Global), so no explicit import is needed.
// ConfigService is provided globally by ConfigModule (@Global).
//
// ReviewEventsModule is a lightweight @Global() module that provides the
// singleton ReviewEventsService. DashboardEventsController subscribes to
// its stream() and forwards terminal-state events as SSE frames to browsers.
// Importing ReviewEventsModule directly (rather than the heavyweight
// ReviewsModule.forRoot()) avoids the double-instantiation problem that
// would occur from bringing in BullMQ, GitHub infra, and Embeddings
// dependencies a second time.
@Module({
  imports: [ReviewEventsModule],
  controllers: [DashboardController, DashboardEventsController],
  providers: [
    DashboardService,
    // Default heartbeat interval: 25 s. Tests override this via
    // moduleRef.overrideProvider(SSE_HEARTBEAT_INTERVAL_MS).useValue(100).
    { provide: SSE_HEARTBEAT_INTERVAL_MS, useValue: 25_000 },
  ],
  exports: [DashboardService],
})
export class DashboardModule {}

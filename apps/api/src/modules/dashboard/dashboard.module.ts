import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

// Read-only dashboard REST module (R5, R7, R10, R12).
//
// All repository tokens (REVIEW_REPOSITORY, PULL_REQUEST_REPOSITORY,
// KNOWLEDGE_CHUNK_REPOSITORY, KNOWLEDGE_SOURCE_REPOSITORY) are provided
// globally by DatabaseModule (@Global), so no explicit import is needed.
// ConfigService is provided globally by ConfigModule (@Global).
//
// DashboardEventsController (SSE) lives in U5 and is added to this module
// once it lands.
@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}

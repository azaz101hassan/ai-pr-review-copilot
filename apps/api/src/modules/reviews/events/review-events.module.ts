import { Global, Module } from '@nestjs/common';
import { ReviewEventsService } from './review-events.service';

// Global singleton module for the in-process SSE event bus.
//
// @Global() makes ReviewEventsService injectable in any NestJS module
// without requiring each consumer to import ReviewsModule.forRoot().
// This avoids the double-instantiation problem that arises when
// DashboardModule tries to import the heavyweight ReviewsModule.forRoot()
// (which brings in BullMQ, GitHub infra, and Embeddings dependencies).
//
// ReviewsModule.forRoot() imports this module so it gets the same singleton.
// DashboardModule also imports this module directly.
//
// Lifecycle: the service's beforeApplicationShutdown() hook completes the
// inner Subject so connected EventSource clients see a clean stream end on
// SIGTERM (works around NestJS issue #9517).
@Global()
@Module({
  providers: [ReviewEventsService],
  exports: [ReviewEventsService],
})
export class ReviewEventsModule {}

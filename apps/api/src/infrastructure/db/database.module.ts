import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { SqlitePullRequestsRepository } from './repositories/sqlite-pull-requests.repository';
import { SqliteWebhookEventsRepository } from './repositories/sqlite-webhook-events.repository';
import { SqliteKnowledgeSourcesRepository } from './repositories/sqlite-knowledge-sources.repository';
import { SqliteKnowledgeChunksRepository } from './repositories/sqlite-knowledge-chunks.repository';
import { SqliteReviewsRepository } from './repositories/sqlite-reviews.repository';
import { SqliteReviewFindingsRepository } from './repositories/sqlite-review-findings.repository';
import { PULL_REQUEST_REPOSITORY } from '@/modules/webhooks/types/pull-request.repository';
import { WEBHOOK_EVENT_REPOSITORY } from '@/modules/webhooks/types/webhook-event.repository';
import { KNOWLEDGE_SOURCE_REPOSITORY } from '@/modules/embeddings/types/knowledge-source.repository';
import { KNOWLEDGE_CHUNK_REPOSITORY } from '@/modules/embeddings/types/knowledge-chunk.repository';
import { REVIEW_REPOSITORY } from '@/modules/reviews/types/review.repository';
import { REVIEW_FINDING_REPOSITORY } from '@/modules/reviews/types/review-finding.repository';

// @Global so the lifecycle service + repositories are available app-wide
// without each feature module re-importing them. Repositories are bound
// to their interface tokens (PULL_REQUEST_REPOSITORY, …) so consumers
// inject the contract, not the concrete class. Swap the engine by
// replacing useClass below — consumers never change.
@Global()
@Module({
  providers: [
    DatabaseService,
    {
      provide: PULL_REQUEST_REPOSITORY,
      useClass: SqlitePullRequestsRepository,
    },
    {
      provide: WEBHOOK_EVENT_REPOSITORY,
      useClass: SqliteWebhookEventsRepository,
    },
    {
      provide: KNOWLEDGE_SOURCE_REPOSITORY,
      useClass: SqliteKnowledgeSourcesRepository,
    },
    {
      provide: KNOWLEDGE_CHUNK_REPOSITORY,
      useClass: SqliteKnowledgeChunksRepository,
    },
    {
      provide: REVIEW_REPOSITORY,
      useClass: SqliteReviewsRepository,
    },
    {
      provide: REVIEW_FINDING_REPOSITORY,
      useClass: SqliteReviewFindingsRepository,
    },
  ],
  exports: [
    DatabaseService,
    PULL_REQUEST_REPOSITORY,
    WEBHOOK_EVENT_REPOSITORY,
    KNOWLEDGE_SOURCE_REPOSITORY,
    KNOWLEDGE_CHUNK_REPOSITORY,
    REVIEW_REPOSITORY,
    REVIEW_FINDING_REPOSITORY,
  ],
})
export class DatabaseModule {}

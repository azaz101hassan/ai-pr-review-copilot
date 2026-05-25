import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { SqlitePullRequestsRepository } from './repositories/sqlite-pull-requests.repository';
import { SqliteWebhookEventsRepository } from './repositories/sqlite-webhook-events.repository';
import { PULL_REQUEST_REPOSITORY } from '@/modules/webhooks/types/pull-request.repository';
import { WEBHOOK_EVENT_REPOSITORY } from '@/modules/webhooks/types/webhook-event.repository';

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
  ],
  exports: [DatabaseService, PULL_REQUEST_REPOSITORY, WEBHOOK_EVENT_REPOSITORY],
})
export class DatabaseModule {}

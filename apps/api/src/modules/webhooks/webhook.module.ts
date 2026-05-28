import { Module } from '@nestjs/common';
import { GithubSignatureGuard } from '@/guards';
import { GithubModule } from '@/infrastructure/github';
import { QueueModule } from '@/infrastructure/queue';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

// Day-5: QueueModule.forRoot() supplies the REVIEW_QUEUE token that
// the WebhookService injects. The forRoot() pattern lets the module
// choose between BullMQ (production) and a no-op queue (tests where
// SKIP_REDIS_PROBE=true) at module-definition time. ConfigModule is
// @Global (loaded by AppModule), so ConfigService is available
// without an explicit import here.
//
// GithubModule supplies GITHUB_AUTH_PROVIDER so the F12
// installation-lifecycle handler can invalidate cached Octokits
// when GitHub notifies us of an uninstall / suspend.
@Module({
  imports: [QueueModule.forRoot(), GithubModule],
  controllers: [WebhookController],
  providers: [WebhookService, GithubSignatureGuard],
})
export class WebhookModule {}

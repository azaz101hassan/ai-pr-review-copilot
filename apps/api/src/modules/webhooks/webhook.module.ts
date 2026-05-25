import { Module } from '@nestjs/common';
import { GithubSignatureGuard } from '@/guards';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  controllers: [WebhookController],
  providers: [WebhookService, GithubSignatureGuard],
})
export class WebhookModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import { WebhookModule } from './webhooks/webhook.module';

@Module({
  imports: [DatabaseModule, WebhookModule],
  controllers: [HealthController],
})
export class AppModule {}

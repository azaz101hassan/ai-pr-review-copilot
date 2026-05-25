import { Module } from '@nestjs/common';
import { ConfigModule } from '@/config';
import { DatabaseModule } from '@/infrastructure/db';
import { WebhookModule } from '@/modules/webhooks';
import { HealthController } from '@/system';

@Module({
  imports: [ConfigModule, DatabaseModule, WebhookModule],
  controllers: [HealthController],
})
export class AppModule {}

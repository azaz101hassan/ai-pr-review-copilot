import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { webhookEvents } from '../schema';
import { IWebhookEventRepository } from '@/modules/webhooks/types/webhook-event.repository';
import { WebhookEventRecord } from '@/modules/webhooks/types/webhook-event.types';

@Injectable()
export class SqliteWebhookEventsRepository implements IWebhookEventRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(event: WebhookEventRecord): void {
    this.db.drizzle.insert(webhookEvents).values(event).run();
  }

  findByDeliveryId(deliveryId: string): WebhookEventRecord | undefined {
    return this.db.drizzle
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.delivery_id, deliveryId))
      .get();
  }
}

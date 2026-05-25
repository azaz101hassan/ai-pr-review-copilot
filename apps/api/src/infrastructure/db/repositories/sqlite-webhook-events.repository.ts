import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { IWebhookEventRepository } from '@/modules/webhooks/types/webhook-event.repository';
import { WebhookEventRecord } from '@/modules/webhooks/types/webhook-event.types';

@Injectable()
export class SqliteWebhookEventsRepository implements IWebhookEventRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(event: WebhookEventRecord): void {
    this.db
      .getDb()
      .prepare(
        `INSERT INTO webhook_events
         (delivery_id, event_name, action, pull_request_node_id,
          received_at, raw_payload)
         VALUES (@delivery_id, @event_name, @action, @pull_request_node_id,
                 @received_at, @raw_payload)`,
      )
      .run(event);
  }

  findByDeliveryId(deliveryId: string): WebhookEventRecord | undefined {
    return this.db
      .getDb()
      .prepare('SELECT * FROM webhook_events WHERE delivery_id = ?')
      .get(deliveryId) as WebhookEventRecord | undefined;
  }
}

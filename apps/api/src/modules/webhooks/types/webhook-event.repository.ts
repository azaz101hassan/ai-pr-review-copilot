import { WebhookEventRecord } from './webhook-event.types';

export const WEBHOOK_EVENT_REPOSITORY = Symbol('WebhookEventRepository');

export interface IWebhookEventRepository {
  insert(event: WebhookEventRecord): void;
  findByDeliveryId(deliveryId: string): WebhookEventRecord | undefined;
}

import { GithubWebhookPayload } from './github-webhook-payload.types';

export type WebhookHandlerStatus =
  | 'processed'
  | 'ignored-action'
  | 'ignored-event'
  | 'duplicate';

// Internal shape passed from the controller to the service. Captures the
// minimum a handler needs: the wire headers, the parsed body, and the
// original bytes (rawPayload) for downstream audit storage.
export interface WebhookDelivery {
  event: string;
  delivery: string;
  action: string | null;
  payload: GithubWebhookPayload;
  rawPayload: string;
}

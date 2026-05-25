import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@/infrastructure/db';
import {
  IPullRequestRepository,
  PULL_REQUEST_REPOSITORY,
} from './types/pull-request.repository';
import {
  IWebhookEventRepository,
  WEBHOOK_EVENT_REPOSITORY,
} from './types/webhook-event.repository';
import {
  WebhookDelivery,
  WebhookHandlerStatus,
} from './types/webhook-delivery.types';

const ACTIONS_THAT_PROGRESS_PIPELINE = new Set(['opened', 'synchronize']);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(PULL_REQUEST_REPOSITORY)
    private readonly pullRequests: IPullRequestRepository,
    @Inject(WEBHOOK_EVENT_REPOSITORY)
    private readonly events: IWebhookEventRepository,
  ) {}

  handleDelivery(input: WebhookDelivery): { status: WebhookHandlerStatus } {
    const { event, delivery, action, payload, rawPayload } = input;
    const receivedAt = new Date().toISOString();

    // Idempotency: GitHub retries failed deliveries and the "Redeliver"
    // button in the App's settings reuses the same X-GitHub-Delivery
    // UUID. Without this short-circuit, retries hit a UNIQUE constraint
    // on webhook_events.delivery_id and return 500, contradicting the
    // setup docs (which tell operators that 200 = stored). Returning
    // 'duplicate' is a successful no-op from GitHub's perspective.
    if (this.events.findByDeliveryId(delivery)) {
      this.logger.log(
        `duplicate delivery ${delivery} (${event}.${action ?? 'unknown'}) — no-op`,
      );
      return { status: 'duplicate' };
    }

    if (event === 'pull_request' && payload.pull_request) {
      const pr = payload.pull_request;
      if (action && ACTIONS_THAT_PROGRESS_PIPELINE.has(action)) {
        // Atomic: PR upsert + event insert succeed together or not at
        // all. Without the transaction, a crash between the two leaves
        // a PR row in the table with no audit event — and a redelivery
        // would then walk the PR forward (title/state churn) without
        // recording the delivery either.
        this.db.transaction(() => {
          this.pullRequests.save({
            node_id: pr.node_id,
            repo_full_name: payload.repository?.full_name ?? 'unknown/unknown',
            number: pr.number,
            title: pr.title,
            state: pr.state,
            head_sha: pr.head.sha,
            base_sha: pr.base.sha,
            author_login: pr.user.login,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            raw_payload: JSON.stringify(pr),
          });
          this.events.insert({
            delivery_id: delivery,
            event_name: event,
            action,
            pull_request_node_id: pr.node_id,
            received_at: receivedAt,
            raw_payload: rawPayload,
          });
        });
        this.logger.log(
          `pull_request.${action} #${pr.number} stored (${payload.repository?.full_name ?? 'unknown'})`,
        );
        return { status: 'processed' };
      }

      // Other PR actions (closed, reopened, edited, …). Day 1 does not
      // model PR state transitions, so we just record the event without
      // touching the PR row. Defensive FK: if the PR is unknown (we
      // missed the opened delivery), keep the FK null instead of
      // exploding with a constraint error.
      const existing = this.pullRequests.findByNodeId(pr.node_id);
      this.events.insert({
        delivery_id: delivery,
        event_name: event,
        action: action ?? null,
        pull_request_node_id: existing ? pr.node_id : null,
        received_at: receivedAt,
        raw_payload: rawPayload,
      });
      this.logger.log(
        `pull_request.${action ?? 'unknown'} #${pr.number} recorded but not processed (Day 1 scope)`,
      );
      return { status: 'ignored-action' };
    }

    // Any non-pull_request event — just persist for later analysis.
    this.events.insert({
      delivery_id: delivery,
      event_name: event,
      action: action ?? null,
      pull_request_node_id: null,
      received_at: receivedAt,
      raw_payload: rawPayload,
    });
    this.logger.log(`event ${event} recorded but not processed (Day 1 scope)`);
    return { status: 'ignored-event' };
  }
}

// Re-exports so existing callers (controller, tests) can import these
// from the service module without knowing the types/ subfolder layout.
export {
  WebhookDelivery,
  WebhookHandlerStatus,
} from './types/webhook-delivery.types';
export { GithubWebhookPayload } from './types/github-webhook-payload.types';

import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export type WebhookHandlerStatus =
  | 'processed'
  | 'ignored-action'
  | 'ignored-event'
  | 'duplicate';

export interface WebhookDelivery {
  event: string;
  delivery: string;
  action: string | null;
  payload: GithubWebhookPayload;
  rawPayload: string;
}

export interface GithubWebhookPayload {
  action?: string;
  pull_request?: {
    node_id: string;
    number: number;
    title: string;
    state: string;
    head: { sha: string };
    base: { sha: string };
    user: { login: string };
    created_at: string;
    updated_at: string;
  };
  repository?: {
    full_name: string;
  };
}

const ACTIONS_THAT_PROGRESS_PIPELINE = new Set(['opened', 'synchronize']);

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly db: DatabaseService) {}

  handleDelivery(input: WebhookDelivery): { status: WebhookHandlerStatus } {
    const { event, delivery, action, payload, rawPayload } = input;
    const receivedAt = new Date().toISOString();

    // Idempotency: GitHub retries failed deliveries and the "Redeliver"
    // button in the App's settings reuses the same X-GitHub-Delivery
    // UUID. Without this short-circuit, retries hit a UNIQUE constraint
    // on webhook_events.delivery_id and return 500, contradicting the
    // setup docs (which tell operators that 200 = stored). Returning
    // 'duplicate' is a successful no-op from GitHub's perspective.
    if (this.db.findWebhookEvent(delivery)) {
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
          this.db.insertOrReplacePullRequest({
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
          this.db.insertWebhookEvent({
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
      const existing = this.db.findPullRequest(pr.node_id);
      this.db.insertWebhookEvent({
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
    this.db.insertWebhookEvent({
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

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@/config';
import { DatabaseService } from '@/infrastructure/db';
import {
  GITHUB_AUTH_PROVIDER,
  IGithubAuthProvider,
} from '@/modules/reviews/types/github-auth-provider';
import {
  IReviewQueue,
  REVIEW_QUEUE,
} from '@/modules/reviews/types/review-queue';
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
    @Inject(REVIEW_QUEUE)
    private readonly reviewQueue: IReviewQueue,
    @Inject(GITHUB_AUTH_PROVIDER)
    private readonly githubAuth: IGithubAuthProvider,
    private readonly config: ConfigService,
  ) {}

  async handleDelivery(
    input: WebhookDelivery,
  ): Promise<{ status: WebhookHandlerStatus }> {
    const { event, delivery, action, payload, rawPayload } = input;
    // received_at is server-controlled; created_at/updated_at come from
    // GitHub as ISO 8601 strings and convert to Date for the DB.
    const receivedAt = new Date();

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

    // Installation lifecycle events. GitHub fires these when the App
    // is uninstalled, suspended, or unsuspended — the cached Octokit
    // for that installation must be evicted so we don't keep
    // retrying with a dead token. The event is still recorded for
    // audit; the side effect is the cache eviction.
    if (event === 'installation') {
      const installationId = payload.installation?.id;
      if (
        typeof installationId === 'number' &&
        installationId > 0 &&
        (action === 'deleted' || action === 'suspend')
      ) {
        this.githubAuth.invalidateInstallation(installationId);
        this.logger.log(
          `installation.${action} #${installationId} — Octokit cache invalidated`,
        );
      }
      this.events.insert({
        delivery_id: delivery,
        event_name: event,
        action: action ?? null,
        pull_request_node_id: null,
        received_at: receivedAt,
        raw_payload: rawPayload,
      });
      return { status: 'processed' };
    }

    if (event === 'pull_request' && payload.pull_request) {
      const pr = payload.pull_request;
      if (action && ACTIONS_THAT_PROGRESS_PIPELINE.has(action)) {
        const repoFullName =
          payload.repository?.full_name ?? 'unknown/unknown';

        // Persist the PR row first, then defer the webhook_events
        // insert until AFTER the enqueue succeeds. Order:
        //   1. PR upsert (idempotent, safe to redo on redelivery).
        //   2. Allowlist + draft + installation_id checks (early exit
        //      branches insert their own audit row directly).
        //   3. Enqueue (the external dependency).
        //   4. webhook_events insert (the durable "we processed this
        //      delivery" gate the next idempotency check reads).
        // Putting steps 3 and 4 in the other order would let a Redis
        // blip commit the audit row without enqueuing, and the
        // redelivery would short-circuit as 'duplicate' and strand
        // the PR. Trade-off in the current order: if step 4 fails
        // after step 3 succeeded, a redelivery re-enqueues — the
        // worker's per-PR in-progress guard catches it as a clean
        // exit. That's the smaller failure mode than stranded PRs.
        this.pullRequests.save({
          node_id: pr.node_id,
          repo_full_name: repoFullName,
          number: pr.number,
          title: pr.title,
          // payload.pull_request.state is a free string in the
          // GithubWebhookPayload type, but GitHub only emits
          // 'open' or 'closed' for this field. Cast narrows it to
          // match the Drizzle schema's enum (TS-side only — SQLite
          // doesn't enforce text-enums at the DB layer).
          state: pr.state as 'open' | 'closed',
          head_sha: pr.head.sha,
          base_sha: pr.base.sha,
          author_login: pr.user.login,
          created_at: new Date(pr.created_at),
          updated_at: new Date(pr.updated_at),
          raw_payload: JSON.stringify(pr),
          walkthrough_comment_id: null,
        });
        this.logger.log(
          `pull_request.${action} #${pr.number} PR row upserted (${repoFullName})`,
        );

        // Helper closure so each early-exit branch can write the
        // audit row without duplicating the call shape.
        const insertEventRow = (
          finalStatus: 'ignored-draft' | 'ignored-repo' | 'ignored-event' | 'processed',
        ): void => {
          this.events.insert({
            delivery_id: delivery,
            event_name: event,
            action,
            pull_request_node_id: pr.node_id,
            received_at: receivedAt,
            raw_payload: rawPayload,
          });
          this.logger.log(
            `pull_request.${action} #${pr.number} audit row persisted (status=${finalStatus})`,
          );
        };

        // Draft filter applies to BOTH opened AND synchronize so
        // re-pushes against an in-progress draft PR also short-circuit
        // (no Anthropic spend on draft commits — preserves the
        // WIP-budget rationale). The `ready_for_review` action lands
        // on the existing 'ignored-action' path; the bot then reviews
        // on the next synchronize after promotion.
        if (pr.draft === true) {
          this.logger.log(
            `pull_request.${action} #${pr.number} skipped — draft PR (${repoFullName})`,
          );
          insertEventRow('ignored-draft');
          return { status: 'ignored-draft' };
        }

        // DOGFOOD_REPOS allowlist + kill switch. Empty set → silent
        // for every PR (operator drop-out without uninstalling the
        // App).
        if (!this.config.dogfoodRepos.has(repoFullName)) {
          this.logger.log(
            `pull_request.${action} #${pr.number} skipped — repo "${repoFullName}" not in DOGFOOD_REPOS allowlist`,
          );
          insertEventRow('ignored-repo');
          return { status: 'ignored-repo' };
        }

        // Installation id is required to mint Octokit. Real GitHub
        // webhooks always carry it on pull_request events; treat its
        // absence as an invalid event rather than crashing the enqueue.
        const installationId = payload.installation?.id;
        if (typeof installationId !== 'number' || installationId <= 0) {
          this.logger.warn(
            `pull_request.${action} #${pr.number} from ${repoFullName} missing installation.id — cannot enqueue.`,
          );
          insertEventRow('ignored-event');
          return { status: 'ignored-event' };
        }

        // owner / repo split from the full_name. GitHub guarantees
        // `<owner>/<repo>` with exactly one slash. The ConfigService
        // allowlist validator above already rejected malformed
        // tokens (DOGFOOD_REPOS parser), so this split is safe.
        const [owner, repoName] = repoFullName.split('/');

        // Enqueue BEFORE the audit row commits. If the enqueue
        // throws (Redis blip), the audit row is never written and
        // GitHub's redelivery restarts the whole pipeline cleanly
        // (the duplicate guard skips redeliveries ONLY when the
        // audit row exists; absent row = re-process).
        await this.reviewQueue.enqueueReview({
          pr_node_id: pr.node_id,
          owner,
          repo: repoName,
          pr_number: pr.number,
          head_sha: pr.head.sha,
          installation_id: installationId,
        });
        insertEventRow('processed');

        return { status: 'processed' };
      }

      // Other PR actions (closed, reopened, edited, …). We don't
      // model these state transitions today, so we just record the
      // event without touching the PR row. Defensive FK: if the PR
      // is unknown (we missed the opened delivery), keep the FK null
      // instead of exploding with a constraint error.
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
        `pull_request.${action ?? 'unknown'} #${pr.number} recorded but not processed`,
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
    this.logger.log(`event ${event} recorded but not processed`);
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

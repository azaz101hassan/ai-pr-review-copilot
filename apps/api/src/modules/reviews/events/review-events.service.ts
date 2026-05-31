import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

// Payload emitted at every terminal-state transition inside
// ReviewsService.runDryRun. The SSE controller (DashboardEventsController)
// subscribes via stream() and forwards each event as an SSE frame.
//
// Field notes:
// - repo_full_name / author_login: NULL when pr_node_id is NULL (no PR row
//   to join against).
// - token_totals: NULL on pre-LLM failure rows (the Anthropic call never
//   started, so no usage data is available).
// - finding_counts: always present; zero for every severity on failure rows.
// - completed_at: epoch ms matching the row's completed_at timestamp.
export interface TerminalReviewEvent {
  review_id: string;
  pr_node_id: string | null;
  repo_full_name: string | null;
  author_login: string | null;
  status: 'completed' | 'failed';
  prompt_version: string;
  finding_counts: {
    error: number;
    warning: number;
    info: number;
  };
  token_totals: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  } | null;
  completed_at: number; // epoch ms
}

// Singleton in-process event bus for review terminal-state events.
//
// Design constraints (per Day-7 plan, U2 Key Technical Decisions):
//
// 1. Emit lives in ReviewsService.runDryRun OUTSIDE the db.transaction()
//    callback — better-sqlite3 has no post-commit hook, and emitting inside
//    the callback would rollback the transaction if a subscriber threw.
//
// 2. Connection-cap state (tryAcquireSlot / releaseSlot / subscriberCount)
//    lives on DashboardEventsController (U5), NOT here. Slot management is
//    HTTP-connection lifecycle, not event-bus state.
//
// 3. beforeApplicationShutdown() completes the inner Subject so connected
//    EventSource clients see a clean stream end on SIGTERM — works around
//    NestJS issue #9517 where enableShutdownHooks() leaves SSE streams open.
@Injectable()
export class ReviewEventsService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ReviewEventsService.name);
  private readonly subject = new Subject<TerminalReviewEvent>();

  // Emit a terminal-state event to all current subscribers. Wrapped in
  // try/catch so a subscriber throw does not propagate back through
  // Subject.next() into the caller (ReviewsService.runDryRun). RxJS
  // Subject.next() runs subscriber callbacks synchronously inline — if
  // a subscriber's `next` handler throws, Subject.next() propagates that
  // throw. The try/catch here absorbs it so the runDryRun caller is never
  // affected by SSE subscriber failures.
  emit(event: TerminalReviewEvent): void {
    if (this.subject.closed) {
      this.logger.debug(
        `ReviewEventsService: subject is closed; dropping emit for review_id=${event.review_id}`,
      );
      return;
    }
    try {
      this.subject.next(event);
    } catch (err) {
      this.logger.error(
        `ReviewEventsService: subscriber threw during emit for review_id=${event.review_id} — swallowed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  // Observable of terminal-state events. DashboardEventsController (U5)
  // subscribes once per SSE connection to forward events to the browser.
  // All subscribers receive every event (broadcast — no per-connection
  // filter logic lives here; clients discard events that don't match their
  // current filter spec).
  stream(): Observable<TerminalReviewEvent> {
    return this.subject.asObservable();
  }

  // NestJS lifecycle hook. Completing the Subject sends a clean `complete`
  // notification to all current RxJS subscribers, which in turn allows the
  // @Sse() Observable to terminate gracefully. Without this, connected
  // EventSource clients do not detect closure on SIGTERM and keep the
  // process alive beyond the shutdown timeout.
  beforeApplicationShutdown(): void {
    if (!this.subject.closed) {
      this.subject.complete();
    }
  }
}

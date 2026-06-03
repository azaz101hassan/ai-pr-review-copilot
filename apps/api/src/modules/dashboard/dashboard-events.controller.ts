import { Controller, Inject, Optional, Res, Sse } from '@nestjs/common';
import { Response } from 'express';
import { interval, merge, Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { ReviewEventsService } from '@/modules/reviews/events/review-events.service';

// Injection token for the heartbeat interval in milliseconds. Defaults to
// 25_000 ms in production. Tests inject a short interval to verify the wire
// shape without waiting 25 s.
export const SSE_HEARTBEAT_INTERVAL_MS = Symbol('SSE_HEARTBEAT_INTERVAL_MS');

// MessageEvent shape NestJS @Sse() understands.
// When `type` is set it serializes as the SSE `event:` line.
// Terminal review events carry no `type` field — they land on the
// default `event: message` channel so a vanilla `onmessage` listener
// receives them.
interface SseFrame {
  type?: string;
  data: string;
}

// SSE controller for the dashboard live-update feed.
//
// Endpoint: GET /dashboard/events.
//
// Design constraints:
//
// 1. Connection cap = 10. The cap counter lives here — slot
//    management is HTTP-connection lifecycle, not event-bus state.
//    Over-cap connections receive a single named frame
//    `event: cap-reached\ndata: \n\n` and the Observable completes
//    immediately. The slot is NOT consumed because acquisition
//    failed. HTTP 503 is NOT returned — browser EventSource does
//    not expose status to onerror and would auto-reconnect
//    regardless (reconnect storm). The client registers
//    addEventListener('cap-reached', ...) to call eventSource.close()
//    instead.
//
// 2. Heartbeat = 25 s as a named SSE event:
//    `event: keepalive\ndata: \n\n`. The client does NOT register a
//    keepalive listener, so these frames never fire onmessage — they
//    only keep the TCP connection alive through proxy idle timeouts.
//
// 3. @Res() is injected for its 'close' event, which is the only
//    reliable signal for a browser-initiated disconnect. releaseSlot()
//    fires there to keep the cap counter accurate. Never call
//    res.json() / res.send() inside an @Sse() handler — NestJS manages
//    the response lifecycle via the returned Observable.
//
// 4. Terminal events stay on the default `event: message` channel
//    (no type field) so a vanilla onmessage listener handles them.
@Controller('dashboard')
export class DashboardEventsController {
  // Connection cap. Private to this controller; never mutated by the
  // event bus (ReviewEventsService). Initial value 0; incremented on
  // tryAcquireSlot success, decremented on releaseSlot.
  private subscriberCount = 0;
  private readonly MAX_SUBSCRIBERS = 10;

  // Heartbeat Observable. Fires every `heartbeatIntervalMs` (default 25 s)
  // as a named SSE event so the browser's EventSource never sees a
  // proxy-imposed idle-timeout close. The client never registers a
  // 'keepalive' listener, so onmessage does NOT fire for these frames.
  private readonly heartbeat$: Observable<SseFrame>;

  constructor(
    private readonly events: ReviewEventsService,
    @Optional()
    @Inject(SSE_HEARTBEAT_INTERVAL_MS)
    heartbeatIntervalMs: number = 25_000,
  ) {
    this.heartbeat$ = interval(heartbeatIntervalMs).pipe(
      map((): SseFrame => ({ type: 'keepalive', data: '' })),
    );
  }

  // Returns true and increments the counter when a slot is available.
  // Returns false without touching the counter when the cap is reached.
  private tryAcquireSlot(): boolean {
    if (this.subscriberCount >= this.MAX_SUBSCRIBERS) {
      return false;
    }
    this.subscriberCount++;
    return true;
  }

  // Decrements the counter. Called from the 'close' listener so every
  // abrupt browser disconnect releases its slot.
  private releaseSlot(): void {
    if (this.subscriberCount > 0) {
      this.subscriberCount--;
    }
  }

  @Sse('events')
  stream(@Res() res: Response): Observable<SseFrame> {
    // Over-cap fast path: emit one named frame and complete. The
    // Observable completing causes NestJS to close the response after
    // writing the single frame. The slot is NOT consumed.
    if (!this.tryAcquireSlot()) {
      return of<SseFrame>({ type: 'cap-reached', data: '' });
    }

    // Slot acquired. Attach a 'close' listener so the slot is released
    // when the browser navigates away or drops the connection. This is
    // the only reliable signal for a client-initiated disconnect.
    res.on('close', () => {
      this.releaseSlot();
    });

    // Main stream: terminal review events merged with the keepalive
    // heartbeat. ReviewEventsService.stream() returns an Observable
    // that broadcasts every terminal-state event to all subscribers.
    // Terminal events are serialized to JSON in the `data` field with
    // no `type`, landing them on the default `event: message` channel.
    return merge<SseFrame[]>(
      this.events.stream().pipe(
        map((e): SseFrame => ({ data: JSON.stringify(e) })),
      ),
      this.heartbeat$,
    );
  }
}

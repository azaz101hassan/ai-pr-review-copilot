// Reusable rolling-window rate-limit guard + optional budget cap.
//
// Instance state (not a module-scoped global) so multiple guards can
// coexist — e.g. one per integration-spec file, one per corpus capture
// run. The window catches `jest --watch` runaways; the budget cap
// bounds a single corpus run.

/**
 * Thrown when the rolling-window rate limit is exceeded.
 *
 * The error message starts with "SessionRateLimitExceeded:" so log
 * greps stay stable across the typed-class refactor.
 */
export class SessionRateLimitExceededError extends Error {
  readonly name = 'SessionRateLimitExceededError';

  constructor(
    readonly currentCount: number,
    readonly windowMs: number,
    readonly maxCalls: number,
  ) {
    super(
      `SessionRateLimitExceeded: too many calls in the current session ` +
        `(${currentCount} within ${windowMs / 1000}s, max ${maxCalls}) — ` +
        `likely a jest --watch loop. Restart Jest and reset the counter.`,
    );
  }
}

/**
 * Thrown when the lifetime budget cap is exhausted.
 */
export class BudgetExhaustedError extends Error {
  readonly name = 'BudgetExhaustedError';

  constructor(
    readonly totalCalls: number,
    readonly budgetCap: number,
  ) {
    super(
      `BudgetExhausted: total calls (${totalCalls}) reached the budget cap ` +
        `(${budgetCap}). No further calls allowed in this session.`,
    );
  }
}

export interface SessionRateLimitGuardOptions {
  /** Rolling window size in milliseconds. */
  windowMs: number;
  /** Maximum calls allowed within the rolling window. */
  maxCalls: number;
  /** Optional lifetime budget cap — total calls ever, regardless of timing. */
  budgetCap?: number;
}

/**
 * Rolling-window rate-limit guard with an optional lifetime budget cap.
 *
 * ```ts
 * const guard = new SessionRateLimitGuard({ windowMs: 60_000, maxCalls: 5 });
 * guard.acquire(); // throws if window or budget exceeded
 * ```
 */
export class SessionRateLimitGuard {
  private readonly callTimestamps: number[] = [];
  private totalCalls = 0;
  private readonly windowMs: number;
  private readonly maxCalls: number;
  private readonly budgetCap: number | undefined;

  constructor(opts: SessionRateLimitGuardOptions) {
    this.windowMs = opts.windowMs;
    this.maxCalls = opts.maxCalls;
    this.budgetCap = opts.budgetCap;
  }

  /**
   * Record an intent to make a call. Throws if the rolling window or
   * lifetime budget would be exceeded.
   *
   * Checks are ordered budget-first so a budget-exhausted session
   * doesn't need to wait for the window to slide before surfacing the
   * real problem.
   */
  acquire(): void {
    // Budget cap check (lifetime, independent of timing).
    if (this.budgetCap !== undefined && this.totalCalls >= this.budgetCap) {
      throw new BudgetExhaustedError(this.totalCalls, this.budgetCap);
    }

    // Rolling-window check.
    const now = Date.now();
    while (
      this.callTimestamps.length &&
      now - this.callTimestamps[0] > this.windowMs
    ) {
      this.callTimestamps.shift();
    }
    if (this.callTimestamps.length >= this.maxCalls) {
      throw new SessionRateLimitExceededError(
        this.callTimestamps.length,
        this.windowMs,
        this.maxCalls,
      );
    }

    this.callTimestamps.push(now);
    this.totalCalls++;
  }
}

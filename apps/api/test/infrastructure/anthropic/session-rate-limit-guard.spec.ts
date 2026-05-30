import {
  SessionRateLimitGuard,
  SessionRateLimitExceededError,
  BudgetExhaustedError,
} from '@/infrastructure/anthropic/session-rate-limit-guard';

describe('SessionRateLimitGuard', () => {
  // ── Rolling-window behaviour ──────────────────────────────────────

  it('allows up to maxCalls within the window', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 60_000,
      maxCalls: 5,
    });

    // 4 calls should all pass without throwing.
    for (let i = 0; i < 4; i++) {
      expect(() => guard.acquire()).not.toThrow();
    }
  });

  it('throws SessionRateLimitExceededError on the call that exceeds the window', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 60_000,
      maxCalls: 5,
    });

    for (let i = 0; i < 5; i++) {
      guard.acquire();
    }

    expect(() => guard.acquire()).toThrow(SessionRateLimitExceededError);
  });

  it('SessionRateLimitExceededError message starts with "SessionRateLimitExceeded:"', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 60_000,
      maxCalls: 1,
    });
    guard.acquire();

    try {
      guard.acquire();
      fail('Expected SessionRateLimitExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionRateLimitExceededError);
      expect((err as Error).message).toMatch(/^SessionRateLimitExceeded:/);
    }
  });

  it('allows a call after old timestamps slide out of the window', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 100, // 100ms window for fast test
      maxCalls: 2,
    });

    // Fill the window.
    guard.acquire();
    guard.acquire();

    // The window is full — next call should throw.
    expect(() => guard.acquire()).toThrow(SessionRateLimitExceededError);

    // Advance time past the window by mocking Date.now.
    const realNow = Date.now;
    Date.now = () => realNow() + 200; // 200ms past the window
    try {
      // Old timestamps have slid out — should pass.
      expect(() => guard.acquire()).not.toThrow();
    } finally {
      Date.now = realNow;
    }
  });

  // ── Budget cap behaviour ──────────────────────────────────────────

  it('throws BudgetExhaustedError when lifetime budget is exceeded', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 60_000,
      maxCalls: 100, // generous window — budget is the constraint
      budgetCap: 3,
    });

    guard.acquire();
    guard.acquire();
    guard.acquire();

    expect(() => guard.acquire()).toThrow(BudgetExhaustedError);
  });

  it('BudgetExhaustedError carries the total calls and cap', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 60_000,
      maxCalls: 100,
      budgetCap: 2,
    });

    guard.acquire();
    guard.acquire();

    try {
      guard.acquire();
      fail('Expected BudgetExhaustedError');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExhaustedError);
      const budgetErr = err as BudgetExhaustedError;
      expect(budgetErr.totalCalls).toBe(2);
      expect(budgetErr.budgetCap).toBe(2);
      expect(budgetErr.message).toContain('BudgetExhausted:');
    }
  });

  it('budget cap fires even after the window slides (lifetime, not windowed)', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 100,
      maxCalls: 10,
      budgetCap: 2,
    });

    guard.acquire();
    guard.acquire();

    // Even after the window slides, budget is exhausted.
    const realNow = Date.now;
    Date.now = () => realNow() + 500;
    try {
      expect(() => guard.acquire()).toThrow(BudgetExhaustedError);
    } finally {
      Date.now = realNow;
    }
  });

  // ── Combined interaction ──────────────────────────────────────────

  it('budget cap is checked before the window (budget-first ordering)', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 60_000,
      maxCalls: 2,
      budgetCap: 2,
    });

    guard.acquire();
    guard.acquire();

    // Both window AND budget are at capacity. Budget should win.
    try {
      guard.acquire();
      fail('Expected an error');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExhaustedError);
    }
  });

  it('window limit triggers before budget cap when window is tighter', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 60_000,
      maxCalls: 2,
      budgetCap: 10,
    });

    guard.acquire();
    guard.acquire();

    // Window is full (2/2), budget is not (2/10).
    expect(() => guard.acquire()).toThrow(SessionRateLimitExceededError);
  });

  // ── No budget cap (undefined) ─────────────────────────────────────

  it('with no budget cap, only the window constrains calls', () => {
    const guard = new SessionRateLimitGuard({
      windowMs: 100,
      maxCalls: 2,
    });

    guard.acquire();
    guard.acquire();

    // Window full — throws.
    expect(() => guard.acquire()).toThrow(SessionRateLimitExceededError);

    // Slide the window — succeeds (no budget cap to block it).
    const realNow = Date.now;
    Date.now = () => realNow() + 200;
    try {
      expect(() => guard.acquire()).not.toThrow();
    } finally {
      Date.now = realNow;
    }
  });
});

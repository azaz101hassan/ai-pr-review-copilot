import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { GithubSignatureGuard } from '@/guards';

const SECRET = 'super-secret-day-1';

function buildContext(
  rawBody: Buffer | undefined,
  signatureHeader: string | null,
): ExecutionContext {
  const headers: Record<string, string | undefined> = {};
  if (signatureHeader !== null) {
    headers['x-hub-signature-256'] = signatureHeader;
  }
  const request = { rawBody, headers };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function sign(body: Buffer, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('GithubSignatureGuard', () => {
  describe('construction', () => {
    it('throws when no secret is provided and GITHUB_WEBHOOK_SECRET env is unset', () => {
      const prev = process.env.GITHUB_WEBHOOK_SECRET;
      delete process.env.GITHUB_WEBHOOK_SECRET;
      try {
        expect(() => new GithubSignatureGuard()).toThrow(
          /GITHUB_WEBHOOK_SECRET/,
        );
      } finally {
        if (prev !== undefined) {
          process.env.GITHUB_WEBHOOK_SECRET = prev;
        }
      }
    });

    it('accepts an explicit secret', () => {
      expect(() => new GithubSignatureGuard(SECRET)).not.toThrow();
    });

    it('reads from process.env.GITHUB_WEBHOOK_SECRET when no arg is provided', () => {
      const prev = process.env.GITHUB_WEBHOOK_SECRET;
      process.env.GITHUB_WEBHOOK_SECRET = 'env-secret-long-enough';
      try {
        expect(() => new GithubSignatureGuard()).not.toThrow();
      } finally {
        if (prev === undefined) {
          delete process.env.GITHUB_WEBHOOK_SECRET;
        } else {
          process.env.GITHUB_WEBHOOK_SECRET = prev;
        }
      }
    });

    it.each([
      ['empty string', ''],
      ['literal "undefined" (templating fallback)', 'undefined'],
      ['literal "null"', 'null'],
      ['too short (<16 chars)', 'short-secret'],
    ])('rejects placeholder/short secret: %s', (_label, value) => {
      expect(() => new GithubSignatureGuard(value)).toThrow(
        /placeholder|shorter than 16|missing/,
      );
    });
  });

  describe('canActivate', () => {
    let guard: GithubSignatureGuard;

    beforeEach(() => {
      guard = new GithubSignatureGuard(SECRET);
    });

    it('accepts a request with a correctly-computed signature', () => {
      const body = Buffer.from(JSON.stringify({ hello: 'world' }));
      const ctx = buildContext(body, sign(body));
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('accepts an empty body with a correctly-computed signature', () => {
      const body = Buffer.alloc(0);
      const ctx = buildContext(body, sign(body));
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('rejects a request signed with the wrong secret', () => {
      const body = Buffer.from('legit body');
      const ctx = buildContext(body, sign(body, 'wrong-secret'));
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a request with no X-Hub-Signature-256 header', () => {
      const body = Buffer.from('legit body');
      const ctx = buildContext(body, null);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a signature header without the sha256= prefix', () => {
      const body = Buffer.from('legit body');
      const hex = createHmac('sha256', SECRET).update(body).digest('hex');
      const ctx = buildContext(body, hex); // missing "sha256=" prefix
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a signature whose decoded length differs from the digest (no timingSafeEqual crash)', () => {
      const body = Buffer.from('legit body');
      const ctx = buildContext(body, 'sha256=deadbeef'); // 8 hex chars, not 64
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects when req.rawBody is missing (NestJS rawBody not enabled)', () => {
      const body = Buffer.from('legit body');
      const ctx = buildContext(undefined, sign(body));
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects when X-Hub-Signature-256 carries a non-hex value after the prefix', () => {
      const body = Buffer.from('legit body');
      const ctx = buildContext(body, 'sha256=not-hex-at-all-zzzzz');
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });
});

import { ReviewsModule } from '@/modules/reviews';
import { ReviewsController } from '@/modules/reviews/reviews.controller';
import { ReviewsService } from '@/modules/reviews/reviews.service';

// Gating spec for ReviewsModule.forRoot(). We assert the DynamicModule
// SHAPE directly rather than booting AppModule — booting introduces
// throttler / reflector concerns that are orthogonal to the gating
// decision, and the end-to-end gating behavior (route present at
// ENABLE_DRY_RUN=true, 404 at false) is exercised in U7's e2e spec
// against a fully-wired AppModule.

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) snapshot[key] = process.env[key];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('ReviewsModule.forRoot — gating', () => {
  describe('ENABLE_DRY_RUN=true (explicit)', () => {
    it('includes ReviewsController in the dynamic module', () => {
      const def = withEnv({ ENABLE_DRY_RUN: 'true', NODE_ENV: 'production' }, () =>
        ReviewsModule.forRoot(),
      );
      expect(def.controllers).toEqual([ReviewsController]);
      expect(def.providers).toContain(ReviewsService);
      expect(def.exports).toContain(ReviewsService);
    });
  });

  describe('ENABLE_DRY_RUN=false (explicit)', () => {
    it('omits ReviewsController so POST /reviews/dry-run is never registered', () => {
      const def = withEnv({ ENABLE_DRY_RUN: 'false', NODE_ENV: 'development' }, () =>
        ReviewsModule.forRoot(),
      );
      expect(def.controllers).toEqual([]);
      // ReviewsService is still provided and exported — internal
      // callers keep working; only the HTTP surface is gated.
      expect(def.providers).toContain(ReviewsService);
      expect(def.exports).toContain(ReviewsService);
    });
  });

  describe('ENABLE_DRY_RUN unset', () => {
    it('defaults to ENABLED in NODE_ENV=development', () => {
      const def = withEnv({ ENABLE_DRY_RUN: undefined, NODE_ENV: 'development' }, () =>
        ReviewsModule.forRoot(),
      );
      expect(def.controllers).toEqual([ReviewsController]);
    });

    it('defaults to DISABLED in NODE_ENV=production', () => {
      const def = withEnv({ ENABLE_DRY_RUN: undefined, NODE_ENV: 'production' }, () =>
        ReviewsModule.forRoot(),
      );
      expect(def.controllers).toEqual([]);
    });

    it('defaults to DISABLED in NODE_ENV=test', () => {
      const def = withEnv({ ENABLE_DRY_RUN: undefined, NODE_ENV: 'test' }, () =>
        ReviewsModule.forRoot(),
      );
      expect(def.controllers).toEqual([]);
    });
  });

  describe('ENABLE_DRY_RUN parsing (case-insensitive)', () => {
    it.each([
      ['TRUE', true],
      ['True', true],
      ['1', true],
      ['yes', true],
      ['YES', true],
      ['false', false],
      ['0', false],
      ['no', false],
      ['banana', false],
    ])('explicit value %s → %s', (raw, expected) => {
      const def = withEnv({ ENABLE_DRY_RUN: raw, NODE_ENV: 'production' }, () =>
        ReviewsModule.forRoot(),
      );
      if (expected) {
        expect(def.controllers).toEqual([ReviewsController]);
      } else {
        expect(def.controllers).toEqual([]);
      }
    });
  });
});

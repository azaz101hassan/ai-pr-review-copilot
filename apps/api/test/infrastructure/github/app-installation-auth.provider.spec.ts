import { ConfigService } from '@/config';
import { AppInstallationAuthProvider } from '@/infrastructure/github';
import type { Octokit } from 'octokit';

// Test seam: subclass overrides `createClient` so we never instantiate
// the real Octokit (which would parse the test PEM stub through node
// crypto and reject it). The override records every invocation so
// per-installation caching is observable without real HTTPS.
class StubProvider extends AppInstallationAuthProvider {
  public readonly callLog: number[] = [];
  public readonly stubs = new Map<number, Octokit>();

  protected override createClient(installationId: number): Octokit {
    this.callLog.push(installationId);
    const stub = { __id: installationId } as unknown as Octokit;
    this.stubs.set(installationId, stub);
    return stub;
  }
}

describe('AppInstallationAuthProvider', () => {
  let provider: StubProvider;

  beforeEach(() => {
    // ConfigService reads process.env at construction. jest.setup.ts
    // primes APP_ID / APP_PRIVATE_KEY so the real ConfigService is
    // happy without touching real credentials.
    const config = new ConfigService();
    provider = new StubProvider(config);
  });

  it('returns an Octokit on first call and caches the same instance', () => {
    const a = provider.forInstallation(42);
    const b = provider.forInstallation(42);
    expect(a).toBe(b);
    expect(provider.callLog).toEqual([42]);
  });

  it('constructs a separate Octokit per installationId', () => {
    const a = provider.forInstallation(42);
    const b = provider.forInstallation(99);
    expect(a).not.toBe(b);
    expect(provider.callLog).toEqual([42, 99]);
  });

  it('rejects non-positive installationIds', () => {
    expect(() => provider.forInstallation(0)).toThrow(/installationId/);
    expect(() => provider.forInstallation(-1)).toThrow(/installationId/);
    expect(() => provider.forInstallation(1.5)).toThrow(/installationId/);
  });

  it('invalidateInstallation evicts the cache entry so the next call re-creates', () => {
    const a = provider.forInstallation(42);
    provider.invalidateInstallation(42);
    const b = provider.forInstallation(42);
    expect(a).not.toBe(b);
    expect(provider.callLog).toEqual([42, 42]);
  });

  describe('checks permission cache', () => {
    it('hasChecksPermission returns true by default', () => {
      expect(provider.hasChecksPermission(42)).toBe(true);
    });

    it('markChecksPermissionMissing flips hasChecksPermission to false', () => {
      provider.markChecksPermissionMissing(42);
      expect(provider.hasChecksPermission(42)).toBe(false);
    });

    it('is scoped per installation', () => {
      provider.markChecksPermissionMissing(42);
      expect(provider.hasChecksPermission(43)).toBe(true);
    });

    it('invalidateInstallation clears the missing-permission flag', () => {
      provider.markChecksPermissionMissing(42);
      provider.invalidateInstallation(42);
      expect(provider.hasChecksPermission(42)).toBe(true);
    });
  });
});

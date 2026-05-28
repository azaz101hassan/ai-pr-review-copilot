import { Logger } from '@nestjs/common';
import { ConfigService } from '@/config';
import {
  GitHubAppService,
  GithubRequestError,
} from '@/infrastructure/github';
import type { IGithubAuthProvider } from '@/modules/reviews/types';
import type { Octokit } from 'octokit';

// Stub IGithubAuthProvider — the service injects this but doesn't use
// it for the probe itself (the probe runs on its own App-JWT client).
const stubAuthProvider: IGithubAuthProvider = {
  forInstallation: () => {
    throw new Error('forInstallation should not be called from the probe path');
  },
  invalidateInstallation: () => {
    throw new Error(
      'invalidateInstallation should not be called from the probe path',
    );
  },
};

// Subclass exposes a settable probe-client behavior so tests can stub
// the GET /app response without instantiating real Octokit (which
// would try to sign a JWT with the test PEM stub and fail).
class StubGitHubAppService extends GitHubAppService {
  public stubProbeResponse: { data: { slug?: string } } | undefined;
  public stubProbeError: unknown;
  public requestCalls: string[] = [];

  protected override createProbeClient(): Octokit {
    const fake = {
      request: async (route: string) => {
        this.requestCalls.push(route);
        if (this.stubProbeError) throw this.stubProbeError;
        if (!this.stubProbeResponse) {
          throw new Error('test forgot to set stubProbeResponse');
        }
        return this.stubProbeResponse;
      },
    } as unknown as Octokit;
    return fake;
  }
}

function makeService(opts: { skip?: boolean } = {}): StubGitHubAppService {
  // Honor the optional `skip` override. The default jest.setup.ts
  // value is 'true'; tests that exercise the probe path need it off.
  const prev = process.env.SKIP_GITHUB_APP_PROBE;
  process.env.SKIP_GITHUB_APP_PROBE = opts.skip ? 'true' : 'false';
  try {
    const config = new ConfigService();
    return new StubGitHubAppService(config, stubAuthProvider);
  } finally {
    if (prev === undefined) delete process.env.SKIP_GITHUB_APP_PROBE;
    else process.env.SKIP_GITHUB_APP_PROBE = prev;
  }
}

describe('GitHubAppService.onModuleInit', () => {
  it('skips the probe when SKIP_GITHUB_APP_PROBE=true', async () => {
    const svc = makeService({ skip: true });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(svc.requestCalls).toEqual([]);
  });

  it('runs the probe and logs the App slug on 2xx', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    try {
      const svc = makeService();
      svc.stubProbeResponse = { data: { slug: 'pr-review-copilot' } };
      await svc.onModuleInit();

      // Read mock.calls BEFORE mockRestore — restore clears the call
      // history (jest.spyOn().mockRestore() implicitly mockReset()s).
      expect(svc.requestCalls).toEqual(['GET /app']);
      const logged = logSpy.mock.calls.find(
        (args) =>
          typeof args[0] === 'string' &&
          args[0].startsWith('GitHub App probe OK'),
      );
      expect(logged).toBeDefined();
      expect(logged![0]).toContain('pr-review-copilot');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('handles a missing slug field without throwing', async () => {
    const svc = makeService();
    svc.stubProbeResponse = { data: {} };
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('throws a sanitized GithubRequestError on 401 (invalid credentials)', async () => {
    const svc = makeService();
    svc.stubProbeError = { status: 401, message: 'Bad credentials' };

    let caught: unknown;
    try {
      await svc.onModuleInit();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GithubRequestError);
    const err = caught as GithubRequestError;
    expect(err.status).toBe(401);
    expect(err.errorCode).toBe('app_probe_failed');
    expect(err.message).toContain('401');
    // Scrub discipline: never leak the App PEM, App ID, or
    // raw server message into our Error.message.
    expect(err.message).not.toContain('-----BEGIN');
    expect(err.message).not.toContain('Bad credentials');
  });

  it('classifies 404 as App-not-found', async () => {
    const svc = makeService();
    svc.stubProbeError = { status: 404 };

    let caught: unknown;
    try {
      await svc.onModuleInit();
    } catch (err) {
      caught = err;
    }
    const err = caught as GithubRequestError;
    expect(err.status).toBe(404);
    expect(err.message).toContain('App not found');
  });

  it('classifies a 503 as upstream unavailable', async () => {
    const svc = makeService();
    svc.stubProbeError = { status: 503 };

    let caught: unknown;
    try {
      await svc.onModuleInit();
    } catch (err) {
      caught = err;
    }
    const err = caught as GithubRequestError;
    expect(err.status).toBe(503);
    expect(err.message).toContain('unavailable');
  });

  it('classifies a non-HTTP transport error as network', async () => {
    const svc = makeService();
    svc.stubProbeError = new Error('ECONNREFUSED');

    let caught: unknown;
    try {
      await svc.onModuleInit();
    } catch (err) {
      caught = err;
    }
    const err = caught as GithubRequestError;
    expect(err.status).toBe(0);
    expect(err.message).toContain('network');
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('GithubRequestError', () => {
  it('refuses messages containing a PEM block', () => {
    expect(
      () =>
        new GithubRequestError('-----BEGIN RSA PRIVATE KEY----- leaked', {
          status: 500,
        }),
    ).toThrow(/PEM/);
  });

  it('carries optional installationId and prNodeId', () => {
    const err = new GithubRequestError('boom', {
      status: 500,
      installationId: 42,
      prNodeId: 'PR_nodeid',
    });
    expect(err.installationId).toBe(42);
    expect(err.prNodeId).toBe('PR_nodeid');
  });
});

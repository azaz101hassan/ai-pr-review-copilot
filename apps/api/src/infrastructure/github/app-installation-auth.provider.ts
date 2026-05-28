import { Injectable, Logger } from '@nestjs/common';
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { ConfigService } from '@/config';
import type { IGithubAuthProvider } from '@/modules/reviews/types';

// Day-5 GitHub authentication: App-installation auth via
// @octokit/auth-app. The provider holds one Octokit per
// installationId in an in-process Map so @octokit/auth-app's
// installation-token cache (in-memory, lazy-refresh at the 59-minute
// mark) compounds across job invocations. Constructing a fresh
// Octokit per job forfeits the cache and forces a token-mint
// round-trip per call.
//
// Throttling / retry: the `octokit` umbrella package bakes in
// `@octokit/plugin-throttling` and `@octokit/plugin-retry` with
// default callbacks that auto-retry once on rate-limit. We override
// the throttle callbacks to return `false` so a 429 propagates to
// the caller as a typed `RequestError` — BullMQ then schedules a
// retry with delay rather than blocking inside Octokit. The retry
// plugin still handles 5xx on idempotent GETs with its defaults;
// the Review POST disables retries per-call (see U7).
//
// Per-request timeout: 30 seconds. Without this an upstream GitHub
// API hang stalls the worker indefinitely — with `WORKER_CONCURRENCY=1`
// (the Day-5 default), the whole system stalls. The cap is high
// enough to absorb a slow-but-real response on a large diff fetch
// and low enough to surface a real outage before the agent loop's
// own budget exhausts. F9 closure.
const OCTOKIT_REQUEST_TIMEOUT_MS = 30_000;

@Injectable()
export class AppInstallationAuthProvider implements IGithubAuthProvider {
  private readonly logger = new Logger(AppInstallationAuthProvider.name);
  private readonly cache = new Map<number, Octokit>();

  constructor(private readonly config: ConfigService) {}

  forInstallation(installationId: number): Octokit {
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error(
        `forInstallation called with non-positive installationId: ${installationId}`,
      );
    }
    const cached = this.cache.get(installationId);
    if (cached) return cached;

    const octokit = this.createClient(installationId);
    this.cache.set(installationId, octokit);
    return octokit;
  }

  // Reset the cached Octokit for a given installation. Useful when a
  // 401 surfaces and the operator has rotated the PEM or uninstalled
  // the App — see the Day-5 Open Question about cache invalidation.
  // Not part of the public IGithubAuthProvider interface today; the
  // Day-8 observability work decides whether to promote this.
  invalidateInstallation(installationId: number): void {
    this.cache.delete(installationId);
  }

  // Test seam — overridden in spec to return a stub Octokit without
  // exercising real HTTPS or PEM-parsing. Production path constructs
  // the real client with installation-scoped auth + a throttle policy
  // that surfaces rate-limit to the caller.
  protected createClient(installationId: number): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.appPrivateKey,
        installationId,
      },
      // F9 closure: per-request timeout. Cuts a hung GitHub API
      // off at the network boundary so the worker isn't pinned
      // waiting for a TCP timeout (which can be 2+ minutes on
      // Linux defaults). 30s is comfortably above a healthy diff
      // fetch on a large PR and well below the agent loop's
      // overall budget.
      request: {
        timeout: OCTOKIT_REQUEST_TIMEOUT_MS,
      },
      throttle: {
        // Surface 429s instead of in-callback retry. Returning false
        // tells the throttling plugin not to retry; the original
        // RequestError reaches the caller with `status: 429` and
        // headers preserved so BullMQ can schedule a delayed retry.
        onRateLimit: (
          retryAfter: number,
          options: { method?: string; url?: string },
        ): boolean => {
          this.logger.warn(
            `GitHub rate limit hit on ${options.method ?? 'UNKNOWN'} ${options.url ?? ''} — retry in ${retryAfter}s (no in-callback retry).`,
          );
          return false;
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          options: { method?: string; url?: string },
        ): boolean => {
          this.logger.warn(
            `GitHub secondary rate limit on ${options.method ?? 'UNKNOWN'} ${options.url ?? ''} — retry in ${retryAfter}s (no in-callback retry).`,
          );
          return false;
        },
      },
    });
  }
}

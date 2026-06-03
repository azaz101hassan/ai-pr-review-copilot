import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { ConfigService } from '@/config';
import {
  GITHUB_AUTH_PROVIDER,
  IGithubAuthProvider,
} from '@/modules/reviews/types';
import { GithubRequestError } from './github-request.error';

// Boot probe for the GitHub App credentials. Runs `GET /app` with the
// App's JWT (no installation needed) at module init so a malformed
// PEM, wrong App ID, or revoked private key fails the process before
// HTTP routes bind — the fail-fast principle from
// `validateRedisUrl`/`requireAppPrivateKey` extends past env parsing
// into "does the credential actually authenticate." Paired with the
// Redis PING probe in QueueModule.
//
// The probe Octokit is constructed inline rather than going through
// `IGithubAuthProvider.forInstallation` because the App JWT path needs
// no installationId — we don't want to forge a fake installation
// number just to satisfy the per-installation cache shape.

@Injectable()
export class GitHubAppService implements OnModuleInit {
  private readonly logger = new Logger(GitHubAppService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(GITHUB_AUTH_PROVIDER)
    // Held for future use (DI sanity check + probe parity logging).
    // The probe itself uses its own Octokit (see createProbeClient).
    private readonly authProvider: IGithubAuthProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.skipGithubAppProbe) {
      this.logger.warn(
        'GitHub App probe skipped via SKIP_GITHUB_APP_PROBE=true. Production must leave this unset.',
      );
      return;
    }
    await this.runProbe();
  }

  // Public so a future health surface can re-run it on demand.
  async runProbe(): Promise<void> {
    const probe = this.createProbeClient();
    try {
      const res = await probe.request('GET /app');
      const slug =
        (res.data as { slug?: string } | undefined)?.slug ?? '(slug unknown)';
      this.logger.log(`GitHub App probe OK — installed as "${slug}".`);
    } catch (err) {
      throw this.classifyProbeError(err);
    }
  }

  // Test seam — overridden in spec to substitute a mock client.
  protected createProbeClient(): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.appPrivateKey,
      },
    });
  }

  private classifyProbeError(err: unknown): GithubRequestError {
    // Octokit RequestError carries `status` and a short `message`.
    // We never echo the response body (it's safe in this case but
    // the scrub discipline stays uniform across call sites).
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? (err as { status?: unknown }).status
        : undefined;
    const numericStatus =
      typeof status === 'number' && Number.isFinite(status) ? status : 0;

    // Pick a short, identity-free summary line. Never the response
    // body — `RequestError.message` may include a long server JSON
    // string echoed verbatim by Octokit.
    const summary =
      numericStatus === 401
        ? 'GitHub App probe failed: 401 — the App ID or private key is invalid.'
        : numericStatus === 404
          ? 'GitHub App probe failed: 404 — App not found.'
          : numericStatus >= 500
            ? `GitHub App probe failed: ${numericStatus} — GitHub API unavailable.`
            : numericStatus > 0
              ? `GitHub App probe failed: HTTP ${numericStatus}.`
              : 'GitHub App probe failed: network or transport error.';

    return new GithubRequestError(summary, {
      status: numericStatus,
      errorCode: 'app_probe_failed',
      cause: err,
    });
  }
}

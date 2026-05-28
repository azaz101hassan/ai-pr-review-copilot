import type { Octokit } from 'octokit';

// IGithubAuthProvider is the swap seam for the GitHub authentication
// strategy the worker uses to mint Octokit instances for a particular
// installation. Day 5 ships one binding — `AppInstallationAuthProvider`
// (GitHub App installation auth, see infrastructure/github/) — and the
// `IGithubAuthProvider` contract stays narrow enough that a future
// `PersonalAccessTokenAuthProvider` (Day 8 or 10) plugs into the same
// token without renegotiating consumers.
//
// Token identity: a single GITHUB_AUTH_PROVIDER Symbol so consumers
// (`ReviewsProcessor`, future health surfaces) inject the interface
// rather than the concrete class. Mirrors the LLM_REVIEWER, VECTOR_STORE,
// and REPO_CONTEXT_PROVIDER pattern already used elsewhere.
export const GITHUB_AUTH_PROVIDER = Symbol('GithubAuthProvider');

export interface IGithubAuthProvider {
  // Return an Octokit instance scoped to the given installation. The
  // returned Octokit MUST be reused across calls for the same
  // installationId so @octokit/auth-app's installation-token cache
  // compounds (in-memory, lazy-refresh at the 59-minute mark).
  // Constructing a fresh Octokit per job forfeits the cache and
  // triggers a token-mint round-trip per call.
  forInstallation(installationId: number): Octokit;

  // F12 closure. Drop the cached Octokit for an installation. The
  // worker calls this on 401 (the App was uninstalled, the PEM was
  // rotated, or the installation token revoked) so the next
  // forInstallation call mints a fresh client. The webhook
  // `installation.deleted` / `installation.suspend` handlers also
  // call this — see WebhookService.
  invalidateInstallation(installationId: number): void;
}

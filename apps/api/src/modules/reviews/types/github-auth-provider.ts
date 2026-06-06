import type { Octokit } from 'octokit';

// IGithubAuthProvider is the swap seam for the GitHub authentication
// strategy the worker uses to mint Octokit instances for a particular
// installation. The current binding is `AppInstallationAuthProvider`
// (GitHub App installation auth, see infrastructure/github/). The
// contract is narrow enough that a future
// `PersonalAccessTokenAuthProvider` could plug into the same token
// without renegotiating consumers.
//
// A single GITHUB_AUTH_PROVIDER Symbol so consumers (`ReviewsProcessor`,
// future health surfaces) inject the interface rather than the concrete
// class. Mirrors the LLM_REVIEWER, VECTOR_STORE, and
// REPO_CONTEXT_PROVIDER pattern.
export const GITHUB_AUTH_PROVIDER = Symbol('GithubAuthProvider');

export interface IGithubAuthProvider {
  // Return an Octokit instance scoped to the given installation. The
  // returned Octokit MUST be reused across calls for the same
  // installationId so @octokit/auth-app's installation-token cache
  // compounds (in-memory, lazy-refresh at the 59-minute mark).
  // Constructing a fresh Octokit per job forfeits the cache and
  // triggers a token-mint round-trip per call.
  forInstallation(installationId: number): Octokit;

  // Drop the cached Octokit for an installation. The worker calls
  // this on 401 (the App was uninstalled, the PEM was rotated, or
  // the installation token revoked) so the next forInstallation call
  // mints a fresh client. The webhook `installation.deleted` /
  // `installation.suspend` handlers also call this — see
  // WebhookService. Also clears the missing-checks-permission flag
  // for the installation — a fresh install/re-auth usually means the
  // permission was re-accepted; we let the next review re-detect.
  invalidateInstallation(installationId: number): void;

  // Cache of installations the worker has detected as missing the
  // "Checks" permission. The worker calls markChecksPermissionMissing
  // on the first check-run POST 403; it checks hasChecksPermission
  // before every subsequent check-run POST and PATCH. The set is
  // in-memory only — it resets on worker restart, at which point the
  // next review re-detects.
  markChecksPermissionMissing(installationId: number): void;
  hasChecksPermission(installationId: number): boolean;
}

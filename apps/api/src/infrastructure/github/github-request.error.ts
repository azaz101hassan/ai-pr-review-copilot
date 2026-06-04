// Typed error wrapping any Octokit/GitHub API failure. Mirrors
// `LlmRequestError` so call sites in `ReviewsProcessor` and
// `GitHubRepoContextProvider` can branch on `status` + `errorCode`
// without stringifying the message.
//
// SCRUB DISCIPLINE: we never include the response body, the App PEM,
// installation tokens, PR contents, or diff text in the message or in
// any field on this error. Octokit's `RequestError.message` echoes
// the server's error JSON which is OK to log; we intentionally
// re-construct our own message from `status` + a short summary so the
// shape stays predictable. The `cause` is kept for debugging but
// consumers should treat it as opaque and not stringify it into logs
// without auditing what it carries.

export class GithubRequestError extends Error {
  readonly name = 'GithubRequestError';
  readonly status: number;
  readonly errorCode?: string;
  // Server-provided textual explanation of why the request failed
  // (e.g. "Not Found" or "validation_failed"). This is the SERVER's
  // explanation, not echoed input — safe to surface in logs.
  // Distinct from `Error.message` which we construct ourselves.
  readonly serverMessage?: string;
  // Partial-state fields that may be useful for the `reviews` row's
  // failure record when the worker classifies this error. Both are
  // optional because some failures (the GET /app boot probe) happen
  // before either is known.
  readonly installationId?: number;
  readonly prNodeId?: string;
  override readonly cause?: unknown;

  constructor(
    message: string,
    opts: {
      status: number;
      errorCode?: string;
      serverMessage?: string;
      installationId?: number;
      prNodeId?: string;
      cause?: unknown;
    },
  ) {
    // Belt-and-suspenders: the constructor refuses messages that look
    // like leaked secrets. `requireAppPrivateKey` in ConfigService
    // checks for "-----BEGIN" too; this is the second layer in case a
    // future caller forgets the discipline above.
    if (message.includes('-----BEGIN')) {
      throw new Error(
        'GithubRequestError refuses messages containing a PEM block.',
      );
    }
    super(message);
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.serverMessage = opts.serverMessage;
    this.installationId = opts.installationId;
    this.prNodeId = opts.prNodeId;
    this.cause = opts.cause;
  }
}

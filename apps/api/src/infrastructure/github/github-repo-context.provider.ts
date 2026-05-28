import type { Octokit } from 'octokit';
import {
  IRepoContextProvider,
  PriorReviewEntry,
  PriorReviewQuery,
  RepoContextError,
  RepoContextErrorReason,
  RepoFileResult,
  RepoFunctionResult,
  RepoPriorReviewResult,
} from '@/modules/reviews/types/repo-context-provider';
import type { IReviewFindingRepository } from '@/modules/reviews/types/review-finding.repository';
import { grepFunctionDefinition } from '@/infrastructure/repo-context/helpers/grep-function-definition';
import { formatBriefError, readStatus } from '@/types';

// Day-5 GitHub-API-backed implementation of IRepoContextProvider.
// Constructed once per job by ReviewsProcessor (U7) — the Octokit
// instance is per-installation (sourced from IGithubAuthProvider's
// cache) and the owner/repo/head_sha/pr_node_id tuple is the
// per-PR-run context. The provider never throws: any unexpected error
// wraps into `{ ok: false, reason: 'network', message: <sanitized> }`
// so the agent loop's tool-call protocol stays intact (a thrown
// exception would abort the whole turn rather than letting Claude
// recover).
//
// Day-5 invariants the provider satisfies:
//   - fetchFile honours a 1 MB cap via the response's `size` field
//     (short-circuits before downloading the full base64 payload).
//   - The wider RepoContextErrorReason vocabulary contracted in Day 4
//     (`forbidden | rate_limited | network`) is now exercised:
//       404 → not_found
//       403 with rate-limit-remaining: 0 / 429 → rate_limited
//       other 403 → forbidden
//       5xx / transport → network
//   - fetchPriorReview delegates to a SQL repository method that
//     joins reviews INNER JOIN review_findings filtered to
//     successfully-completed prior runs.
//
// Per-fetch byte cap. The GitHub Contents API only returns base64
// content for files ≤ 1 MB; larger files require the blob endpoint.
// We honour the documented cap so the agent gets a clean `not_found`
// (rather than an opaque API error) when it reaches for a generated
// bundle or a vendored binary.
const MAX_FILE_BYTES = 1_048_576;

export interface GitHubRepoContextProviderOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  head_sha: string;
  pr_node_id: string;
  priorReviewRepo: IReviewFindingRepository;
}

export class GitHubRepoContextProvider implements IRepoContextProvider {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly headSha: string;
  private readonly prNodeId: string;
  private readonly priorReviewRepo: IReviewFindingRepository;

  constructor(opts: GitHubRepoContextProviderOptions) {
    this.octokit = opts.octokit;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.headSha = opts.head_sha;
    this.prNodeId = opts.pr_node_id;
    this.priorReviewRepo = opts.priorReviewRepo;
  }

  async fetchFile(filePath: string): Promise<RepoFileResult> {
    if (!filePath || typeof filePath !== 'string') {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'path is required',
      };
    }

    // F10 closure: honour the IRepoContextProvider.fetchFile
    // contract's `invalid_input` reason for path-traversal segments,
    // leading slash, query/fragment separators, and control
    // characters. Octokit's getContent IS server-side-safe today
    // (GitHub strips traversal), but the interface contract is
    // shared with future providers (including a Day-7 local-FS
    // fallback) that trust this layer to have already filtered.
    const invalid = invalidFilePathReason(filePath);
    if (invalid) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: invalid,
      };
    }

    try {
      const res = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref: this.headSha,
      });

      const data = res.data;

      // Directory listings return an array. Caller asked for a file.
      if (Array.isArray(data)) {
        return {
          ok: false,
          reason: 'not_found',
          message: `path is a directory, not a file: ${filePath}`,
        };
      }

      const node = data as {
        type?: string;
        size?: number;
        content?: string;
        encoding?: string;
      };

      if (node.type !== 'file') {
        return {
          ok: false,
          reason: 'not_found',
          message: `path is not a file: ${filePath}`,
        };
      }

      if (typeof node.size === 'number' && node.size > MAX_FILE_BYTES) {
        return {
          ok: false,
          reason: 'not_found',
          message: `file exceeds 1 MB API limit (${node.size} bytes): ${filePath}`,
        };
      }

      if (!node.content || node.encoding !== 'base64') {
        return {
          ok: false,
          reason: 'not_found',
          message: `file content missing or unexpected encoding: ${filePath}`,
        };
      }

      const decoded = Buffer.from(node.content, 'base64').toString('utf8');
      return { ok: true, content: decoded, path: filePath };
    } catch (err) {
      return this.classifyApiError(err, `fetchFile(${filePath})`);
    }
  }

  async fetchFunctionDefinition(
    name: string,
    file?: string,
  ): Promise<RepoFunctionResult> {
    if (!name || typeof name !== 'string') {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'function name is required',
      };
    }
    // The Octokit code-search alternative for the unhinted case (no
    // `file` arg) is rate-limited at 30 req/min on Apps and would
    // burn the agent's effective tool budget; mirroring the filesystem
    // provider's "needs a file arg" pattern is the simpler honest
    // contract for Day 5.
    if (!file) {
      return {
        ok: false,
        reason: 'invalid_input',
        message:
          'fetch_function_definition requires a file path on the GitHub provider (repo-wide search is out of scope).',
      };
    }

    const fetched = await this.fetchFile(file);
    if (!fetched.ok) return fetched;

    const match = grepFunctionDefinition(name, fetched.content);
    if (!match) {
      return {
        ok: false,
        reason: 'parse_error',
        message: `function definition not found in ${file}: ${name}`,
      };
    }
    return {
      ok: true,
      content: match.content,
      path: file,
      startLine: match.startLine,
      endLine: match.endLine,
    };
  }

  async fetchPriorReview(
    query: PriorReviewQuery,
  ): Promise<RepoPriorReviewResult> {
    // Default to the run's own PR when query.pr_node_id is absent —
    // the agent loop's emit-tool input usually omits it because the
    // run is already pre-scoped to the PR; passing it through
    // explicitly stays a no-op.
    const prNodeId = query.pr_node_id ?? this.prNodeId;

    let rows: PriorReviewEntry[];
    try {
      rows = this.priorReviewRepo.findByPrNodeIdForPriorReview(prNodeId);
    } catch (err) {
      // Repository failure is wrapped as `network` so the agent loop
      // treats it as a transient outage and proceeds to emit with
      // the context it has. SQLite errors on the local DB are rare
      // but possible (disk full, locked).
      return {
        ok: false,
        reason: 'network',
        message: `prior review fetch failed: ${formatBriefError(err)}`,
      };
    }

    // In-memory filter — the typical prior-review result set per PR is
    // ≤ 100 findings even after several re-runs, so JS filtering wins
    // the simplicity trade vs. building a multi-column predicate.
    const filtered = rows.filter((entry) => {
      if (query.file_path && entry.file_path !== query.file_path) return false;
      if (query.rule_id && entry.rule_id !== query.rule_id) return false;
      return true;
    });

    return { ok: true, content: filtered };
  }

  // Map an Octokit RequestError or transport exception into a
  // RepoContextError. Never throws. Designed to keep the agent loop
  // alive on any conceivable upstream failure.
  private classifyApiError(err: unknown, ctx: string): RepoContextError {
    const status = readStatus(err);
    const headers = readHeaders(err);

    if (status === 404) {
      return {
        ok: false,
        reason: 'not_found',
        message: `not found: ${ctx}`,
      };
    }
    if (status === 429) {
      return {
        ok: false,
        reason: 'rate_limited',
        message: `rate limited: ${ctx}`,
        retryAfterMs: parseRetryAfterMs(headers),
      };
    }
    if (status === 403) {
      // GitHub returns 403 for both forbidden AND primary rate-limit
      // exhaustion. Disambiguate via x-ratelimit-remaining.
      const remaining = firstHeader(headers['x-ratelimit-remaining']);
      if (remaining === '0') {
        return {
          ok: false,
          reason: 'rate_limited',
          message: `rate limited: ${ctx}`,
          retryAfterMs: parseRetryAfterMs(headers),
        };
      }
      return {
        ok: false,
        reason: 'forbidden',
        message: `forbidden: ${ctx}`,
      };
    }
    if (status === 401) {
      return {
        ok: false,
        reason: 'forbidden',
        message: `unauthorized: ${ctx}`,
      };
    }
    // 5xx / transport / unknown — all surface as `network`. The agent
    // can either retry a different input or give up; the worker's
    // outer error classifier (U7) catches subsequent failures.
    const reason: RepoContextErrorReason = 'network';
    return {
      ok: false,
      reason,
      message: `network error: ${ctx}${status > 0 ? ` (status ${status})` : ''}`,
    };
  }
}

// F10 closure. Reject obvious path-traversal / control-char
// payloads before the GET hits Octokit. The check is conservative —
// it doesn't try to resolve `..` against the repo root (that's
// server-side), just refuses to send strings that no honest caller
// would use. Returns the reason string when invalid, undefined when
// the path looks safe to forward.
function invalidFilePathReason(filePath: string): string | undefined {
  if (filePath.length === 0) return 'path is required';
  // Control characters anywhere — `\0`, `\n`, `\r`, `\t`, etc. URL
  // metacharacters (`?`, `#`) would be re-interpreted by GitHub's
  // path parser and most callers don't intend them. Backslashes
  // ditto (Octokit normalises but the agent shouldn't be sending
  // Windows-shaped paths).
  if (/[\x00-\x1f\x7f?#\\]/.test(filePath)) {
    return `path contains control or reserved characters: ${redact(filePath)}`;
  }
  // Absolute paths — Octokit will treat a leading slash as part of
  // the path key; the contract says relative-to-repo-root paths
  // only.
  if (filePath.startsWith('/')) {
    return `path must be relative to the repo root (got "${redact(filePath)}")`;
  }
  // Path-traversal segments. `..` anywhere as its own segment is
  // suspicious; we refuse rather than try to resolve.
  const segments = filePath.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    return `path contains traversal segment: ${redact(filePath)}`;
  }
  return undefined;
}

function redact(value: string): string {
  // Keep error messages bounded — a hostile path could be very
  // long. Surfaced into agent-visible tool_results.
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function readHeaders(err: unknown): HeaderMap {
  if (typeof err !== 'object' || err === null) return {};
  const responseHeaders = (err as { response?: { headers?: unknown } }).response
    ?.headers;
  if (responseHeaders && typeof responseHeaders === 'object') {
    return responseHeaders as HeaderMap;
  }
  const flatHeaders = (err as { headers?: unknown }).headers;
  if (flatHeaders && typeof flatHeaders === 'object') {
    return flatHeaders as HeaderMap;
  }
  return {};
}

// F21 closure. HTTP header values are `string | string[]` (e.g.,
// `set-cookie` is canonically multi-value); the previous
// `Record<string, string>` cast silently lost array values. Type
// the surface accurately and collapse to the first when our
// downstream parsers want a singular.
type HeaderValue = string | string[] | undefined;
type HeaderMap = Record<string, HeaderValue>;

function firstHeader(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseRetryAfterMs(headers: HeaderMap): number | undefined {
  // GitHub honours both `retry-after` (delta seconds) and the
  // `x-ratelimit-reset` epoch-seconds form. Prefer the delta when
  // present — it's shorter and the API guarantees it on rate-limit
  // bodies.
  const retryAfter =
    firstHeader(headers['retry-after']) ??
    firstHeader(headers['Retry-After']);
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
  }
  const reset =
    firstHeader(headers['x-ratelimit-reset']) ??
    firstHeader(headers['X-RateLimit-Reset']);
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      const deltaMs = epochSeconds * 1000 - Date.now();
      if (deltaMs > 0) return deltaMs;
    }
  }
  return undefined;
}


// Fetch helper for the dashboard API.
//
// Server-side (Server Components — current sole usage):
//   Goes directly to API_INTERNAL_URL (default http://localhost:3001).
//   Node's fetch requires an absolute URL, and the next.config.js rewrites
//   proxy only exists at the browser layer — so SSR must talk to the API
//   host directly.
//
// Browser-side (preserved for any future Client Component caller):
//   Goes through the same-origin /api/dashboard prefix, which next.config.js
//   rewrites to the API. Same-origin avoids CORS preflight regardless of
//   how API_INTERNAL_URL is mapped.

/** Thrown on any non-2xx response from the dashboard API. */
export class FetchDashboardError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Dashboard API returned ${status}`);
    this.name = 'FetchDashboardError';
  }
}

/**
 * Fetch a JSON response from the dashboard API.
 *
 * @param path     Path under /api/dashboard (e.g. "/analytics", "/reviews")
 * @param params   Optional filter params that will be appended as query string
 * @param init     Optional fetch init overrides (cache defaults to 'no-store')
 *
 * On non-2xx responses, throws FetchDashboardError. Callers should:
 *   - Branch on error.status === 404 to call notFound() from next/navigation
 *   - Re-throw all other errors (caught by the nearest error.tsx boundary)
 */
export async function fetchDashboard<T>(
  path: string,
  params?: Record<string, string | string[] | undefined> | URLSearchParams,
  init?: RequestInit,
): Promise<T> {
  const isServer = typeof window === 'undefined';
  const url = isServer
    ? new URL(
        `${process.env.API_INTERNAL_URL ?? 'http://localhost:3001'}/dashboard${path}`,
      )
    : new URL(`/api/dashboard${path}`, 'http://localhost');

  // Serialize filter params into the query string.
  if (params) {
    const entries =
      params instanceof URLSearchParams
        ? params.entries()
        : Object.entries(params);
    for (const [key, value] of entries) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, value as string);
      }
    }
  }

  // Server: absolute URL is required by Node's fetch. Browser: same-origin
  // path so the rewrites proxy handles it (the 'http://localhost' base above
  // is only there to satisfy URL()'s parser; we drop it before fetch()).
  const href = isServer ? url.toString() : `${url.pathname}${url.search}`;

  const response = await fetch(href, {
    cache: 'no-store',
    ...init,
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new FetchDashboardError(response.status, body);
  }

  return body as T;
}

/**
 * Convert a plain searchParams object (from a Next.js Server Component's
 * searchParams prop) into URLSearchParams, omitting undefined/empty values.
 */
export function toURLSearchParams(
  params: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

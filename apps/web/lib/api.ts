// Fetch helper for the /api/dashboard/* surface.
// The /api/* prefix is proxied to the NestJS API on localhost:3001 via
// next.config.js rewrites (local-dev CORS avoidance, see next.config.js).

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
  const base = '/api/dashboard';
  const url = new URL(`${base}${path}`, 'http://localhost');

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

  // Use only the pathname + search so this works in both SSR (where there's no
  // real host) and via the Next.js rewrites proxy.
  const href = `${url.pathname}${url.search}`;

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

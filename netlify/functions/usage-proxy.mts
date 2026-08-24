/**
 * Server-side proxy to the Netlify Usage API.
 *
 * Both halves of the upstream credential live in this site's environment: USAGE_API_URL
 * (where to call) and CUSTOMER_API_KEY (the bearer token, attached here so it never
 * reaches the browser). Every dashboard load is a fresh upstream API request made with
 * that key; nothing is cached or stored. The proxy is also unavoidable for a browser
 * client because the upstream sends no CORS headers.
 *
 * NOTE: with the key attached server-side, anyone who can reach this site can read the
 * data. Restrict the audience with Netlify site protection (password / team access) if
 * the dashboard URL is not treated as private.
 *
 * Routes (all read-only):
 *   GET /api/health      -> upstream GET /v1/health
 *   GET /api/usage       -> upstream GET /v1/usage       (start, end, granularity)
 *   GET /api/allocation  -> upstream GET /v1/allocation  (start, end, format)
 */
import type { Config, Context } from '@netlify/functions';

const UPSTREAM_TIMEOUT_MS = 25_000;

/** Per-route upstream path + the only query params forwarded (everything else is dropped). */
const ROUTES: Record<string, { upstream: string; params: readonly string[] }> = {
  '/api/health': { upstream: '/v1/health', params: [] },
  '/api/usage': { upstream: '/v1/usage', params: ['start', 'end', 'granularity'] },
  '/api/allocation': { upstream: '/v1/allocation', params: ['start', 'end', 'format'] },
};

const NO_STORE: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE },
  });

export default async (request: Request, _context: Context): Promise<Response> => {
  if (request.method !== 'GET') return json(405, { error: { status: 405, message: 'Method not allowed' } });

  const url = new URL(request.url);
  const route = ROUTES[url.pathname];
  if (!route) return json(404, { error: { status: 404, message: 'Not found' } });

  const base = (process.env.USAGE_API_URL ?? '').replace(/\/+$/, '');
  // The upstream accepts any key in its comma-separated set; send the first configured one.
  const key = (process.env.CUSTOMER_API_KEY ?? '').split(',')[0]?.trim() ?? '';
  if (!base || (!key && url.pathname !== '/api/health')) {
    return json(500, { error: { status: 500, message: 'Proxy is not configured (USAGE_API_URL / CUSTOMER_API_KEY)' } });
  }

  const upstream = new URL(base + route.upstream);
  for (const p of route.params) {
    const v = url.searchParams.get(p);
    if (v !== null) upstream.searchParams.set(p, v);
  }

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    return json(504, { error: { status: 504, message: timedOut ? 'Upstream timed out' : 'Upstream unreachable' } });
  }

  // Pass the body through but rebuild headers, so nothing upstream-internal leaks and the
  // CSV download keeps its filename.
  const headers: Record<string, string> = {
    'Content-Type': res.headers.get('content-type') ?? 'application/json; charset=utf-8',
    ...NO_STORE,
  };
  const disposition = res.headers.get('content-disposition');
  if (disposition) headers['Content-Disposition'] = disposition;

  return new Response(res.body, { status: res.status, headers });
};

export const config: Config = {
  path: ['/api/health', '/api/usage', '/api/allocation'],
  rateLimit: { windowSize: 60, windowLimit: 60, aggregateBy: ['ip', 'domain'] },
};

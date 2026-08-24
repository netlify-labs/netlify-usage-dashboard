/**
 * Server-side proxy to the Netlify Usage API.
 *
 * Why this exists: the upstream usage API is bearer-authed with CUSTOMER_API_KEY and sends
 * no CORS headers, so a browser cannot (and should not) call it directly. The key stays in
 * this function's environment and never reaches the client.
 *
 * Routes (all read-only):
 *   GET /api/health      -> upstream GET /v1/health
 *   GET /api/usage       -> upstream GET /v1/usage       (start, end, granularity)
 *   GET /api/allocation  -> upstream GET /v1/allocation  (start, end, format)
 *
 * Optional second lock: set DASHBOARD_ACCESS_KEY and every request here must carry
 * Authorization: Bearer <key>. Comparison is timing-safe. Comma-separate to keep more than
 * one key active during rotation. Leave it unset only if the dashboard site itself is
 * access-controlled some other way (Netlify password protection, private network).
 */
import type { Config, Context } from '@netlify/functions';
import { timingSafeEqual } from 'node:crypto';

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

/** Timing-safe membership test against a comma-separated key set. */
function keyMatches(candidate: string | null, configured: string): boolean {
  if (!candidate) return false;
  const cand = Buffer.from(candidate, 'utf8');
  let ok = false;
  for (const part of configured.split(',')) {
    const key = Buffer.from(part.trim(), 'utf8');
    if (key.length === 0) continue;
    // Compare against a same-length buffer so length never short-circuits the comparison.
    if (key.length === cand.length && timingSafeEqual(key, cand)) ok = true;
  }
  return ok;
}

function bearerFrom(request: Request): string | null {
  const raw = request.headers.get('authorization');
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

export default async (request: Request, _context: Context): Promise<Response> => {
  if (request.method !== 'GET') return json(405, { error: { status: 405, message: 'Method not allowed' } });

  const url = new URL(request.url);
  const route = ROUTES[url.pathname];
  if (!route) return json(404, { error: { status: 404, message: 'Not found' } });

  // Optional dashboard-level auth (recommended). Health stays open as a liveness probe.
  const accessKeys = process.env.DASHBOARD_ACCESS_KEY ?? '';
  if (accessKeys && url.pathname !== '/api/health' && !keyMatches(bearerFrom(request), accessKeys)) {
    return json(401, { error: { status: 401, message: 'Unauthorized', code: 'dashboard_key_required' } });
  }

  const base = (process.env.USAGE_API_URL ?? '').replace(/\/+$/, '');
  const customerKeys = process.env.CUSTOMER_API_KEY ?? '';
  if (!base || (!customerKeys && url.pathname !== '/api/health')) {
    return json(500, { error: { status: 500, message: 'Proxy is not configured (USAGE_API_URL / CUSTOMER_API_KEY)' } });
  }
  // The upstream accepts any key in its set; send the first configured one.
  const customerKey = customerKeys.split(',')[0]?.trim() ?? '';

  const upstream = new URL(base + route.upstream);
  for (const p of route.params) {
    const v = url.searchParams.get(p);
    if (v !== null) upstream.searchParams.set(p, v);
  }

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: customerKey ? { authorization: `Bearer ${customerKey}` } : {},
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

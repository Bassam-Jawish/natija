/**
 * Routes of the mock API: the same paths (under /api/v1) and permission checks as the server.
 * Handlers return the response body; thrown AppErrors become problem responses.
 */
import { AppError, forbidden, unauthorized, withContext, type MockAuth } from './context';
import { MockFile } from './file';

export type MockRequest = {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body: any;
  auth: MockAuth | null;
};

export type RouteOptions = {
  /** No sign-in needed (login, patient portal, verification page). */
  public?: boolean;
  /** Any one of these permissions is enough (as in the server's route config). */
  perm?: string | string[];
};

type Handler = (req: MockRequest) => unknown;
type Route = { method: string; segments: string[]; opts: RouteOptions; handler: Handler; score: number };

const routes: Route[] = [];

/** Register a route, e.g. route('GET', '/patients/:id', { perm: 'patients.read' }, (req) => …). */
export function route(method: string, path: string, opts: RouteOptions | Handler, handler?: Handler): void {
  const h = typeof opts === 'function' ? opts : handler!;
  const o = typeof opts === 'function' ? {} : opts;
  const segments = path.split('/').filter(Boolean);
  routes.push({ method: method.toUpperCase(), segments, opts: o, handler: h, score: segments.filter((s) => !s.startsWith(':')).length });
}

export function routeCount(): number {
  return routes.length;
}

function match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  let best: { route: Route; params: Record<string, string> } | null = null;
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = r.segments[i]!;
      if (seg.startsWith(':')) params[seg.slice(1)] = parts[i]!;
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok && (!best || r.score > best.route.score)) best = { route: r, params };
  }
  return best;
}

function parseQuery(qs: string): MockRequest['query'] {
  const out: MockRequest['query'] = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

export type MockResponse = { status: number; data: unknown };

export function problem(status: number, code: string, title: string, errors?: Record<string, string[]>, details?: unknown): MockResponse {
  // `detail` (a string) is what the server sends and the web app reads; `details` keeps anything structured.
  return { status, data: { title, status, code, errors, detail: typeof details === 'string' ? details : undefined, details } };
}

/** Run one request against the mock API. `url` is the path after /api/v1, with its query string. */
export async function dispatch(method: string, url: string, body: unknown, auth: MockAuth | null): Promise<MockResponse> {
  const [path = '/', qs = ''] = url.split('?');
  const m = match(method.toUpperCase(), path);
  if (!m) return problem(404, 'not_found', `No mock for ${method} ${path}`);
  const { route: r, params } = m;
  const req: MockRequest = { method: method.toUpperCase(), path, params, query: parseQuery(qs), body, auth };
  try {
    if (!r.opts.public) {
      if (!auth) throw unauthorized();
      if (r.opts.perm) {
        const needed = Array.isArray(r.opts.perm) ? r.opts.perm : [r.opts.perm];
        if (!needed.some((p) => auth.permissions.has(p))) throw forbidden('permission', `Needs ${needed.join(' or ')}`);
      }
    }
    const run = () => r.handler(req);
    const result = auth
      ? await withContext({ labId: auth.labId, userId: auth.userId, actorName: auth.user.fullNameEn, auth }, async () => await run())
      : await run();
    if (result === undefined) return { status: 204, data: undefined };
    if (result instanceof MockFile) return { status: 200, data: result };
    // The same JSON round trip as HTTP: dates become ISO strings, undefined fields disappear.
    return { status: 200, data: JSON.parse(JSON.stringify(result)) };
  } catch (err) {
    if (err instanceof AppError) return problem(err.status, err.code, err.message, err.errors, err.details);
    console.error('[mock]', method, url, err);
    return problem(500, 'internal', err instanceof Error ? err.message : 'Mock error');
  }
}

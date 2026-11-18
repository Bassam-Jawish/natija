/**
 * Small fetch wrapper for the Natija API.
 * - Same-origin requests to /api/v1 with the session cookie.
 * - Sends the CSRF token on POST/PUT/PATCH/DELETE.
 * - Turns problem+json responses into ApiError with a stable `code`.
 */

import { loadedMock, loadMock, MOCK } from './mode';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public errors?: Record<string, string[]>,
    public detail?: string,
  ) {
    super(message);
  }
}

let csrfToken = '';
export function setCsrfToken(token: string) {
  csrfToken = token;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

const BASE = '/api/v1';

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Mock mode: the same call answered inside the browser (see src/mock). */
async function mockCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await (await loadMock()).mockRequest(method, path, body);
  if (res.status === 204) return undefined as T;
  if (res.status >= 400) {
    if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/login')) onUnauthorized();
    const p = (res.data ?? {}) as { title?: string; code?: string; errors?: Record<string, string[]>; detail?: string };
    throw new ApiError(res.status, p.code ?? `http_${res.status}`, p.title ?? 'Error', p.errors, p.detail);
  }
  return res.data as T;
}

async function request<T>(method: string, path: string, body?: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
  if (MOCK) return mockCall<T>(method, path, body);
  const headers: Record<string, string> = { Accept: 'application/json', ...(init?.headers ?? {}) };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, credentials: 'same-origin', signal: init?.signal });
  if (res.status === 204) return undefined as T;
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/login')) onUnauthorized();
    const p = (isJson ? data : {}) as { title?: string; code?: string; errors?: Record<string, string[]>; detail?: string };
    throw new ApiError(res.status, p.code ?? `http_${res.status}`, p.title ?? res.statusText, p.errors, p.detail);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', withQuery(path, query), undefined, { signal }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', path, body ?? {}, { headers }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
  /** Absolute URL for downloads (Excel, files) opened by the browser. In mock mode, files are data URLs. */
  url: (path: string, query?: Query) => (MOCK ? loadedMock()?.mockFileUrl(withQuery(path, query)) : null) ?? `${BASE}${withQuery(path, query)}`,
  /** Save an export (Excel; CSV in mock mode) to the user's computer. */
  download: async (path: string, query?: Query) => {
    if (MOCK) return (await loadMock()).mockDownload(withQuery(path, query));
    window.location.href = `${BASE}${withQuery(path, query)}`;
  },
};

/**
 * Test helpers: one in-process API server (Fastify inject, no network) against natija_test,
 * and signed-in clients for any demo user. Demo labs: yasmin, orontes, citadel.
 * Usernames: owner, manager, reception, tech, doctor, accountant (+ tech.hem in yasmin).
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildServer } from '../src/server';

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildServer({ logger: false });
    await app.ready();
  }
  return app;
}

export type Client = Awaited<ReturnType<typeof login>>;

export async function login(lab: string, username: string, password = process.env.DEMO_PASSWORD ?? 'Natija@2026') {
  const server = await getApp();
  const res = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { labCode: lab, username, password } });
  if (res.statusCode !== 200) throw new Error(`login ${lab}/${username} failed: ${res.statusCode} ${res.body}`);
  const sid = res.cookies.find((c) => c.name === 'natija_sid')!.value;
  const me = res.json() as { csrfToken: string; lab: { id: string }; user: { id: string }; permissions: string[] };
  const call = (method: InjectOptions['method'], url: string, payload?: unknown, query?: Record<string, string>) =>
    server.inject({
      method,
      url: url.startsWith('/api/') ? url : `/api/v1${url}`,
      payload: payload as InjectOptions['payload'],
      query,
      cookies: { natija_sid: sid },
      headers: method === 'GET' ? {} : { 'x-csrf-token': me.csrfToken },
    });
  return {
    me,
    get: (url: string, query?: Record<string, string>) => call('GET', url, undefined, query),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload ?? {}),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload ?? {}),
    del: (url: string) => call('DELETE', url),
  };
}

/** Anonymous request (public routes, or to assert 401s). */
export async function anon(method: InjectOptions['method'], url: string, payload?: unknown) {
  const server = await getApp();
  return server.inject({ method, url: url.startsWith('/api/') ? url : `/api/v1${url}`, payload: payload as InjectOptions['payload'] });
}

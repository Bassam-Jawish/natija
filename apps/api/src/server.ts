import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type RouteHandlerMethod } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import './types';
import { config } from './config';
import { appDb, withLab } from './db';
import { authenticateAgent, authenticateToken, csrfFor, SESSION_COOKIE } from './lib/auth';
import { safeEqual } from './lib/crypto';
import { errorHandler, forbidden, unauthorized } from './lib/errors';
import { modules } from './modules';
import { sql } from 'drizzle-orm';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildServer(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
            transport: config.isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
          },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });

  app.decorateRequest('auth', null);
  app.decorateRequest('agent', null);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Only behind HTTPS in production; locally the app runs on plain http://localhost.
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    strictTransportSecurity: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 5 } });

  // Every route runs inside one transaction scoped to the caller's lab (row-level security),
  // unless it opts out with config.tenant = false. Anything the handler sends is held back until
  // the transaction has committed, so a client acting on the response always finds the data.
  app.addHook('onRoute', (route) => {
    const cfg = (route.config ?? {}) as { tenant?: boolean };
    if (cfg.tenant === false || !route.url.startsWith('/api/')) return;
    const original = route.handler as RouteHandlerMethod;
    route.handler = async function (this: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
      const labId = req.auth?.labId ?? req.agent?.labId;
      if (!labId) return original.call(this, req, reply);
      let held: { payload: unknown } | null = null;
      const own = reply as unknown as Record<string, unknown>;
      own.send = (payload?: unknown) => {
        held = { payload };
        return reply;
      };
      // A reply is thenable (it resolves once the response has gone out). Returned from the
      // handler while the send is held back, it would wait for itself, so hide that meanwhile.
      own.then = undefined;
      let result: unknown;
      try {
        result = await withLab(
          labId,
          {
            userId: req.auth?.userId ?? null,
            actorName: req.auth ? req.auth.user.fullNameEn : req.agent ? `agent:${req.agent.name}` : null,
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          },
          () => original.call(this, req, reply) as Promise<unknown>,
        );
      } finally {
        delete own.send;
        delete own.then;
      }
      const sent = held as { payload: unknown } | null;
      return sent ? reply.send(sent.payload) : result;
    } as RouteHandlerMethod;
  });

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.auth = await authenticateToken(token);
  });

  app.addHook('preHandler', async (req) => {
    const cfg = req.routeOptions.config ?? {};
    // The web app's files and client routes are public; the API decides what each user may see.
    if (cfg.public || !req.url.startsWith('/api/')) return;
    if (cfg.agent) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      req.agent = token ? await authenticateAgent(token) : null;
      if (!req.agent) throw unauthorized('agent_unauthorized');
      return;
    }
    if (!req.auth) throw unauthorized();
    if (UNSAFE.has(req.method) && !cfg.skipCsrf) {
      const sent = String(req.headers['x-csrf-token'] ?? '');
      if (!sent || !safeEqual(sent, csrfFor(req.auth.sessionId))) throw forbidden('csrf');
    }
    if (cfg.perm) {
      const needed = Array.isArray(cfg.perm) ? cfg.perm : [cfg.perm];
      if (!needed.some((p) => req.auth!.permissions.has(p))) throw forbidden('permission', `Needs ${needed.join(' or ')}`);
    }
  });

  app.setErrorHandler(errorHandler);

  app.get('/health/live', { config: { public: true, tenant: false } }, async () => ({ ok: true }));
  app.get('/health/ready', { config: { public: true, tenant: false } }, async (_req, reply) => {
    try {
      await appDb.execute(sql`select 1`);
      return { ok: true, database: 'up' };
    } catch {
      return reply.status(503).send({ ok: false, database: 'down' });
    }
  });

  await app.register(
    async (api) => {
      for (const m of modules) await api.register(m.plugin, { prefix: m.prefix });
    },
    { prefix: '/api/v1' },
  );

  // Production: serve the built web app and fall back to index.html for client routes.
  if (existsSync(join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: false });
    const indexHtml = await readFile(join(config.webDist, 'index.html'), 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return reply.status(404).type('application/problem+json').send({ title: 'Not found', status: 404, code: 'not_found' });
      }
      return reply.type('text/html').send(indexHtml);
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.status(404).type('application/problem+json').send({ title: 'Not found', status: 404, code: 'not_found' }),
    );
  }

  return app;
}

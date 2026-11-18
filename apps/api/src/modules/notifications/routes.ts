import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { notifications } from '@natija/db';
import { db } from '../../db';
import { subscribe } from '../../lib/events';
import { parse } from '../../lib/http';

export default async function notificationRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const q = parse(z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    const mine = eq(notifications.userId, req.auth!.userId);
    const where = q.unread ? and(mine, isNull(notifications.readAt)) : mine;
    const items = await db().select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(q.limit);
    const [unread] = await db()
      .select({ n: count() })
      .from(notifications)
      .where(and(mine, isNull(notifications.readAt)));
    return { items, unread: unread?.n ?? 0 };
  });

  app.post('/:id/read', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await db()
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, req.auth!.userId)));
    return { ok: true };
  });

  app.post('/read-all', async (req) => {
    await db()
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, req.auth!.userId), isNull(notifications.readAt)));
    return { ok: true };
  });

  /** Live events for the signed-in user's lab (server-sent events). */
  app.get('/stream', { config: { tenant: false } }, async (req, reply) => {
    const { labId, userId } = req.auth!;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const unsubscribe = subscribe(labId, (event) => {
      if (event.userIds && !event.userIds.includes(userId)) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}

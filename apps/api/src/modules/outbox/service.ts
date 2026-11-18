import { and, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { orders, outboxMessages } from '@natija/db';
import type { OutboxList } from '@natija/contracts';
import { db } from '../../db';
import { conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange } from '../../lib/http';
import { record, inSequence } from '../audit/kit';

/**
 * Outgoing SMS / email / WhatsApp messages. No provider is connected yet, so the outbox worker
 * marks every message "simulated" (see services/outbox.ts); WhatsApp is sent from the desk.
 */
export async function listOutbox(f: {
  from?: string;
  to?: string;
  channel?: 'sms' | 'email' | 'whatsapp';
  status?: 'pending' | 'simulated' | 'sent' | 'failed';
  q?: string;
  limit: number;
  offset: number;
}): Promise<OutboxList> {
  const where: SQL[] = [];
  if (f.from || f.to) {
    const { start, end } = await dayRange(f.from, f.to);
    where.push(gte(outboxMessages.createdAt, start), lt(outboxMessages.createdAt, end));
  }
  if (f.channel) where.push(eq(outboxMessages.channel, f.channel));
  const base = where.length ? and(...where) : undefined;
  if (f.status) where.push(eq(outboxMessages.status, f.status));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, '')}%`;
    where.push(or(ilike(outboxMessages.toAddress, like), ilike(outboxMessages.body, like), ilike(outboxMessages.subject, like), ilike(orders.accession, like))!);
  }
  const cond = where.length ? and(...where) : undefined;
  const [rows, [total], byStatus, providers] = await inSequence([
    () => db()
      .select({ m: outboxMessages, accession: orders.accession })
      .from(outboxMessages)
      .leftJoin(orders, eq(orders.id, outboxMessages.orderId))
      .where(cond)
      .orderBy(desc(outboxMessages.createdAt))
      .limit(f.limit)
      .offset(f.offset),
    () => db().select({ n: count() }).from(outboxMessages).leftJoin(orders, eq(orders.id, outboxMessages.orderId)).where(cond),
    () => db().select({ status: outboxMessages.status, n: count() }).from(outboxMessages).where(base).groupBy(outboxMessages.status),
    () => db()
      .selectDistinct({ provider: outboxMessages.provider })
      .from(outboxMessages)
      .where(sql`${outboxMessages.provider} is not null`),
  ]);
  const counts: Record<string, number> = { pending: 0, simulated: 0, sent: 0, failed: 0 };
  for (const s of byStatus) counts[s.status] = s.n;
  const real = providers.map((p) => p.provider).filter((p) => p && p !== 'demo-outbox' && p !== 'not-configured');
  return {
    items: rows.map(({ m, accession }) => ({
      id: m.id,
      channel: m.channel,
      toAddress: m.toAddress,
      subject: m.subject,
      body: m.body,
      status: m.status,
      attempts: m.attempts,
      lastError: m.lastError,
      provider: m.provider,
      orderId: m.orderId,
      accession: accession ?? null,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    })),
    total: total?.n ?? 0,
    counts,
    providerConfigured: real.length > 0,
  };
}

/** Put a failed message back in the queue. */
export async function retryMessage(id: string) {
  const [m] = await db().select().from(outboxMessages).where(eq(outboxMessages.id, id));
  if (!m) throw notFound();
  if (m.status !== 'failed') throw conflict('not_failed', 'Only failed messages can be retried');
  await db().update(outboxMessages).set({ status: 'pending', attempts: 0, lastError: null }).where(eq(outboxMessages.id, id));
  await record({ action: 'outbox.retry', entityType: 'outbox_message', entityId: id, summary: `${m.channel} → ${m.toAddress}`, before: { status: m.status }, after: { status: 'pending' } });
  publish({ type: 'outbox.changed' });
  return { ok: true };
}

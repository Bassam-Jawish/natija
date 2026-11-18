import { and, asc, eq, sql } from 'drizzle-orm';
import { labs, outboxMessages } from '@natija/db';
import { config } from '../config';
import { appDb, db, ctx, withLab } from '../db';
import { publish } from '../lib/events';

export type OutboxInput = {
  channel: 'sms' | 'email' | 'whatsapp';
  toAddress: string;
  subject?: string | null;
  body: string;
  orderId?: string | null;
};

/** Queue an outgoing SMS or email in the current transaction. */
export async function queueMessage(input: OutboxInput): Promise<string> {
  const [row] = await db()
    .insert(outboxMessages)
    .values({ labId: ctx().labId, channel: input.channel, toAddress: input.toAddress, subject: input.subject ?? null, body: input.body, orderId: input.orderId ?? null })
    .returning({ id: outboxMessages.id });
  return row!.id;
}

/**
 * Provider adapters. None is configured in the demo, so messages are marked "simulated"
 * and stay visible in the outbox screen. Add a real SMS or email adapter here once a
 * provider contract exists (see docs/integrations.md).
 */
async function deliver(message: typeof outboxMessages.$inferSelect): Promise<{ status: 'sent' | 'simulated'; provider: string }> {
  void message;
  return { status: 'simulated', provider: config.demoMode ? 'demo-outbox' : 'not-configured' };
}

async function processLab(labId: string): Promise<void> {
  await withLab(labId, {}, async () => {
    const pending = await db()
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.status, 'pending'))
      .orderBy(asc(outboxMessages.createdAt))
      .limit(20)
      .for('update', { skipLocked: true });
    for (const m of pending) {
      try {
        const res = await deliver(m);
        await db()
          .update(outboxMessages)
          .set({ status: res.status, provider: res.provider, sentAt: new Date(), attempts: sql`${outboxMessages.attempts} + 1` })
          .where(eq(outboxMessages.id, m.id));
      } catch (err) {
        await db()
          .update(outboxMessages)
          .set({
            attempts: sql`${outboxMessages.attempts} + 1`,
            lastError: String(err),
            status: m.attempts + 1 >= 5 ? 'failed' : 'pending',
          })
          .where(and(eq(outboxMessages.id, m.id)));
      }
    }
    if (pending.length) publish({ type: 'outbox.changed' });
  });
}

let timer: NodeJS.Timeout | null = null;

/** Background loop: every 5 seconds, deliver pending messages for every active lab. */
export function startOutboxWorker(): void {
  if (timer) return;
  const tick = async () => {
    try {
      const rows = await appDb.select({ id: labs.id }).from(labs).where(eq(labs.status, 'active'));
      for (const lab of rows) await processLab(lab.id);
    } catch (err) {
      console.error('outbox worker', err);
    }
  };
  timer = setInterval(tick, 5_000);
  timer.unref();
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

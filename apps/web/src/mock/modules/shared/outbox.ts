/**
 * Outgoing SMS and e-mail (port of apps/api/src/services/outbox.ts). No provider exists in mock
 * mode, so a message is marked "simulated" a moment after it is queued, as the demo server does.
 */
import { insert, update } from '../../core/db';
import { now } from '../../core/context';
import { publish } from '../../core/lib';

export type OutboxInput = {
  channel: 'sms' | 'email' | 'whatsapp';
  toAddress: string;
  subject?: string | null;
  body: string;
  orderId?: string | null;
};

export function queueMessage(input: OutboxInput): string {
  const row = insert('outboxMessages', {
    channel: input.channel,
    toAddress: input.toAddress,
    subject: input.subject ?? null,
    body: input.body,
    orderId: input.orderId ?? null,
  });
  update('outboxMessages', row, { status: 'simulated', provider: 'demo-outbox', attempts: 1, sentAt: new Date(now().getTime() + 60_000) });
  publish({ type: 'outbox.changed' });
  return row.id;
}

/**
 * Outgoing SMS / email / WhatsApp messages (port of apps/api/src/modules/outbox). Messages are
 * queued by queueMessage() in ../shared/outbox.ts and marked "simulated" at once, as the demo
 * server's outbox worker does; a retried message goes back to the queue and is simulated again.
 */
import { adminOutboxQuery, type OutboxList } from '@natija/contracts';
import { conflict, notFound, now } from '../../core/context';
import { find, rows, update } from '../../core/db';
import { dayRange, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { contains, likeTerm, record } from './kit';

export function listOutbox(f: {
  from?: string;
  to?: string;
  channel?: 'sms' | 'email' | 'whatsapp';
  status?: 'pending' | 'simulated' | 'sent' | 'failed';
  q?: string;
  limit: number;
  offset: number;
}): OutboxList {
  const range = f.from || f.to ? dayRange(f.from, f.to) : null;
  const all = rows('outboxMessages');
  const base = all.filter((m) => {
    if (range && (m.createdAt < range.start || m.createdAt >= range.end)) return false;
    if (f.channel && m.channel !== f.channel) return false;
    return true;
  });
  const accession = (orderId: string | null) => (orderId ? (find('orders', orderId)?.accession ?? null) : null);
  const term = f.q ? likeTerm(f.q) : '';
  const matching = base.filter((m) => {
    if (f.status && m.status !== f.status) return false;
    if (f.q && !(contains(m.toAddress, term) || contains(m.body, term) || contains(m.subject, term) || contains(accession(m.orderId), term))) return false;
    return true;
  });
  const counts: Record<string, number> = { pending: 0, simulated: 0, sent: 0, failed: 0 };
  for (const m of base) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const real = new Set(all.map((m) => m.provider).filter((p) => p && p !== 'demo-outbox' && p !== 'not-configured'));
  const offset = f.offset ?? 0;
  const limit = f.limit ?? 50;
  return {
    items: [...matching]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((m) => ({
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
        accession: accession(m.orderId),
        createdAt: m.createdAt.toISOString(),
        sentAt: m.sentAt ? m.sentAt.toISOString() : null,
      })),
    total: matching.length,
    counts,
    providerConfigured: real.size > 0,
  };
}

/** Put a failed message back in the queue; with no provider in mock mode it is simulated straight away. */
export function retryMessage(id: string) {
  const m = find('outboxMessages', id);
  if (!m) throw notFound();
  if (m.status !== 'failed') throw conflict('not_failed', 'Only failed messages can be retried');
  update('outboxMessages', m, { status: 'pending', attempts: 0, lastError: null });
  record({ action: 'outbox.retry', entityType: 'outbox_message', entityId: id, summary: `${m.channel} → ${m.toAddress}`, before: { status: 'failed' }, after: { status: 'pending' } });
  update('outboxMessages', m, { status: 'simulated', provider: 'demo-outbox', attempts: 1, sentAt: now() });
  publish({ type: 'outbox.changed' });
  return { ok: true };
}

export function registerOutbox(): void {
  route('GET', '/outbox', { perm: ['settings.manage', 'reports.deliver'] }, (req) => listOutbox(parse(adminOutboxQuery, req.query)));
  route('POST', '/outbox/:id/retry', { perm: 'settings.manage' }, (req) => retryMessage(req.params.id));
}

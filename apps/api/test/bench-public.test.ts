import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { deliveries, orders, outboxMessages, reportTokens } from '@natija/db';
import { db } from '../src/db';
import { sha256 } from '../src/lib/crypto';
import { anon, login, type Client } from './helpers';
import { createTestOrder, inLab, type OrderFixture } from './bench-fixtures';

/** An order with one released glucose result. */
async function releasedOrder(tech: Client, doctor: Client, opts: { portalCode?: string } = {}): Promise<OrderFixture & { verifyCode: string }> {
  const fx = await createTestOrder('yasmin', { tests: ['GLU'], portalCode: opts.portalCode ?? '271828' });
  expect((await tech.put(`/results/${fx.results.GLU}`, { value: '92' })).statusCode).toBe(200);
  expect((await tech.post('/results/verify', { resultIds: [fx.results.GLU] })).json().done).toHaveLength(1);
  expect((await doctor.post('/results/validate', { resultIds: [fx.results.GLU], password: 'Natija@2026' })).statusCode).toBe(200);
  const released = await doctor.post(`/reports/orders/${fx.orderId}/release`, { resultIds: [fx.results.GLU] });
  expect(released.statusCode).toBe(200);
  return { ...fx, verifyCode: released.json().verifyCode };
}

const tokenOf = (url: string) => url.slice(url.indexOf('/r/') + 3);

describe('patient portal, report links and delivery', () => {
  let reception: Client;
  let tech: Client;
  let doctor: Client;

  beforeAll(async () => {
    [reception, tech, doctor] = await Promise.all([login('yasmin', 'reception'), login('yasmin', 'tech'), login('yasmin', 'doctor')]);
  });

  it('opens a report with the link and the receipt code, and logs the opening', async () => {
    const fx = await releasedOrder(tech, doctor);
    const link = await reception.post(`/reports/orders/${fx.orderId}/link`);
    expect(link.statusCode).toBe(200);
    expect(link.json().url).toContain('/r/');
    const token = tokenOf(link.json().url);
    const stored = await inLab(fx.labId, () => db().select().from(reportTokens).where(eq(reportTokens.orderId, fx.orderId)));
    expect(stored[0]!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    const info = await anon('POST', '/public/report/info', { token });
    expect(info.statusCode).toBe(200);
    expect(info.json().lab.code).toBe('yasmin');

    const wrong = await anon('POST', '/public/report/open', { token, code: '000001' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().code).toBe('wrong_code');

    const ok = await anon('POST', '/public/report/open', { token, code: fx.portalCode });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().verifyCode).toBe(fx.verifyCode);
    expect(ok.json().snapshot.sections[0].tests[0].rows[0]).toMatchObject({ code: 'GLU', value: '92', flag: 'N' });

    const opened = await inLab(fx.labId, () => db().select().from(deliveries).where(eq(deliveries.orderId, fx.orderId)));
    expect(opened.some((d) => d.channel === 'portal' && d.status === 'opened')).toBe(true);
    const [order] = await inLab(fx.labId, () => db().select().from(orders).where(eq(orders.id, fx.orderId)));
    expect(order!.status).toBe('delivered');
  });

  it('locks a link after five wrong codes', async () => {
    const fx = await releasedOrder(tech, doctor);
    const token = tokenOf((await reception.post(`/reports/orders/${fx.orderId}/link`)).json().url);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await anon('POST', '/public/report/open', { token, code: `10000${i}` })).statusCode);
    expect(codes).toEqual([403, 403, 403, 403, 423]);
    expect((await anon('POST', '/public/report/open', { token, code: fx.portalCode })).statusCode).toBe(423);
  });

  it('refuses expired links with 410 and unknown links with 404', async () => {
    const fx = await releasedOrder(tech, doctor);
    const token = tokenOf((await reception.post(`/reports/orders/${fx.orderId}/link`)).json().url);
    await inLab(fx.labId, () => db().update(reportTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(reportTokens.tokenHash, sha256(token))));
    const expired = await anon('POST', '/public/report/open', { token, code: fx.portalCode });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().code).toBe('link_expired');
    const unknown = await anon('POST', '/public/report/open', { token: 'x'.repeat(43), code: fx.portalCode });
    expect(unknown.statusCode).toBe(404);
  });

  it('looks a report up from the receipt QR, refusing wrong codes and locking after five', async () => {
    const fx = await releasedOrder(tech, doctor, { portalCode: '314159' });
    const lab = await anon('GET', '/public/labs/yasmin');
    expect(lab.json().nameEn).toContain('Yasmin');

    const unknownOrder = await anon('POST', '/public/report/lookup', { labCode: 'yasmin', accession: 'NO-SUCH-ORDER', code: '314159' });
    expect(unknownOrder.statusCode).toBe(403);
    expect(unknownOrder.json().code).toBe('lookup_failed');

    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await anon('POST', '/public/report/lookup', { labCode: 'yasmin', accession: fx.accession, code: '99999' + i })).statusCode);
    expect(statuses).toEqual([403, 403, 403, 403, 423]);
    const locked = await anon('POST', '/public/report/lookup', { labCode: 'yasmin', accession: fx.accession, code: '314159' });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().code).toBe('link_locked');

    const other = await releasedOrder(tech, doctor, { portalCode: '161803' });
    const ok = await anon('POST', '/public/report/lookup', { labCode: 'yasmin', accession: other.accession, code: '161803' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().snapshot.order.accession).toBe(other.accession);
  });

  it('verifies a printed report without revealing results or the name', async () => {
    const fx = await releasedOrder(tech, doctor);
    const res = await anon('GET', `/public/verify/${fx.verifyCode.toLowerCase()}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'genuine', accession: fx.accession, version: 1, latestVersion: 1, testCount: 1 });
    expect(Object.keys(body).sort()).toEqual(['accession', 'contentHash', 'lab', 'latestVersion', 'patientInitials', 'releasedAt', 'status', 'testCount', 'version']);
    expect(JSON.stringify(body)).not.toMatch(/snapshot|sections|GLU|سامر|Samer/);
    expect((await anon('GET', '/public/verify/ZZZZZZZZZZ')).json()).toEqual({ status: 'not_found' });
    expect((await anon('GET', '/public/verify/not-a-code')).json()).toEqual({ status: 'not_found' });
  });

  it('delivers by WhatsApp link, simulated SMS and print, and lists the order for the desk', async () => {
    const fx = await releasedOrder(tech, doctor);
    const wa = await reception.post(`/reports/orders/${fx.orderId}/deliver`, { channel: 'whatsapp' });
    expect(wa.statusCode).toBe(200);
    expect(wa.json().url).toMatch(/^https:\/\/wa\.me\/963944123456\?text=/);
    expect(decodeURIComponent(wa.json().url)).toContain('/r/');
    expect(wa.json().orderDelivered).toBe(true);

    const sms = await reception.post(`/reports/orders/${fx.orderId}/deliver`, { channel: 'sms' });
    expect(sms.json().delivery).toMatchObject({ channel: 'sms', status: 'simulated', toAddress: '+963944123456' });
    const queued = await inLab(fx.labId, () => db().select().from(outboxMessages).where(eq(outboxMessages.orderId, fx.orderId)));
    expect(queued.some((m) => m.channel === 'sms')).toBe(true);

    expect((await tech.post(`/reports/orders/${fx.orderId}/deliver`, { channel: 'print' })).statusCode).toBe(200);
    expect((await tech.post(`/reports/orders/${fx.orderId}/deliver`, { channel: 'sms' })).statusCode).toBe(403);
    expect((await reception.post(`/reports/orders/${fx.orderId}/deliver`, { channel: 'email' })).json().code).toBe('no_email');

    const list = await reception.get('/reports/deliveries', { status: 'delivered' });
    const row = list.json().items.find((r: { order: { id: string } }) => r.order.id === fx.orderId);
    expect(row.lastByChannel.whatsapp).toBeTruthy();
    expect(row.lastByChannel.sms.status).toBe('simulated');
    expect(row.report.verifyCode).toBe(fx.verifyCode);
  });
});

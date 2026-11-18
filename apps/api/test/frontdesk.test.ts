/**
 * Front desk: patients, orders and desk billing, end to end through the HTTP API.
 * Every test makes its own patients and orders, so it does not depend on what other tests left.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@natija/db';
import type { OrderCreated, OrderDetail, OrderFormData, OrderQuote, PatientDetail } from '@natija/contracts';
import { getApp, login, type Client } from './helpers';

const owner = createPool(process.env.DATABASE_URL!, 2);
afterAll(async () => {
  await owner.end();
});

let reception: Client;
let manager: Client;
let form: OrderFormData;

beforeAll(async () => {
  reception = await login('yasmin', 'reception');
  manager = await login('yasmin', 'manager');
  const res = await reception.get('/orders/form-data');
  expect(res.statusCode).toBe(200);
  form = res.json();
});

const testOf = (code: string) => form.tests.find((t) => t.code === code)!;
const pkgOf = (code: string) => form.packages.find((p) => p.code === code)!;
const payerOf = (code: string) => form.payerGroups.find((p) => p.code === code)!;
const methodId = (code: string) => form.paymentMethods.find((m) => m.code === code)!.id;

const LETTERS = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
function uniqueName(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return s;
}
const labYear = () => Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(new Date()).slice(0, 4));

async function newPatient(c: Client, over: Record<string, unknown> = {}): Promise<PatientDetail> {
  const res = await c.post('/patients', {
    firstNameAr: 'سامر',
    fatherNameAr: 'نزار',
    lastNameAr: uniqueName(),
    sex: 'male',
    birthDate: '1990-06-15',
    phone: '0944 000 111',
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function newOrder(c: Client, body: Record<string, unknown>): Promise<OrderCreated> {
  const res = await c.post('/orders', { payerGroupId: payerOf('PUBLIC').id, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function detail(c: Client, id: string): Promise<OrderDetail> {
  const res = await c.get(`/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const key = () => `test-${crypto.randomUUID()}`;

describe('patients', () => {
  it('creates a patient from an age with an estimated birth date', async () => {
    const last = uniqueName();
    const p = await newPatient(reception, { firstNameAr: 'ليان', fatherNameAr: 'محمود', lastNameAr: last, sex: 'female', birthDate: undefined, age: { value: 30, unit: 'years' } });
    expect(p.birthDateEstimated).toBe(true);
    expect(p.birthDate.slice(0, 4)).toBe(String(labYear() - 30));
    expect(p.mrn).toMatch(/^P-\d{6}$/);
    expect(p.fullNameAr).toBe(`ليان محمود ${last}`);
    expect(p.contactPref).toBe('whatsapp');

    const baby = await newPatient(reception, { birthDate: undefined, age: { value: 8, unit: 'months' } });
    expect(baby.birthDateEstimated).toBe(true);
    const months = (Date.now() - new Date(`${baby.birthDate}T00:00:00Z`).getTime()) / (30.44 * 86_400_000);
    expect(months).toBeGreaterThan(7);
    expect(months).toBeLessThan(9);
  });

  it('needs a birth date or an age, and refuses a birth date in the future', async () => {
    const none = await reception.post('/patients', { firstNameAr: 'ريم', lastNameAr: uniqueName(), sex: 'female' });
    expect(none.statusCode).toBe(400);
    const future = await reception.post('/patients', { firstNameAr: 'ريم', lastNameAr: uniqueName(), sex: 'female', birthDate: `${labYear() + 1}-01-01` });
    expect(future.statusCode).toBe(400);
  });

  it('finds a likely duplicate despite spelling differences, and searches names and phones', async () => {
    const last = uniqueName();
    const p = await newPatient(reception, { firstNameAr: 'أحمد', fatherNameAr: 'خالد', lastNameAr: last, birthDate: '1985-03-02', phone: '+963 933 444 555' });
    const res = await reception.post('/patients/duplicates', { firstNameAr: 'احمد', fatherNameAr: 'خالد', lastNameAr: last, sex: 'male', birthDate: '1985-03-02' });
    expect(res.statusCode).toBe(200);
    const match = res.json().items.find((c: { id: string }) => c.id === p.id);
    expect(match).toBeTruthy();
    expect(match.score).toBeGreaterThanOrEqual(60);
    expect(match.reasons).toEqual(expect.arrayContaining(['name', 'birth']));

    const excluded = await reception.post('/patients/duplicates', { firstNameAr: 'احمد', lastNameAr: last, sex: 'male', birthDate: '1985-03-02', excludeId: p.id });
    expect(excluded.json().items.some((c: { id: string }) => c.id === p.id)).toBe(false);

    const byName = await reception.get('/patients', { q: `احمد ${last}` });
    expect(byName.json().items.map((x: { id: string }) => x.id)).toContain(p.id);
    const byPhone = await reception.get('/patients', { q: '0933 444 555' });
    expect(byPhone.json().items.map((x: { id: string }) => x.id)).toContain(p.id);
  });

  it('merges duplicate records, and refuses different sexes unless forced', async () => {
    const man = await newPatient(reception);
    const woman = await newPatient(reception, { sex: 'female' });
    expect((await reception.post('/patients/merge', { sourceId: man.id, targetId: woman.id, reason: 'same person' })).statusCode).toBe(403);
    const refused = await manager.post('/patients/merge', { sourceId: man.id, targetId: woman.id, reason: 'same person' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('merge_mismatch');

    const last = uniqueName();
    const a = await newPatient(reception, { lastNameAr: last, phone: null });
    const b = await newPatient(reception, { lastNameAr: last, nationalId: '01020304050' });
    const order = await newOrder(reception, { patientId: a.id, items: [{ testId: testOf('GLU').id }] });
    const merged = await manager.post('/patients/merge', { sourceId: a.id, targetId: b.id, reason: 'registered twice' });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json().movedOrders).toBe(1);
    const gone = (await manager.get(`/patients/${a.id}`)).json();
    expect(gone.mergedInto.id).toBe(b.id);
    expect((await detail(manager, order.id)).patient.id).toBe(b.id);
    const history = await manager.get(`/patients/${b.id}/history`);
    expect(history.json().orders.map((o: { id: string }) => o.id)).toContain(order.id);
    const kept = (await manager.get(`/patients/${b.id}`)).json();
    expect(kept).toMatchObject({ orderCount: 1, nationalId: '01020304050', phone: '0944 000 111' });
    expect(kept.lastVisitAt).toBeTruthy();
    const listed = (await manager.get('/patients', { q: b.mrn })).json().items[0];
    expect(listed).toMatchObject({ id: b.id, orderCount: 1 });
    expect(listed.lastVisitAt).toBeTruthy();
  });

  it('stores image and PDF attachments only, and streams them back', async () => {
    const p = await newPatient(reception);
    const app = await getApp();
    const signIn = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { labCode: 'yasmin', username: 'reception', password: 'Natija@2026' } });
    const sid = signIn.cookies.find((c) => c.name === 'natija_sid')!.value;
    const csrf = signIn.json().csrfToken as string;
    const upload = (name: string, mime: string, content: Buffer) => {
      const boundary = `----natija${Math.random().toString(16).slice(2)}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nreferral\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({
        method: 'POST',
        url: `/api/v1/patients/${p.id}/attachments`,
        payload: body,
        cookies: { natija_sid: sid },
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-csrf-token': csrf },
      });
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
    const ok = await upload('referral.png', 'image/png', png);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ kind: 'referral', mime: 'image/png', size: png.length });
    const refused = await upload('notes.txt', 'text/plain', Buffer.from('hello'));
    expect(refused.statusCode).toBe(415);

    const file = await reception.get(`/patients/${p.id}/attachments/${ok.json().id}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.equals(png)).toBe(true);
    const other = await login('orontes', 'manager');
    expect((await other.get(`/patients/${p.id}/attachments/${ok.json().id}`)).statusCode).toBe(404);
  });
});

describe('orders', () => {
  it('prices a package in units for an insurer plan, splits the shares and groups tubes by container', async () => {
    const p = await newPatient(reception);
    const gold = payerOf('WAHA_GOLD');
    const checkup = pkgOf('CHECKUP');
    const items = [{ packageId: checkup.id }];
    const quote: OrderQuote = (await reception.post('/orders/quote', { payerGroupId: gold.id, items })).json();
    const price = checkup.units! * gold.unitPrice;
    expect(quote.totals.subtotal).toBe(price);
    expect(quote.totals.patientTotal).toBe(Math.round((price * gold.patientSharePct) / 100));
    expect(quote.totals.insurerTotal).toBe(price - quote.totals.patientTotal);
    expect(quote.lines).toHaveLength(checkup.testIds.length);
    expect(quote.lines.every((l) => l.packageCode === 'CHECKUP')).toBe(true);
    expect(quote.lines.reduce((a, l) => a + l.price, 0)).toBe(price);
    const containers = new Set(checkup.testIds.map((id) => form.tests.find((t) => t.id === id)!.containerCode));
    expect(quote.tubes).toHaveLength(containers.size);
    expect(new Set(quote.tubes.map((t) => t.containerCode))).toEqual(containers);

    const created = await newOrder(reception, { patientId: p.id, payerGroupId: gold.id, items });
    expect(created.accession).toMatch(/^\d{6}-\d{4}$/);
    expect(created.portalCode).toMatch(/^\d{6}$/);
    expect(created.tubes).toBe(containers.size);
    const order = await detail(reception, created.id);
    expect(order.invoice!.patientTotal).toBe(quote.totals.patientTotal);
    expect(order.invoice!.insurerTotal).toBe(quote.totals.insurerTotal);
    expect(order.tubes.map((t) => t.containerCode).sort()).toEqual([...containers].sort());
    expect(order.tubes.every((t) => t.status === 'pending' && t.barcode.startsWith(order.accession))).toBe(true);
    expect(order.items.every((i) => i.sampleId && i.status === 'ordered')).toBe(true);
    const analyteCount = checkup.testIds.reduce((a, id) => a + form.tests.find((t) => t.id === id)!.analyteCodes.length, 0);
    expect(order.resultCounts.total).toBe(analyteCount);
    expect(order.resultCounts.pending).toBe(analyteCount);
  });

  it('creates exactly the invoice the quote showed, billing a duplicated test once through its package', async () => {
    const p = await newPatient(reception);
    const union = payerOf('UNION');
    const items = [{ testId: testOf('CBC').id }, { testId: testOf('GLU').id }, { packageId: pkgOf('DIABETES').id }, { packageId: pkgOf('KIDNEY').id }];
    const quote: OrderQuote = (await reception.post('/orders/quote', { payerGroupId: union.id, items })).json();
    expect(quote.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'duplicate_test', code: 'GLU' }), expect.objectContaining({ kind: 'duplicate_test', code: 'CREA' })]));
    expect(quote.lines.filter((l) => l.code === 'GLU')).toHaveLength(1);
    expect(quote.lines.find((l) => l.code === 'GLU')!.packageCode).toBe('DIABETES');
    expect(quote.totals.discountTotal).toBeGreaterThan(0);

    const created = await newOrder(reception, { patientId: p.id, payerGroupId: union.id, items });
    const inv = (await detail(reception, created.id)).invoice!;
    expect({ subtotal: inv.subtotal, discountTotal: inv.discountTotal, insurerTotal: inv.insurerTotal, patientTotal: inv.patientTotal }).toEqual({
      subtotal: quote.totals.subtotal,
      discountTotal: quote.totals.discountTotal,
      insurerTotal: quote.totals.insurerTotal,
      patientTotal: quote.totals.patientTotal,
    });
    const lines = new Map(inv.lines.map((l) => [l.testId, l]));
    for (const q of quote.lines) {
      expect(lines.get(q.testId)).toMatchObject({ price: q.price, discount: q.discount, patientShare: q.patientShare, insurerShare: q.insurerShare });
    }
  });

  it('takes payments idempotently and never more than the balance', async () => {
    const p = await newPatient(reception);
    const k = key();
    const body = { patientId: p.id, items: [{ testId: testOf('CBC').id }, { testId: testOf('CRP').id }], payment: { amount: 500, methodId: methodId('CARD'), idempotencyKey: k } };
    const created = await newOrder(reception, body);
    expect(created.invoice.paidTotal).toBe(500);
    expect(created.payment?.amount).toBe(500);

    const again = await reception.post('/orders', { payerGroupId: payerOf('PUBLIC').id, ...body });
    expect(again.json().id).toBe(created.id);

    const repeat = await reception.post('/billing/payments', { invoiceId: created.invoice.id, amount: 500, methodId: methodId('CARD'), idempotencyKey: k });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().duplicate).toBe(true);
    expect(repeat.json().payment.id).toBe(created.payment!.id);
    expect(repeat.json().invoice.paidTotal).toBe(500);

    const balance = created.invoice.patientTotal - 500;
    const tooMuch = await reception.post('/billing/payments', { invoiceId: created.invoice.id, amount: balance + 1, methodId: methodId('CARD'), idempotencyKey: key() });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().code).toBe('amount_exceeds_balance');
    const rest = await reception.post('/billing/payments', { invoiceId: created.invoice.id, amount: balance, methodId: methodId('WALLET'), idempotencyKey: key() });
    expect(rest.statusCode).toBe(201);
    expect(rest.json().invoice).toMatchObject({ status: 'paid', balance: 0 });
  });

  it('refuses cash without an open cash session, before creating anything', async () => {
    const { lab, user } = reception.me;
    await owner.query(`update cash_sessions set status = 'closed', closed_at = now() where lab_id = $1 and opened_by = $2 and status = 'open'`, [lab.id, user.id]);
    const p = await newPatient(reception);
    const cash = { amount: 100, methodId: methodId('CASH'), idempotencyKey: key() };
    const refused = await reception.post('/orders', { payerGroupId: payerOf('PUBLIC').id, patientId: p.id, items: [{ testId: testOf('GLU').id }], payment: cash });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('no_cash_session');
    expect((await reception.get('/orders', { patientId: p.id })).json().total).toBe(0);

    const order = await newOrder(reception, { patientId: p.id, items: [{ testId: testOf('GLU').id }] });
    const noSession = await reception.post('/billing/payments', { invoiceId: order.invoice.id, ...cash });
    expect(noSession.statusCode).toBe(409);
    expect(noSession.json().code).toBe('no_cash_session');

    const { rows } = await owner.query(`insert into cash_sessions (lab_id, opened_by, opening_float, status) values ($1, $2, 0, 'open') returning id`, [lab.id, user.id]);
    try {
      expect((await reception.get('/orders/form-data')).json().cashSession?.id).toBe(rows[0].id);
      const paid = await reception.post('/billing/payments', { invoiceId: order.invoice.id, ...cash });
      expect(paid.statusCode, paid.body).toBe(201);
      const stored = await owner.query(`select cash_session_id from payments where id = $1`, [paid.json().payment.id]);
      expect(stored.rows[0].cash_session_id).toBe(rows[0].id);
    } finally {
      await owner.query(`update cash_sessions set status = 'closed', closed_at = now() where id = $1`, [rows[0].id]);
    }
  });

  it('sends a desk discount for approval unless the user can approve it', async () => {
    const p = await newPatient(reception);
    const items = [{ testId: testOf('TSH').id }, { testId: testOf('VITD').id }];
    const asked = await newOrder(reception, { patientId: p.id, items, discount: { percent: 10, reason: 'Relative of a staff member' } });
    expect(asked.approvalId).toBeTruthy();
    const pending = await detail(reception, asked.id);
    expect(pending.invoice!.discountTotal).toBe(0);
    expect(pending.invoice!.approvals[0]).toMatchObject({ kind: 'discount', status: 'pending', amount: Math.round(pending.invoice!.subtotal * 0.1) });

    const quote: OrderQuote = (await manager.post('/orders/quote', { payerGroupId: payerOf('PUBLIC').id, items, discount: { amount: 100 } })).json();
    expect(quote.discount).toMatchObject({ requested: 100, applied: true });
    const given = await newOrder(manager, { patientId: p.id, items, discount: { amount: 100, reason: 'Loyal patient' } });
    expect(given.approvalId).toBeNull();
    expect(given.invoice.patientTotal).toBe(quote.totals.patientTotal);
    expect(quote.totals.patientTotal).toBe(quote.totals.subtotal - 100);

    const later = await reception.post(`/billing/invoices/${asked.invoice.id}/discount`, { amount: 50, reason: 'Second request' });
    expect(later.json()).toMatchObject({ applied: false, amount: 50 });
    const direct = await manager.post(`/billing/invoices/${asked.invoice.id}/discount`, { amount: 50, reason: 'Approved at the desk' });
    expect(direct.json()).toMatchObject({ applied: true, amount: 50 });
    expect(direct.json().invoice.patientTotal).toBe(pending.invoice!.patientTotal - 50);
  });

  it('edits the header with optimistic locking', async () => {
    const p = await newPatient(reception);
    const created = await newOrder(reception, { patientId: p.id, items: [{ testId: testOf('CBC').id }] });
    const first = await reception.put(`/orders/${created.id}`, { version: 1, priority: 'urgent', doctorId: form.doctors[0]!.id });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ priority: 'urgent', version: 2 });
    const stale = await reception.put(`/orders/${created.id}`, { version: 1, priority: 'stat' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('version_conflict');
  });

  it('adds tests into usable tubes and removes tests only before results exist', async () => {
    const p = await newPatient(reception);
    const created = await newOrder(reception, { patientId: p.id, items: [{ testId: testOf('CBC').id }] });
    const before = await detail(reception, created.id);
    expect(before.tubes).toHaveLength(1);

    const added = await reception.post(`/orders/${created.id}/items`, { items: [{ testId: testOf('HBA1C').id }, { testId: testOf('GLU').id }, { testId: testOf('CBC').id }] });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ added: 2, newTubes: 1 });
    const grown = await detail(reception, created.id);
    expect(grown.tubes).toHaveLength(2);
    expect(grown.items.find((i) => i.code === 'HBA1C')!.sampleId).toBe(grown.items.find((i) => i.code === 'CBC')!.sampleId);
    expect(grown.invoice!.patientTotal).toBeGreaterThan(before.invoice!.patientTotal);

    const glu = grown.items.find((i) => i.code === 'GLU')!;
    const removed = await reception.del(`/orders/${created.id}/items/${glu.id}?reason=${encodeURIComponent('Doctor changed the request')}`);
    expect(removed.statusCode, removed.body).toBe(200);
    const shrunk = await detail(reception, created.id);
    expect(shrunk.tubes).toHaveLength(1);
    expect(shrunk.items.find((i) => i.id === glu.id)!.status).toBe('cancelled');
    expect(shrunk.invoice!.patientTotal).toBe(grown.invoice!.patientTotal - glu.price);

    const hba1c = shrunk.items.find((i) => i.code === 'HBA1C')!;
    await owner.query(`update results set value_num = 5.6, status = 'resulted' where order_item_id = $1`, [hba1c.id]);
    const locked = await reception.del(`/orders/${created.id}/items/${hba1c.id}?reason=${encodeURIComponent('Not needed')}`);
    expect(locked.statusCode).toBe(409);
    expect(locked.json().code).toBe('item_has_results');

    const single = await newOrder(reception, { patientId: p.id, items: [{ testId: testOf('ESR').id }] });
    const only = (await detail(reception, single.id)).items[0]!;
    const last = await reception.del(`/orders/${single.id}/items/${only.id}?reason=${encodeURIComponent('Not needed')}`);
    expect(last.statusCode).toBe(409);
    expect(last.json().code).toBe('last_item');
  });

  it('cancels only without validated results, voiding an unpaid invoice', async () => {
    const p = await newPatient(reception);
    const created = await newOrder(reception, { patientId: p.id, items: [{ testId: testOf('CBC').id }, { testId: testOf('GLU').id }] });
    expect((await reception.post(`/orders/${created.id}/cancel`, { reason: 'Patient left' })).statusCode).toBe(403);
    const ok = await manager.post(`/orders/${created.id}/cancel`, { reason: 'Patient left' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'cancelled', invoiceVoided: true, refundDue: 0 });
    const order = await detail(manager, created.id);
    expect(order.status).toBe('cancelled');
    expect(order.items.every((i) => i.status === 'cancelled')).toBe(true);
    expect(order.tubes.every((t) => t.status === 'disposed')).toBe(true);
    expect(order.invoice!.status).toBe('void');
    expect(order.cancellable).toBe(false);
    const twice = await manager.post(`/orders/${created.id}/cancel`, { reason: 'Again' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe('order_cancelled');

    const validated = await newOrder(reception, { patientId: p.id, items: [{ testId: testOf('GLU').id }] });
    await owner.query(`update results set value_num = 95, status = 'validated' where order_id = $1`, [validated.id]);
    const refused = await manager.post(`/orders/${validated.id}/cancel`, { reason: 'Too late' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('order_has_validated_results');

    const paid = await newOrder(reception, { patientId: p.id, items: [{ testId: testOf('CRP').id }], payment: { amount: 200, methodId: methodId('CARD'), idempotencyKey: key() } });
    const refund = await manager.post(`/orders/${paid.id}/cancel`, { reason: 'Duplicate order' });
    expect(refund.json()).toMatchObject({ invoiceVoided: false, refundDue: 200 });
  });

  it('keeps every lab to its own orders', async () => {
    const p = await newPatient(reception);
    const created = await newOrder(reception, { patientId: p.id, items: [{ testId: testOf('CBC').id }] });
    const other = await login('orontes', 'manager');
    expect((await other.get(`/orders/${created.id}`)).statusCode).toBe(404);
    expect((await other.put(`/orders/${created.id}`, { version: 1, priority: 'stat' })).statusCode).toBe(404);
    expect((await other.post(`/orders/${created.id}/cancel`, { reason: 'Not mine' })).statusCode).toBe(404);
    expect((await other.get(`/orders/${created.id}/labels`)).statusCode).toBe(404);
    expect((await other.get(`/billing/invoices/${created.invoice.id}`)).statusCode).toBe(404);
    expect((await other.get(`/patients/${p.id}`)).statusCode).toBe(404);
    expect((await other.get('/orders', { q: created.accession })).json().total).toBe(0);
    expect((await detail(reception, created.id)).status).toBe('registered');
  });

  it('lists today’s orders, prints labels and keeps the activity trail', async () => {
    const p = await newPatient(reception);
    const created = await newOrder(reception, { patientId: p.id, priority: 'stat', items: [{ testId: testOf('CBC').id }, { testId: testOf('PT').id }] });
    const today = (await reception.get('/orders')).json();
    expect(today.items.map((o: { id: string }) => o.id)).toContain(created.id);
    const unpaid = (await reception.get('/orders', { unpaid: 'true', priority: 'stat' })).json();
    expect(unpaid.items.map((o: { id: string }) => o.id)).toContain(created.id);
    const found = (await reception.get('/orders', { q: created.accession })).json();
    expect(found.items[0]).toMatchObject({ id: created.id, testCodes: ['CBC', 'PT'], balance: created.invoice.patientTotal });

    const labels = (await reception.get(`/orders/${created.id}/labels`)).json();
    expect(labels.labels).toHaveLength(2);
    expect(labels.labels[0].barcode).toBe(`${created.accession}-01`);
    expect((await reception.post(`/orders/${created.id}/labels/printed`, {})).json().printed).toBe(2);
    const receipt = (await reception.get(`/orders/${created.id}/receipt`)).json();
    expect(receipt.order.portalCode).toBe(created.portalCode);
    expect(receipt.lab.code).toBe('yasmin');

    const activity = (await reception.get(`/orders/${created.id}/activity`)).json().items.map((a: { action: string }) => a.action);
    expect(activity).toEqual(expect.arrayContaining(['order.create', 'order.labels_printed']));
  });
});

/**
 * Lab administration and back office: catalog rules, roles and staff, cash sessions, refunds,
 * discount approvals, the audit hash chain, and access between roles and labs.
 *
 * Most tests run in a throw-away lab seeded here (same catalog, staff and payers as the demo
 * labs) so they never disturb the shared demo labs; it is deleted at the end.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '../../../packages/db/src/index';
import { LABS } from '../../../packages/db/src/seed/labs-data';
import { seedLab } from '../../../packages/db/src/seed/seed-lab';
import { login, type Client } from './helpers';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'Natija@2026';
const LAB = `adm${Date.now().toString(36)}`;

let owner: pg.Client;
let labId: string;
let ownerC: Client;
let accountant: Client;
let reception: Client;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await owner.query(text, params)).rows as T[];
}

/** An order with two tests and its open invoice (2 × 10 000 SYP, general public), inserted directly. */
async function makeInvoice(price = 10_000): Promise<{ invoiceId: string; orderId: string }> {
  const [payer] = await q<{ id: string }>(`select id from payer_groups where lab_id = $1 and code = 'PUBLIC'`, [labId]);
  const testRows = await q<{ id: string; code: string; units: string }>(`select id, code, units from tests where lab_id = $1 order by code limit 2`, [labId]);
  const tag = randomUUID().slice(0, 8);
  const [patient] = await q<{ id: string }>(
    `insert into patients (lab_id, mrn, first_name_ar, last_name_ar, full_name_ar, search_text, sex, birth_date)
     values ($1, $2, 'سامر', 'خليل', 'سامر خليل', 'سامر خليل', 'male', '1990-05-01') returning id`,
    [labId, `T-${tag}`],
  );
  const [order] = await q<{ id: string }>(
    `insert into orders (lab_id, accession, daily_no, patient_id, payer_group_id, portal_code) values ($1, $2, 1, $3, $4, '123456') returning id`,
    [labId, `T${tag}`, patient!.id, payer!.id],
  );
  const total = price * testRows.length;
  const [invoice] = await q<{ id: string }>(
    `insert into invoices (lab_id, order_id, number, payer_group_id, currency, subtotal, patient_total, status)
     values ($1, $2, $3, $4, 'SYP', $5, $5, 'open') returning id`,
    [labId, order!.id, `INV-T-${tag}`, payer!.id, total],
  );
  for (const t of testRows) {
    const [item] = await q<{ id: string }>(
      `insert into order_items (lab_id, order_id, test_id, units, unit_price, price) values ($1, $2, $3, $4, 0, $5) returning id`,
      [labId, order!.id, t.id, t.units, price],
    );
    await q(
      `insert into invoice_lines (lab_id, invoice_id, order_item_id, description, units, price, patient_share) values ($1, $2, $3, $4, $5, $6, $6)`,
      [labId, invoice!.id, item!.id, t.code, t.units, price],
    );
  }
  return { invoiceId: invoice!.id, orderId: order!.id };
}

async function methodId(client: Client, code: string): Promise<string> {
  const methods = (await client.get('/settings/payment-methods')).json() as Array<{ id: string; code: string }>;
  return methods.find((m) => m.code === code)!.id;
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  const pool = createPool(process.env.DATABASE_URL!, 2);
  try {
    const def = { ...LABS[1]!, code: LAB, nameEn: 'Admin test lab', nameAr: 'مخبر اختبار الإدارة' };
    labId = (await seedLab(createDb(pool), def, PASSWORD)).lab.id;
  } finally {
    await pool.end();
  }
  ownerC = await login(LAB, 'owner');
  accountant = await login(LAB, 'accountant');
  reception = await login(LAB, 'reception');
});

afterAll(async () => {
  if (labId) await owner.query('delete from labs where id = $1', [labId]);
  await owner?.end();
});

/* ================================================================== catalog */

describe('reference ranges', () => {
  const analyteId = async (code: string) => (await q<{ id: string }>(`select id from analytes where lab_id = $1 and code = $2`, [labId, code]))[0]!.id;

  it('refuses rows that overlap for the same sex, specimen and instrument', async () => {
    const id = await analyteId('HGB');
    const res = await ownerC.put(`/catalog/analytes/${id}/ranges`, {
      rows: [
        { sex: 'male', ageMinDays: 0, ageMaxDays: 5000, low: 13, high: 17 },
        { sex: 'male', ageMinDays: 4000, low: 12.5, high: 16.5 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('range_overlap');
    expect(res.json().errors['rows.1']).toEqual(['overlap:0']);
    // Nothing was replaced.
    const detail = (await ownerC.get(`/catalog/analytes/${id}`)).json();
    expect(detail.ranges.length).toBe(5);
  });

  it('accepts the same ages for different sexes and reports age gaps as warnings', async () => {
    const id = await analyteId('HGB');
    const res = await ownerC.put(`/catalog/analytes/${id}/ranges`, {
      rows: [
        { sex: 'any', ageMinDays: 0, ageMaxDays: 365, low: 9.5, high: 13.5 },
        { sex: 'male', ageMinDays: 4381, low: 13.5, high: 17.5, criticalLow: 7, criticalHigh: 20 },
        { sex: 'female', ageMinDays: 4381, low: 12, high: 15.5, criticalLow: 7, criticalHigh: 20 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ranges).toHaveLength(3);
    expect(body.check.ok).toBe(true);
    expect(body.check.gaps).toEqual([
      { sex: 'male', fromDays: 366, toDays: 4380 },
      { sex: 'female', fromDays: 366, toDays: 4380 },
    ]);
  });

  it('refuses inverted limits and keeps specimen-specific rows apart', async () => {
    const id = await analyteId('GLU');
    const bad = await ownerC.put(`/catalog/analytes/${id}/ranges`, { rows: [{ low: 100, high: 70 }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('range_invalid');
    const [csf] = await q<{ id: string }>(`select id from sample_types where lab_id = $1 and code = 'URINE'`, [labId]);
    const ok = await ownerC.put(`/catalog/analytes/${id}/ranges`, {
      rows: [
        { low: 70, high: 100, criticalLow: 40, criticalHigh: 500 },
        { low: 0, high: 15, sampleTypeId: csf!.id },
      ],
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('calculated analytes', () => {
  const base = { nameEn: 'Non-HDL cholesterol', nameAr: 'الكولسترول غير عالي الكثافة', unit: 'mg/dL', resultType: 'calculated', decimals: 0 };

  it('refuses a formula that does not parse', async () => {
    const res = await ownerC.post('/catalog/analytes', { ...base, code: 'NHDL', formula: 'CHOL - (HDL' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('formula_invalid');
  });

  it('refuses unknown variables and reports them', async () => {
    const res = await ownerC.post('/catalog/analytes', { ...base, code: 'NHDL', formula: 'CHOL - HDLX' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('formula_unknown_variable');
    expect(res.json().errors.formula).toEqual(['unknown:HDLX']);
  });

  it('refuses a formula that refers to itself through another analyte', async () => {
    const created = await ownerC.post('/catalog/analytes', { ...base, code: 'NHDL', formula: 'CHOL - HDL' });
    expect(created.statusCode).toBe(200);
    const ldl = (await q<{ id: string; code: string; name_en: string; name_ar: string }>(`select id, code, name_en, name_ar from analytes where lab_id = $1 and code = 'LDL'`, [labId]))[0]!;
    // LDL = NHDL - TG/5 would be fine; NHDL = LDL + 1 then closes the loop.
    expect((await ownerC.put(`/catalog/analytes/${ldl.id}`, { ...base, code: 'LDL', nameEn: ldl.name_en, nameAr: ldl.name_ar, formula: 'NHDL - TG / 5' })).statusCode).toBe(200);
    const cyc = await ownerC.put(`/catalog/analytes/${created.json().id}`, { ...base, code: 'NHDL', formula: 'LDL + 1' });
    expect(cyc.statusCode).toBe(400);
    expect(cyc.json().code).toBe('formula_cycle');
  });

  it('checks formulas for the editor and lists the allowed variables', async () => {
    const res = await ownerC.post('/catalog/formula/check', { formula: 'TP - ALB', code: 'GLOB2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, error: null, variables: ['TP', 'ALB'], unknown: [] });
    expect(res.json().allowed.some((a: { code: string }) => a.code === 'CREA')).toBe(true);
  });
});

/* ================================================================== staff & roles */

describe('roles and staff', () => {
  it('a role change takes effect on the next request', async () => {
    expect((await reception.get('/analytics/dashboard')).statusCode).toBe(403);
    const roles = (await ownerC.get('/staff/roles')).json() as Array<{ id: string; key: string; nameAr: string; nameEn: string; permissions: string[] }>;
    const role = roles.find((r) => r.key === 'receptionist')!;
    const res = await ownerC.put(`/staff/roles/${role.id}`, { nameAr: role.nameAr, nameEn: role.nameEn, permissions: [...role.permissions, 'analytics.read'] });
    expect(res.statusCode).toBe(200);
    expect((await reception.get('/analytics/dashboard')).statusCode).toBe(200);
    await ownerC.put(`/staff/roles/${role.id}`, { nameAr: role.nameAr, nameEn: role.nameEn, permissions: role.permissions });
    expect((await reception.get('/analytics/dashboard')).statusCode).toBe(403);
  });

  it('refuses unknown permissions and deleting system roles', async () => {
    const roles = (await ownerC.get('/staff/roles')).json() as Array<{ id: string; key: string; isSystem: boolean }>;
    const tech = roles.find((r) => r.key === 'technician')!;
    expect((await ownerC.put(`/staff/roles/${tech.id}`, { nameAr: 'فني', nameEn: 'Tech', permissions: ['results.enter', 'rockets.launch'] })).statusCode).toBe(400);
    expect((await ownerC.del(`/staff/roles/${tech.id}`)).json().code).toBe('system_role');
  });

  it('creates a user with a one-time temporary password that signs in', async () => {
    const roles = (await ownerC.get('/staff/roles')).json() as Array<{ id: string; key: string }>;
    const res = await ownerC.post('/staff/users', {
      username: 'new.tech',
      fullNameAr: 'ريم سعيد',
      fullNameEn: 'Reem Said',
      roleIds: [roles.find((r) => r.key === 'technician')!.id],
    });
    expect(res.statusCode).toBe(200);
    const { temporaryPassword, user } = res.json();
    expect(temporaryPassword).toMatch(/^[\w]{4}-[\w]{4}-[\w]{4}$/);
    expect(JSON.stringify((await ownerC.get('/staff/users')).json())).not.toContain(temporaryPassword);
    const c = await login(LAB, 'new.tech', temporaryPassword);
    expect(c.me.user.id).toBe(user.id);
  });

  it("revokes a disabled user's sessions at once", async () => {
    const tech = await login(LAB, 'tech');
    expect((await tech.get('/auth/me')).statusCode).toBe(200);
    const users = (await ownerC.get('/staff/users')).json() as Array<{ id: string; username: string }>;
    const id = users.find((u) => u.username === 'tech')!.id;
    expect((await ownerC.post(`/staff/users/${id}/disable`)).json().status).toBe('disabled');
    expect((await tech.get('/auth/me')).statusCode).toBe(401);
    const [open] = await q<{ n: number }>(`select count(*)::int as n from sessions where user_id = $1 and revoked_at is null`, [id]);
    expect(open!.n).toBe(0);
    await expect(login(LAB, 'tech')).rejects.toThrow(/403/);
    expect((await ownerC.post(`/staff/users/${id}/enable`)).json().status).toBe('active');
  });

  it('never leaves the lab without someone who can manage staff', async () => {
    const users = (await ownerC.get('/staff/users')).json() as Array<{ id: string; username: string }>;
    const me = users.find((u) => u.username === 'owner')!;
    expect((await ownerC.post(`/staff/users/${me.id}/disable`)).json().code).toBe('cannot_disable_self');
  });
});

/* ================================================================== finance */

describe('cash sessions, refunds and approvals', () => {
  it('computes expected cash and the difference when the session closes', async () => {
    const cash = await methodId(accountant, 'CASH');
    const card = await methodId(accountant, 'CARD');
    const { invoiceId } = await makeInvoice();

    expect((await accountant.get('/finance/cash-sessions/current')).json().session).toBeNull();
    const opened = await accountant.post('/finance/cash-sessions', { openingFloat: 100_000 });
    expect(opened.statusCode).toBe(201);
    expect((await accountant.post('/finance/cash-sessions', { openingFloat: 5 })).json().code).toBe('session_already_open');

    const pay = (amount: number, method: string) => accountant.post('/billing/payments', { invoiceId, amount, methodId: method, idempotencyKey: randomUUID() });
    expect((await pay(12_000, cash)).statusCode).toBe(201);
    expect((await pay(5_000, card)).statusCode).toBe(201);
    expect((await accountant.post('/finance/refunds', { invoiceId, amount: 2_000, methodId: cash, reason: 'Test not done' })).statusCode).toBe(201);
    const [category] = (await accountant.get('/finance/expense-categories')).json() as Array<{ id: string }>;
    expect((await accountant.post('/finance/expenses', { categoryId: category!.id, amount: 3_000, note: 'Generator diesel', fromDrawer: true })).statusCode).toBe(201);

    const current = (await accountant.get('/finance/cash-sessions/current')).json().session;
    expect(current.totals).toMatchObject({ openingFloat: 100_000, cashPayments: 12_000, cashRefunds: 2_000, cashExpenses: 3_000, expectedCash: 107_000 });
    expect(current.totals.byMethod.find((m: { code: string }) => m.code === 'CARD').payments).toBe(5_000);

    const closed = await accountant.post(`/finance/cash-sessions/${current.id}/close`, { countedCash: 106_500, note: 'short' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'closed', expectedCash: 107_000, countedCash: 106_500, difference: -500 });
    expect((await accountant.post(`/finance/cash-sessions/${current.id}/close`, { countedCash: 1 })).json().code).toBe('session_closed');

    const log = (await ownerC.get('/audit', { entityType: 'cash_session', entityId: current.id })).json();
    expect(log.items.map((i: { action: string }) => i.action)).toEqual(['finance.cash_session.closed', 'finance.cash_session.opened']);
  });

  it('a refund updates the invoice and cannot exceed what was paid', async () => {
    const card = await methodId(accountant, 'CARD');
    const { invoiceId } = await makeInvoice();
    await accountant.post('/billing/payments', { invoiceId, amount: 20_000, methodId: card, idempotencyKey: randomUUID() });
    expect((await accountant.get(`/billing/invoices/${invoiceId}`)).json()).toMatchObject({ paidTotal: 20_000, status: 'paid', balance: 0 });

    const key = randomUUID();
    const res = await accountant.post('/finance/refunds', { invoiceId, amount: 6_000, methodId: card, reason: 'Duplicate test', idempotencyKey: key });
    expect(res.statusCode).toBe(201);
    expect(res.json().invoice).toMatchObject({ paidTotal: 14_000, status: 'partial', balance: 6_000 });
    // Same key again: nothing new is refunded.
    const again = await accountant.post('/finance/refunds', { invoiceId, amount: 6_000, methodId: card, reason: 'Duplicate test', idempotencyKey: key });
    expect(again.statusCode).toBe(200);
    expect((await accountant.get(`/billing/invoices/${invoiceId}`)).json().paidTotal).toBe(14_000);

    const tooMuch = await accountant.post('/finance/refunds', { invoiceId, amount: 14_001, methodId: card, reason: 'Too much' });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().code).toBe('refund_exceeds_paid');
    expect((await reception.post('/finance/refunds', { invoiceId, amount: 1, methodId: card, reason: 'no perm' })).statusCode).toBe(403);
  });

  it('an approved discount request is applied to the invoice', async () => {
    const { invoiceId, orderId } = await makeInvoice();
    const [rec] = await q<{ id: string }>(`select id from users where lab_id = $1 and username = 'reception'`, [labId]);
    const [approval] = await q<{ id: string }>(
      `insert into approvals (lab_id, kind, order_id, invoice_id, amount, reason, requested_by) values ($1, 'discount', $2, $3, 4000, 'Regular patient', $4) returning id`,
      [labId, orderId, invoiceId, rec!.id],
    );
    const list = (await accountant.get('/finance/approvals', { status: 'pending' })).json();
    expect(list.items.find((a: { id: string }) => a.id === approval!.id)).toMatchObject({ effectiveAmount: 4000, invoiceNet: 20_000 });

    const res = await accountant.post(`/finance/approvals/${approval!.id}/decide`, { approve: true, note: 'OK' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved', applied: 4000 });
    expect((await accountant.get(`/billing/invoices/${invoiceId}`)).json()).toMatchObject({ subtotal: 20_000, discountTotal: 4_000, patientTotal: 16_000, balance: 16_000 });
    expect((await accountant.post(`/finance/approvals/${approval!.id}/decide`, { approve: true })).json().code).toBe('already_decided');
    const [n] = await q<{ n: number }>(`select count(*)::int as n from notifications where user_id = $1 and entity_id = $2`, [rec!.id, approval!.id]);
    expect(n!.n).toBe(1);
  });

  it('a rejected request changes nothing, and nobody decides their own request', async () => {
    const { invoiceId, orderId } = await makeInvoice();
    const [acc] = await q<{ id: string }>(`select id from users where lab_id = $1 and username = 'accountant'`, [labId]);
    const [own] = await q<{ id: string }>(
      `insert into approvals (lab_id, kind, order_id, invoice_id, percent, reason, requested_by) values ($1, 'discount', $2, $3, 50, 'Family', $4) returning id`,
      [labId, orderId, invoiceId, acc!.id],
    );
    expect((await accountant.post(`/finance/approvals/${own!.id}/decide`, { approve: true })).json().code).toBe('own_request');
    const res = await ownerC.post(`/finance/approvals/${own!.id}/decide`, { approve: false, note: 'Not eligible' });
    expect(res.json()).toMatchObject({ status: 'rejected', applied: null });
    expect((await accountant.get(`/billing/invoices/${invoiceId}`)).json().patientTotal).toBe(20_000);
  });
});

describe('statements and summary', () => {
  it('lists an insurer’s invoices with their shares and exports them to Excel', async () => {
    const payers = (await ownerC.get('/pricing/payer-groups')).json() as Array<{ id: string; code: string; patientSharePct: number }>;
    const waha = payers.find((p) => p.code === 'WAHA_GOLD')!;
    const patient = await reception.post('/patients', { firstNameAr: 'منى', lastNameAr: 'العلي', sex: 'female', birthDate: '1985-02-11' });
    expect(patient.statusCode).toBeLessThan(300);
    const [test] = await q<{ id: string }>(`select id from tests where lab_id = $1 and code = 'TSH'`, [labId]);
    const order = await reception.post('/orders', { patientId: patient.json().id, payerGroupId: waha.id, items: [{ testId: test!.id }] });
    expect(order.statusCode).toBeLessThan(300);
    const inv = order.json().invoice as { patientTotal: number; insurerTotal: number };
    expect(inv.insurerTotal).toBeGreaterThan(0);

    const st = (await accountant.get('/finance/statements', { payerGroupId: waha.id })).json();
    expect(st.payer.code).toBe('WAHA_GOLD');
    expect(st.invoices).toHaveLength(1);
    expect(st.totals).toMatchObject({ count: 1, insurerTotal: inv.insurerTotal, patientTotal: inv.patientTotal });

    const xlsx = await accountant.get('/finance/statements/export', { payerGroupId: waha.id, lang: 'ar' });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');

    const sum = (await accountant.get('/finance/summary')).json();
    expect(sum.insurerReceivables).toBeGreaterThanOrEqual(inv.insurerTotal);
    expect(sum.byDay).toHaveLength(1);
    const report = await ownerC.get('/analytics/export/volume', { lang: 'en' });
    expect(report.statusCode).toBe(200);
    expect(report.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('analytics', () => {
  it('measures turnaround from receipt to validation, overall and per step', async () => {
    const { orderId } = await makeInvoice();
    const items = await q<{ id: string; test_id: string }>(`select id, test_id from order_items where order_id = $1 order by test_id`, [orderId]);
    const t0 = Date.now() - 6 * 3_600_000;
    const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
    const [first] = await q<{ container_id: string; sample_type_id: string }>(`select container_id, sample_type_id from tests where id = $1`, [items[0]!.test_id]);
    const [sample] = await q<{ id: string }>(
      `insert into samples (lab_id, order_id, barcode, seq, container_id, sample_type_id, status, collected_at, received_at)
       values ($1, $2, $3, 1, $4, $5, 'received', $6, $7) returning id`,
      [labId, orderId, `TAT-${randomUUID().slice(0, 8)}`, first!.container_id, first!.sample_type_id, at(0), at(30)],
    );
    // Item 1 validated 90 min after receipt, item 2 after 150 min; both entered 60 min after receipt.
    for (const [i, item] of items.entries()) {
      await owner.query(`update order_items set sample_id = $1, status = 'validated' where id = $2`, [sample!.id, item.id]);
      const [analyte] = await q<{ analyte_id: string }>(`select analyte_id from test_analytes where test_id = $1 order by sort_order limit 1`, [item.test_id]);
      await owner.query(
        `insert into results (lab_id, order_id, order_item_id, analyte_id, status, value_num, entered_at, verified_at, validated_at)
         values ($1, $2, $3, $4, 'validated', 5, $5, $6, $7)`,
        [labId, orderId, item.id, analyte!.analyte_id, at(90), at(100), at(i === 0 ? 120 : 180)],
      );
    }
    // An explicit range: six hours ago can be yesterday when the suite runs after midnight.
    const labDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(new Date(ms));
    const tat = (await ownerC.get('/analytics/tat', { from: labDay(t0), to: labDay(Date.now()) })).json();
    // The fixture's tests are ABG (target 1 h, so late) and ABO (target 24 h, on time).
    expect(tat.overall).toMatchObject({ count: 2, median: 120, p90: 144, onTimePct: 50 });
    expect(tat.phases).toEqual({ collectToReceive: 30, receiveToResult: 60, resultToValidate: 60 });
    expect(tat.histogram.find((b: { bucket: string }) => b.bucket === '1-2h').count).toBe(1);
    expect(tat.histogram.find((b: { bucket: string }) => b.bucket === '2-4h').count).toBe(1);
    const dash = (await ownerC.get('/analytics/dashboard', { from: labDay(t0), to: labDay(Date.now()) })).json();
    expect(dash.tat).toMatchObject({ count: 2, median: 120 });
    expect(dash.kpis.orders).toBeGreaterThan(0);
    // Money figures are hidden from users who cannot read finance.
    const doctor = await login(LAB, 'doctor');
    expect((await doctor.get('/analytics/dashboard')).json().money).toBeNull();
    expect((await doctor.get('/analytics/revenue')).statusCode).toBe(403);
  });
});

describe('list counts', () => {
  it('each row counts its own records (correlated subqueries stay qualified)', async () => {
    const one = async (sql: string, params: unknown[] = [labId]) => Number((await q<{ n: string }>(sql, params))[0]!.n);
    const [order] = await q<{ id: string }>(`select id from orders where lab_id = $1 limit 1`, [labId]);
    const [doctor] = await q<{ id: string }>(`select id from doctors where lab_id = $1 order by name_ar limit 1`, [labId]);
    await owner.query(`update orders set doctor_id = $1 where id = $2`, [doctor!.id, order!.id]);

    const payers = (await ownerC.get('/pricing/payer-groups')).json() as Array<{ code: string; orderCount: number }>;
    expect(payers.find((p) => p.code === 'PUBLIC')!.orderCount).toBe(
      await one(`select count(*) as n from orders o join payer_groups pg on pg.id = o.payer_group_id where o.lab_id = $1 and pg.code = 'PUBLIC'`),
    );
    expect(payers.find((p) => p.code === 'NAJM')!.orderCount).toBe(0);

    const doctors = (await ownerC.get('/doctors')).json() as Array<{ id: string; orderCount: number }>;
    expect(doctors.find((d) => d.id === doctor!.id)!.orderCount).toBe(1);
    expect(doctors.filter((d) => d.orderCount > 0)).toHaveLength(1);

    const methods = (await ownerC.get('/settings/payment-methods')).json() as Array<{ code: string; useCount: number }>;
    expect(methods.find((m) => m.code === 'CASH')!.useCount).toBe(
      await one(`select count(*) as n from payments p join payment_methods m on m.id = p.method_id where p.lab_id = $1 and m.code = 'CASH'`),
    );
    expect(methods.find((m) => m.code === 'WALLET')!.useCount).toBe(0);

    const categories = (await accountant.get('/finance/expense-categories')).json() as Array<{ id: string; useCount: number }>;
    expect(categories[0]!.useCount).toBe(await one(`select count(*) as n from expenses where category_id = $1`, [categories[0]!.id]));
    expect(categories[1]!.useCount).toBe(0);

    const analytes = (await ownerC.get('/catalog/analytes', { q: 'HGB' })).json() as Array<{ code: string; rangeCount: number; testCodes: string[] }>;
    expect(analytes.find((a) => a.code === 'HGB')).toMatchObject({ rangeCount: 3, testCodes: ['CBC'] });

    const packs = (await ownerC.get('/catalog/packages')).json() as Array<{ code: string; testIds: string[]; testUnits: number }>;
    const thyroid = packs.find((p) => p.code === 'THYROID')!;
    expect(thyroid.testIds).toHaveLength(3);
    expect(thyroid.testUnits).toBe(await one(`select sum(t.units) as n from package_tests pt join tests t on t.id = pt.test_id join packages p on p.id = pt.package_id where p.lab_id = $1 and p.code = 'THYROID'`));

    const roles = (await ownerC.get('/staff/roles')).json() as Array<{ key: string; userCount: number }>;
    expect(roles.find((r) => r.key === 'receptionist')!.userCount).toBe(1);
    const users = (await ownerC.get('/staff/users')).json() as Array<{ username: string; roleIds: string[] }>;
    expect(users.find((u) => u.username === 'owner')!.roleIds).toHaveLength(2);
  });
});

/* ================================================================== audit chain */

describe('audit hash chain', () => {
  it('verifies, detects a row edited in the database, and recovers when it is restored', async () => {
    // A lab of its own, written to only by these admin modules.
    const pool = createPool(process.env.DATABASE_URL!, 2);
    const code = `${LAB}c`;
    let chainLab = '';
    try {
      chainLab = (await seedLab(createDb(pool), { ...LABS[2]!, code }, PASSWORD)).lab.id;
      const c = await login(code, 'owner');
      const deps = (await c.get('/catalog/departments')).json() as Array<{ id: string; code: string; nameAr: string; nameEn: string; sortOrder: number }>;
      const hem = deps.find((d) => d.code === 'HEM')!;
      await c.put(`/catalog/departments/${hem.id}`, { code: 'HEM', nameAr: hem.nameAr, nameEn: 'Haematology', sortOrder: 0 });
      await c.post('/doctors', { nameAr: 'د. لمى حداد', nameEn: 'Dr. Lama Haddad', specialtyEn: 'Paediatrics' });
      await c.post('/finance/cash-sessions', { openingFloat: 25_000 });

      const ok = (await c.get('/audit/verify')).json();
      expect(ok).toMatchObject({ ok: true, broken: null });
      expect(ok.checked).toBeGreaterThanOrEqual(4);

      const [target] = await q<{ id: string; seq: number; summary: string | null }>(
        `select id, seq, summary from audit_log where lab_id = $1 and action = 'catalog.department.updated'`,
        [chainLab],
      );
      await owner.query(`update audit_log set summary = 'nothing to see' where id = $1`, [target!.id]);
      const bad = (await c.get('/audit/verify')).json();
      expect(bad.ok).toBe(false);
      expect(bad.broken).toMatchObject({ id: target!.id, seq: Number(target!.seq), reason: 'hash_mismatch' });

      await owner.query(`update audit_log set summary = $2 where id = $1`, [target!.id, target!.summary]);
      expect((await c.get('/audit/verify')).json().ok).toBe(true);

      // Removing a row breaks the link to the next one.
      await owner.query(`delete from audit_log where id = $1`, [target!.id]);
      const gap = (await c.get('/audit/verify')).json();
      expect(gap).toMatchObject({ ok: false, broken: { reason: 'chain_break' } });
    } finally {
      if (chainLab) await owner.query('delete from labs where id = $1', [chainLab]);
      await pool.end();
    }
  });
});

/* ================================================================== access */

describe('access between roles and labs', () => {
  it('a receptionist cannot open staff or settings endpoints', async () => {
    for (const path of ['/staff/users', '/staff/roles', '/staff/permissions', '/settings/lab', '/audit', '/analytics/dashboard']) {
      expect((await reception.get(path)).statusCode, path).toBe(403);
    }
    expect((await reception.post('/staff/users', { username: 'x.y', fullNameAr: 'س', fullNameEn: 'X', roleIds: [randomUUID()] })).statusCode).toBe(403);
    expect((await reception.put('/settings/lab/settings', {})).statusCode).toBe(403);
    expect((await reception.post('/settings/lab/logo/preview', { svg: '<svg/>' })).statusCode).toBe(403);
    // Shared dropdown data stays readable.
    expect((await reception.get('/settings/payment-methods')).statusCode).toBe(200);
    expect((await reception.get('/catalog/lookups')).statusCode).toBe(200);
  });

  it("another lab's ids are not found", async () => {
    const other = await q<{ kind: string; id: string }>(
      `(select 'test' as kind, id from tests where lab_id = $1 limit 1)
       union all (select 'doctor', id from doctors where lab_id = $1 limit 1)`,
      [labId],
    );
    const yasmin = await login('yasmin', 'owner');
    const testId = other.find((r) => r.kind === 'test')!.id;
    const doctorId = other.find((r) => r.kind === 'doctor')!.id;
    const [role] = await q<{ id: string }>(`select id from roles where lab_id = $1 and key = 'technician'`, [labId]);
    const [user] = await q<{ id: string }>(`select id from users where lab_id = $1 and username = 'reception'`, [labId]);
    const [payer] = await q<{ id: string }>(`select id from payer_groups where lab_id = $1 limit 1`, [labId]);
    const { invoiceId } = await makeInvoice();
    const [approval] = await q<{ id: string }>(
      `insert into approvals (lab_id, kind, invoice_id, amount, reason) values ($1, 'discount', $2, 100, 'x') returning id`,
      [labId, invoiceId],
    );

    expect((await yasmin.get(`/catalog/tests/${testId}`)).statusCode).toBe(404);
    expect((await yasmin.put(`/doctors/${doctorId}`, { nameAr: 'تجربة' })).statusCode).toBe(404);
    expect((await yasmin.del(`/staff/roles/${role!.id}`)).statusCode).toBe(404);
    expect((await yasmin.post(`/staff/users/${user!.id}/reset-password`)).statusCode).toBe(404);
    expect((await yasmin.get('/finance/statements', { payerGroupId: payer!.id })).statusCode).toBe(404);
    expect((await yasmin.post(`/finance/approvals/${approval!.id}/decide`, { approve: true })).statusCode).toBe(404);
    expect((await yasmin.post('/finance/refunds', { invoiceId, amount: 1, methodId: randomUUID(), reason: 'cross lab' })).statusCode).toBe(404);
    // The other lab's data did not change.
    const [still] = await q<{ status: string }>(`select status from approvals where id = $1`, [approval!.id]);
    expect(still!.status).toBe('pending');
  });
});

/**
 * Analyzer integration through the HTTP API: simulation for every model, duplicates, link-layer
 * refusals, the review queue, the Lab Agent API, lab isolation and QC.
 * Orders are made the way the front desk makes them (POST /patients, POST /orders), then the
 * tubes are collected and received, so every test owns its tubes.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@natija/db';
import { PROFILES, simulateResults, type InstrumentModel } from '@natija/protocols';
import type {
  AgentCreated,
  InstrumentListItem,
  OrderDetail,
  OrderFormData,
  QcMaterialItem,
  QcRunItem,
  ReviewDetail,
  ReviewItem,
  SimulateResponse,
} from '@natija/contracts';
import { getApp, login, type Client } from './helpers';

const pool = createPool(process.env.DATABASE_URL!, 2);
afterAll(async () => {
  await pool.end();
});

let owner: Client;
let form: OrderFormData;
let instruments: InstrumentListItem[];
const inst = (code: string) => instruments.find((i) => i.code === code)!;

beforeAll(async () => {
  owner = await login('yasmin', 'owner');
  form = (await owner.get('/orders/form-data')).json();
  const res = await owner.get('/instruments');
  expect(res.statusCode, res.body).toBe(200);
  instruments = res.json();
});

const LETTERS = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
const uniqueName = () => Array.from({ length: 6 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');

/**
 * POST /patients and POST /orders answer 201 from inside their transaction (reply.send before
 * the commit), so the next request can briefly miss the new row: wait until it is visible.
 */
async function visible(url: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await owner.get(url)).statusCode === 200) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${url} never became visible`);
}

/** A patient, an order for these tests, and its tubes collected and received. */
async function receivedOrder(testCodes: string[]): Promise<OrderDetail> {
  const p = await owner.post('/patients', { firstNameAr: 'سامر', lastNameAr: uniqueName(), sex: 'male', birthDate: '1980-05-10' });
  expect(p.statusCode, p.body).toBe(201);
  await visible(`/patients/${p.json().id}`);
  const payer = form.payerGroups.find((g) => g.code === 'PUBLIC')!;
  const items = testCodes.map((code) => ({ testId: form.tests.find((t) => t.code === code)!.id }));
  const o = await owner.post('/orders', { patientId: p.json().id, payerGroupId: payer.id, items });
  expect(o.statusCode, o.body).toBe(201);
  await visible(`/orders/${o.json().id}`);
  const detail: OrderDetail = (await owner.get(`/orders/${o.json().id}`)).json();
  expect((await owner.post('/samples/collect', { sampleIds: detail.tubes.map((t) => t.id) })).statusCode).toBe(200);
  expect((await owner.post('/samples/receive', { barcodes: detail.tubes.map((t) => t.barcode) })).statusCode).toBe(200);
  return detail;
}

async function resultsOf(orderId: string): Promise<Record<string, { status: string; value: string | null }>> {
  const r = await pool.query(
    `select a.code, r.status, coalesce(r.value_text, r.value_num::text) as value from results r join analytes a on a.id = r.analyte_id where r.order_id = $1`,
    [orderId],
  );
  return Object.fromEntries(r.rows.map((x: { code: string; status: string; value: string | null }) => [x.code, { status: x.status, value: x.value }]));
}

async function simulate(code: string, body: Record<string, unknown>): Promise<SimulateResponse> {
  const res = await owner.post(`/instruments/${inst(code).id}/simulate`, body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

describe('simulation through the real link layer', () => {
  const cases: Array<{ code: string; model: InstrumentModel; tests: string[] }> = [
    { code: 'XN550', model: 'sysmex_xn', tests: ['CBC'] },
    { code: 'BS430', model: 'mindray_bs430', tests: ['GLU', 'CRP'] },
    { code: 'PURE', model: 'cobas_pure', tests: ['GLU', 'TSH'] },
    { code: 'E411', model: 'cobas_e411', tests: ['TSH', 'FT4'] },
    { code: 'ICHROMA', model: 'ichroma3', tests: ['PCT', 'CRP'] },
    { code: 'EASYSTAT', model: 'medica_easystat', tests: ['ABG'] },
  ];
  for (const c of cases) {
    it(`${c.code} (${c.model}) puts each value on the analyte its code maps to`, async () => {
      const order = await receivedOrder(c.tests);
      const barcode = order.tubes[0]!.barcode;
      const sim = await simulate(c.code, { mode: 'normal', barcodes: [barcode], seed: 11 });
      expect(sim.instrument.integrationLevel).toBe('L0');
      expect(sim.frames.length).toBeGreaterThan(0);
      expect(sim.parsed[0]?.specimens[0]?.sampleId).toBe(barcode);
      const out = sim.outcome.messages[0]!;
      expect(out.status).toBe('processed');
      const applied = out.items.filter((i) => i.outcome === 'applied');
      expect(applied.length).toBeGreaterThan(0);
      const menu = PROFILES[c.model].tests;
      for (const item of applied) expect(item.analyteCode).toBe(menu.find((t) => t.code === item.code)!.analyte);
      const results = await resultsOf(order.id);
      for (const item of applied) expect(results[item.analyteCode!]).toMatchObject({ status: 'resulted' });
      const tube = await pool.query(`select status from samples where barcode = $1 and order_id = $2`, [barcode, order.id]);
      expect(tube.rows[0].status).toBe('in_analysis');
    });
  }

  it('applies a repeated message once and reports the duplicate', async () => {
    const order = await receivedOrder(['TSH']);
    const sim = await simulate('E411', { mode: 'abnormal', fault: 'duplicate', barcodes: [order.tubes[0]!.barcode], seed: 3 });
    expect(sim.outcome.summary.duplicates).toBe(1);
    const [first, second] = sim.outcome.messages;
    expect(first!.status).toBe('processed');
    expect(second).toMatchObject({ status: 'duplicate', duplicateOf: first!.messageId });
    const attempts = await pool.query(`select count(*)::int as n from result_attempts where message_id = $1`, [first!.messageId]);
    expect(attempts.rows[0].n).toBe(first!.resultsCount);
  });

  it('NAKs a frame with a bad checksum and applies nothing', async () => {
    const order = await receivedOrder(['CBC']);
    const sim = await simulate('XN550', { mode: 'normal', fault: 'bad_checksum', barcodes: [order.tubes[0]!.barcode], seed: 4 });
    expect(sim.outcome.summary).toMatchObject({ refused: 1, applied: 0, delivered: 0 });
    expect(sim.frames.filter((f) => f.side === 'host' && f.text === '<NAK>')).toHaveLength(7);
    expect(Object.values(await resultsOf(order.id)).every((r) => r.status === 'pending')).toBe(true);
    const errors = await owner.get(`/instruments/${inst('XN550').id}/messages`, { status: 'error' });
    expect(errors.json().total).toBeGreaterThan(0);
  });

  it('answers a corrupted HL7 message with AR and stores it as an error', async () => {
    const order = await receivedOrder(['GLU']);
    const sim = await simulate('BS430', { mode: 'normal', fault: 'bad_checksum', barcodes: [order.tubes[0]!.barcode] });
    expect(sim.outcome.messages[0]!.status).toBe('error');
    expect(sim.outcome.summary.applied).toBe(0);
  });

  it('refuses faults that a protocol cannot have', async () => {
    const res = await owner.post(`/instruments/${inst('EASYSTAT').id}/simulate`, { mode: 'normal', fault: 'bad_checksum' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('fault_not_applicable');
  });
});

describe('review queue', () => {
  it('sends unknown codes and unknown tubes to review, and assigning applies the value', async () => {
    const order = await receivedOrder(['CBC']);
    const withCode = await simulate('XN550', { mode: 'normal', fault: 'unknown_code', barcodes: [order.tubes[0]!.barcode], seed: 5 });
    expect(withCode.outcome.summary.review).toBe(1);
    const unknownCode = withCode.outcome.messages[0]!.items.find((i) => i.outcome === 'review')!;
    expect(unknownCode.reason).toBe('unknown_code');

    const noTube = await simulate('XN550', { mode: 'normal', fault: 'unknown_sample', seed: 6 });
    expect(noTube.outcome.summary.applied).toBe(0);
    expect(noTube.outcome.messages[0]!.items.every((i) => i.reason === 'unknown_sample')).toBe(true);
    expect(noTube.outcome.messages[0]!.status).toBe('unmatched');

    const list = await owner.get('/integration/review', { instrumentId: inst('XN550').id, reason: 'unknown_code' });
    const item = (list.json().items as ReviewItem[]).find((i) => i.id === unknownCode.reviewItemId)!;
    expect(item).toMatchObject({ status: 'open', sampleBarcode: order.tubes[0]!.barcode, instrumentCode: unknownCode.code });

    const detail: ReviewDetail = (await owner.get(`/integration/review/${item.id}`)).json();
    const target = detail.candidates.find((c) => c.analyte.code === 'MPV')!;
    expect(target).toBeTruthy();
    const assign = await owner.post(`/integration/review/${item.id}/assign`, { resultId: target.resultId, note: 'checked on the analyzer screen' });
    expect(assign.statusCode, assign.body).toBe(200);
    expect((await resultsOf(order.id)).MPV!.value).toBe(String(Number(unknownCode.value)));
    const after: ReviewDetail = (await owner.get(`/integration/review/${item.id}`)).json();
    expect(after).toMatchObject({ status: 'assigned', assignedResultId: target.resultId });
    expect((await owner.post(`/integration/review/${item.id}/assign`, { resultId: target.resultId })).statusCode).toBe(409);

    const tubeItem = (await owner.get('/integration/review', { reason: 'unknown_sample' })).json().items[0] as ReviewItem;
    const dismissed = await owner.post(`/integration/review/${tubeItem.id}/dismiss`, { note: 'test tube from training' });
    expect(dismissed.json().status).toBe('dismissed');
  });
});

describe('Lab Agent API', () => {
  it('enrols, reports links, serves the worklist and accepts messages idempotently; a revoked agent is refused', async () => {
    const app = await getApp();
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const created = await owner.post('/agents', { name: 'Bench PC (test)' });
    expect(created.statusCode).toBe(201);
    const { enrollmentCode, agent }: AgentCreated = created.json();

    const enrol = await app.inject({ method: 'POST', url: '/api/v1/agent/enroll', payload: { code: `${enrollmentCode.slice(0, 4)}-${enrollmentCode.slice(4)}`, version: 'test' } });
    expect(enrol.statusCode, enrol.body).toBe(200);
    const token = enrol.json().token as string;
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/agent/enroll', payload: { code: enrollmentCode } });
    expect(reuse.statusCode).toBe(401);

    const beat = await app.inject({ method: 'POST', url: '/api/v1/agent/heartbeat', headers: bearer(token), payload: { version: 'test', instruments: [{ code: 'E411', state: 'connected' }, { code: 'NOPE', state: 'waiting' }] } });
    expect(beat.statusCode, beat.body).toBe(200);
    expect(beat.json().instruments.map((i: { accepted: boolean }) => i.accepted)).toEqual([true, false]);
    expect((await owner.get(`/instruments/${inst('E411').id}`)).json()).toMatchObject({ status: 'online', agent: { id: agent.id } });

    const order = await receivedOrder(['FT4']);
    const barcode = order.tubes[0]!.barcode;
    const worklist = await app.inject({ method: 'GET', url: '/api/v1/agent/worklist?instrument=E411', headers: bearer(token) });
    expect(worklist.statusCode).toBe(200);
    const entry = worklist.json().items.find((i: { barcode: string }) => i.barcode === barcode);
    expect(entry.tests).toEqual([{ code: '1020', analyteCode: 'FT4' }]);
    expect(JSON.stringify(worklist.json())).not.toContain('سامر');

    const [message] = simulateResults({ model: 'cobas_e411', mode: 'normal', seed: 9, specimens: [{ sampleId: barcode, tests: ['1020'] }] });
    const upload = { instrumentCode: 'E411', raw: message!.raw, receivedAt: new Date().toISOString(), idempotencyKey: createHash('sha256').update(message!.raw).digest('hex') };
    const sent = await app.inject({ method: 'POST', url: '/api/v1/agent/messages', headers: bearer(token), payload: { messages: [upload] } });
    expect(sent.json().results[0]).toMatchObject({ accepted: true, status: 'processed' });
    expect((await resultsOf(order.id)).FT4).toMatchObject({ status: 'resulted' });
    const again = await app.inject({ method: 'POST', url: '/api/v1/agent/messages', headers: bearer(token), payload: { messages: [upload] } });
    expect(again.json().results[0]).toMatchObject({ accepted: true, status: 'duplicate' });
    const tampered = await app.inject({ method: 'POST', url: '/api/v1/agent/messages', headers: bearer(token), payload: { messages: [{ ...upload, raw: `${upload.raw} ` }] } });
    expect(tampered.json().results[0]).toMatchObject({ accepted: false, error: 'hash_mismatch' });

    expect((await owner.post(`/agents/${agent.id}/revoke`)).statusCode).toBe(200);
    const refused = await app.inject({ method: 'POST', url: '/api/v1/agent/heartbeat', headers: bearer(token), payload: { instruments: [] } });
    expect(refused.statusCode).toBe(401);
    const refusedUpload = await app.inject({ method: 'POST', url: '/api/v1/agent/messages', headers: bearer(token), payload: { messages: [upload] } });
    expect(refusedUpload.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/agent/heartbeat', payload: { instruments: [] } })).statusCode).toBe(401);
  });
});

describe('lab isolation', () => {
  it("does not show or simulate another lab's instrument", async () => {
    const other = await login('orontes', 'owner');
    const id = inst('XN550').id;
    expect((await other.get(`/instruments/${id}`)).statusCode).toBe(404);
    expect((await other.post(`/instruments/${id}/simulate`, { mode: 'normal' })).statusCode).toBe(404);
    expect((await other.get(`/instruments/${id}/messages`)).statusCode).toBe(404);
    const theirs: InstrumentListItem[] = (await other.get('/instruments')).json();
    expect(theirs.some((i) => i.id === id)).toBe(false);
  });
});

describe('quality control', () => {
  it('judges runs with the Westgard rules and plots them', async () => {
    const materials: QcMaterialItem[] = (await owner.get('/qc/materials')).json();
    const created = await owner.post('/qc/materials', {
      instrumentId: inst('BS430').id,
      analyteId: materials.find((m) => m.analyte.code === 'GLU')!.analyte.id,
      name: 'Test control',
      lot: `T-${Date.now()}`,
      level: 'L1',
      targetMean: 100,
      targetSd: 2,
    });
    expect(created.statusCode, created.body).toBe(201);
    const material: QcMaterialItem = created.json();
    const run = async (value: number): Promise<QcRunItem> => {
      const res = await owner.post('/qc/runs', { materialId: material.id, value });
      expect(res.statusCode, res.body).toBe(201);
      return res.json();
    };
    expect(await run(101)).toMatchObject({ status: 'accepted', violations: [] });
    expect(await run(104.5)).toMatchObject({ status: 'warning', violations: ['1-2s'] });
    const rejected = await run(104.6);
    expect(rejected.status).toBe('rejected');
    expect(rejected.violations).toContain('2-2s');
    expect(await run(107)).toMatchObject({ status: 'rejected', violations: expect.arrayContaining(['1-3s']) });

    const chart = (await owner.get(`/qc/materials/${material.id}/chart`)).json();
    expect(chart.lines).toMatchObject({ mean: 100, plus2: 104, minus3: 94 });
    expect(chart.points.map((p: { status: string }) => p.status)).toEqual(['accepted', 'warning', 'rejected', 'rejected']);
    expect((await owner.del(`/qc/materials/${material.id}`)).statusCode).toBe(409);
  });
});

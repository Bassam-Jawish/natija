import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { orders, resultVersions } from '@natija/db';
import { db } from '../src/db';
import { reportContentHash } from '../src/modules/reports/service';
import { anon, login, type Client } from './helpers';
import { createOrderViaApi, createTestOrder, inLab, type OrderFixture } from './bench-fixtures';

describe('bench: collect → receive → enter → verify → validate → release → amend', () => {
  let reception: Client;
  let tech: Client;
  let doctor: Client;
  let owner: Client;
  let fx: OrderFixture;
  let chemistryId: string;
  let v1Code = '';

  beforeAll(async () => {
    [reception, tech, doctor, owner] = await Promise.all([
      login('yasmin', 'reception'),
      login('yasmin', 'tech'),
      login('yasmin', 'doctor'),
      login('yasmin', 'owner'),
    ]);
    fx = await createTestOrder('yasmin', { tests: ['GLU', 'ELEC'], sex: 'male', birthDate: '1980-05-10', priority: 'urgent' });
    const meta = await tech.get('/samples/meta');
    expect(meta.statusCode).toBe(200);
    chemistryId = meta.json().departments.find((d: { code: string }) => d.code === 'CHEM').id;
    expect(meta.json().settings.requireCollectionStep).toBe(true);
    expect(meta.json().rejectionReasons.length).toBeGreaterThan(0);
  });

  it('puts one shared tube in the collection queue and refuses to receive it before collection', async () => {
    expect(fx.tubes).toHaveLength(1);
    const queue = await reception.get('/samples', { view: 'collection' });
    expect(queue.statusCode).toBe(200);
    const entry = queue.json().items.find((o: { order: { id: string } }) => o.order.id === fx.orderId);
    expect(entry).toBeTruthy();
    expect(entry.pendingCount).toBe(1);
    expect(entry.tubes[0].tests.map((t: { code: string }) => t.code).sort()).toEqual(['ELEC', 'GLU']);

    const early = await tech.post('/samples/receive', { barcodes: [fx.tubes[0]!.barcode] });
    expect(early.statusCode).toBe(200);
    expect(early.json().items[0].outcome).toBe('not_collected');
  });

  it('collects, then receives with one outcome per scanned barcode', async () => {
    const collected = await reception.post('/samples/collect', { sampleIds: [fx.tubes[0]!.id] });
    expect(collected.statusCode).toBe(200);
    expect(collected.json().items[0].outcome).toBe('collected');
    expect(collected.json().items[0].sample.status).toBe('collected');

    const res = await tech.post('/samples/receive', { barcodes: [fx.tubes[0]!.barcode, 'NO-SUCH-TUBE'] });
    expect(res.statusCode).toBe(200);
    const [first, second] = res.json().items;
    expect(first.outcome).toBe('received');
    expect(first.sample.status).toBe('received');
    expect(second.outcome).toBe('not_found');
    const again = await tech.post('/samples/receive', { barcodes: [fx.tubes[0]!.barcode] });
    expect(again.json().items[0].outcome).toBe('already_received');

    const events = await tech.get(`/samples/${fx.tubes[0]!.id}/events`);
    expect(events.json().items.map((e: { type: string }) => e.type)).toEqual(['collected', 'received']);
    const order = await inLab(fx.labId, async () => (await db().select().from(orders).where(eq(orders.id, fx.orderId)))[0]!);
    expect(order.status).toBe('in_progress');
  });

  it('lists the tube on the chemistry worklist, waiting for entry', async () => {
    const res = await tech.get('/worklists', { departmentId: chemistryId, status: 'pending' });
    expect(res.statusCode).toBe(200);
    const group = res.json().groups.find((g: { order: { id: string } }) => g.order.id === fx.orderId);
    expect(group).toBeTruthy();
    expect(group.sample.barcode).toBe(fx.tubes[0]!.barcode);
    expect(group.results.map((r: { analyte: { code: string } }) => r.analyte.code)).toEqual(expect.arrayContaining(['GLU', 'NA', 'K', 'CL']));
    expect(group.patient.sex).toBe('male');
  });

  it('refuses a non-numeric value for a numeric test', async () => {
    const res = await tech.put(`/results/${fx.results.GLU}`, { value: 'high' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_number');
  });

  it('flags by sex and age, and a critical value notifies the validators', async () => {
    const batch = await tech.post('/results/batch', {
      entries: [
        { resultId: fx.results.GLU, value: '600' },
        { resultId: fx.results.K, value: '4.2' },
        { resultId: fx.results.CL, value: '101', comment: 'Mild lipaemia' },
      ],
    });
    expect(batch.statusCode).toBe(200);
    const glu = batch.json().items.find((r: { id: string }) => r.id === fx.results.GLU);
    expect(glu.flag).toBe('HH');
    expect(glu.isCritical).toBe(true);
    expect(glu.status).toBe('resulted');
    expect(batch.json().items.find((r: { id: string }) => r.id === fx.results.CL).comment).toBe('Mild lipaemia');

    const na = await owner.put(`/results/${fx.results.NA}`, { value: 140 });
    expect(na.statusCode).toBe(200);
    expect(na.json().flag).toBe('N');

    const notes = await doctor.get('/notifications');
    expect(notes.json().items.some((n: { kind: string; entityId: string }) => n.kind === 'critical' && n.entityId === fx.results.GLU)).toBe(true);

    // Same haemoglobin, three patients: adult man (low), adult woman (normal), 6-month-old (normal).
    const man = await createTestOrder('yasmin', { tests: ['CBC'], sex: 'male', birthDate: '1985-01-01' });
    const woman = await createTestOrder('yasmin', { tests: ['CBC'], sex: 'female', birthDate: '1985-01-01' });
    const infantBirth = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
    const infant = await createTestOrder('yasmin', { tests: ['CBC'], sex: 'male', birthDate: infantBirth });
    const flagOf = async (o: OrderFixture, code: string, value: string) => (await tech.put(`/results/${o.results[code]}`, { value })).json().flag;
    expect(await flagOf(man, 'HGB', '12.5')).toBe('L');
    expect(await flagOf(woman, 'HGB', '12.5')).toBe('N');
    expect(await flagOf(infant, 'HGB', '12.5')).toBe('N');
    expect(await flagOf(man, 'WBC', '16')).toBe('H');
    expect(await flagOf(infant, 'WBC', '16')).toBe('N');
  });

  it('verifies, refuses a wrong password and self-validation, then validates with a signature', async () => {
    const all = [fx.results.GLU!, fx.results.NA!, fx.results.K!, fx.results.CL!];
    const verified = await tech.post('/results/verify', { resultIds: all });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().done).toHaveLength(4);

    const queue = await doctor.get('/results/validation-queue');
    const row = queue.json().items.find((r: { order: { id: string } }) => r.order.id === fx.orderId);
    expect(row.awaiting).toBe(4);
    expect(row.critical).toBe(1);
    expect(row.criticalUncalled).toBe(1);
    expect(row.allReady).toBe(true);

    const wrong = await doctor.post('/results/validate', { resultIds: all, password: 'not-my-password' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('wrong_password');

    // The owner typed the sodium value; segregation of duties stops them validating it.
    const self = await owner.post('/results/validate', { resultIds: [fx.results.NA], password: 'Natija@2026' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('same_user');
    // The technician can't validate at all.
    expect((await tech.post('/results/validate', { resultIds: all, password: 'Natija@2026' })).statusCode).toBe(403);

    const ok = await doctor.post('/results/validate', { resultIds: all, password: 'Natija@2026' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().done).toHaveLength(4);
    const versions = await inLab(fx.labId, () => db().select().from(resultVersions).where(eq(resultVersions.resultId, fx.results.GLU!)));
    expect(versions.map((v) => v.status)).toContain('validated');
  });

  it('blocks release until the critical result has a recorded call, then issues version 1', async () => {
    const blocked = await doctor.post(`/reports/orders/${fx.orderId}/release`, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('critical_call_required');
    expect(blocked.json().errors.resultIds).toEqual([fx.results.GLU]);

    const call = await tech.post(`/results/${fx.results.GLU}/critical-call`, {
      recipientName: 'Dr. Reem Al-Ali',
      recipientRole: 'doctor',
      phone: '+963 944 000 111',
      readBack: true,
      note: 'Patient sent to the emergency department',
    });
    expect(call.statusCode).toBe(200);

    const released = await doctor.post(`/reports/orders/${fx.orderId}/release`, {});
    expect(released.statusCode).toBe(200);
    const v1 = released.json();
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('released');
    expect(v1.verifyCode).toMatch(/^[23456789A-HJ-NP-Z]{10}$/);
    expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);
    v1Code = v1.verifyCode;

    const detail = await reception.get(`/reports/orders/${fx.orderId}`);
    expect(detail.statusCode).toBe(200);
    const snap = detail.json().report.snapshot;
    expect(reportContentHash(snap)).toBe(v1.contentHash);
    expect(snap.lab.code).toBe('yasmin');
    expect(snap.verifyCode).toBe(v1.verifyCode);
    expect(snap.partial).toBe(false);
    expect(snap.validators[0].nameEn).toBeTruthy();
    const gluRow = snap.sections.flatMap((s: { tests: Array<{ rows: unknown[] }> }) => s.tests.flatMap((t) => t.rows)).find((r: { code: string }) => r.code === 'GLU');
    expect(gluRow).toMatchObject({ value: '600', flag: 'HH', isCritical: true });

    const order = await inLab(fx.labId, async () => (await db().select().from(orders).where(eq(orders.id, fx.orderId)))[0]!);
    expect(order.status).toBe('completed');
  });

  it('amends a released result into version 2 and supersedes version 1', async () => {
    const unsigned = await doctor.post(`/results/${fx.results.GLU}/amend`, { value: '95', reason: 'Wrong tube labelled', password: 'nope' });
    expect(unsigned.statusCode).toBe(400);
    expect((await tech.post(`/results/${fx.results.GLU}/amend`, { value: '95', reason: 'x', password: 'Natija@2026' })).statusCode).toBe(403);

    const res = await doctor.post(`/results/${fx.results.GLU}/amend`, { value: '95', reason: 'Wrong tube labelled', password: 'Natija@2026' });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ value: '95', flag: 'N', amended: true, status: 'released', isCritical: false });
    expect(res.json().report.version).toBe(2);

    const detail = await doctor.get(`/reports/orders/${fx.orderId}`);
    const body = detail.json();
    expect(body.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([
      [2, 'released'],
      [1, 'superseded'],
    ]);
    expect(body.report.snapshot.amendReason).toBe('Wrong tube labelled');
    expect(body.report.snapshot.replacesVersion).toBe(1);

    const history = await doctor.get(`/results/${fx.results.GLU}/history`);
    expect(history.statusCode).toBe(200);
    expect(history.json().versions.some((v: { value: string; status: string }) => v.value === '600' && v.status === 'released')).toBe(true);
    expect(history.json().attempts.length).toBeGreaterThanOrEqual(2);
    expect(history.json().criticalCalls).toHaveLength(1);

    const old = await anon('GET', `/public/verify/${v1Code}`);
    expect(old.json().status).toBe('superseded');
    const current = await anon('GET', `/public/verify/${body.versions[0].verifyCode}`);
    expect(current.json()).toMatchObject({ status: 'genuine', version: 2, latestVersion: 2, accession: fx.accession });

    const deliverer = await login('yasmin', 'reception');
    const notes = await deliverer.get('/notifications');
    expect(notes.json().items.some((n: { kind: string; entityId: string }) => n.kind === 'report_ready' && n.entityId === fx.orderId)).toBe(true);
  });
});

describe('bench on an order registered at the front desk (POST /orders)', () => {
  it('collects, receives, validates and releases a partial report while other tests are pending', async () => {
    const [reception, tech, doctor] = await Promise.all([login('orontes', 'reception'), login('orontes', 'tech'), login('orontes', 'doctor')]);
    const o = await createOrderViaApi(reception, { tests: ['GLU', 'CBC'], sex: 'female', birthDate: '1990-02-02', priority: 'urgent' });
    expect(o.tubes.length).toBe(2);
    expect(o.portalCode).toMatch(/^\d{6}$/);
    const collected = await reception.post('/samples/collect', { sampleIds: o.tubes.map((t) => t.id) });
    expect(collected.json().items.every((i: { outcome: string }) => i.outcome === 'collected')).toBe(true);
    const received = await tech.post('/samples/receive', { barcodes: o.tubes.map((t) => t.barcode) });
    expect(received.json().items.map((i: { outcome: string }) => i.outcome)).toEqual(['received', 'received']);

    expect((await tech.put(`/results/${o.results.GLU}`, { value: '88' })).json().flag).toBe('N');
    expect((await tech.post('/results/verify', { resultIds: [o.results.GLU] })).json().done).toHaveLength(1);
    expect((await doctor.post('/results/validate', { resultIds: [o.results.GLU], password: 'Natija@2026' })).statusCode).toBe(200);
    const released = await doctor.post(`/reports/orders/${o.orderId}/release`, {});
    expect(released.statusCode).toBe(200);

    const reports = (await reception.get(`/reports/orders/${o.orderId}`)).json();
    expect(reports.order.status).toBe('partial');
    expect(reports.report.snapshot.partial).toBe(true);
    expect(reports.report.snapshot.pendingTests.map((p: { code: string }) => p.code)).toEqual(['CBC']);
    const verify = await anon('GET', `/public/verify/${released.json().verifyCode}`);
    expect(verify.json()).toMatchObject({ status: 'genuine', accession: o.accession, testCount: 1 });
  });
});

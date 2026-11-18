import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { orderItems } from '@natija/db';
import { db } from '../src/db';
import { login, type Client } from './helpers';
import { createTestOrder, inLab } from './bench-fixtures';

describe('bench: tubes, department scope and tenancy', () => {
  let reception: Client;
  let tech: Client;
  let techHem: Client;
  let reasonId: string;
  let departments: Record<string, string>;

  beforeAll(async () => {
    [reception, tech, techHem] = await Promise.all([login('yasmin', 'reception'), login('yasmin', 'tech'), login('yasmin', 'tech.hem')]);
    const meta = (await tech.get('/samples/meta')).json();
    reasonId = meta.rejectionReasons.find((r: { code: string }) => r.code === 'HEMOLYZED').id;
    departments = Object.fromEntries(meta.departments.map((d: { code: string; id: string }) => [d.code, d.id]));
  });

  it('rejects with recollection: a new tube takes over the lines and collectors are told', async () => {
    const fx = await createTestOrder('yasmin', { tests: ['CBC', 'ESR'] });
    const cbcTube = fx.tubes.find((t) => t.tests.includes('CBC'))!;
    expect((await reception.post('/samples/collect', { barcodes: [cbcTube.barcode] })).json().items[0].outcome).toBe('collected');
    await tech.post('/samples/receive', { barcodes: [cbcTube.barcode] });
    await tech.put(`/results/${fx.results.HGB}`, { value: '13.1' });

    const res = await tech.post(`/samples/${cbcTube.id}/reject`, { reasonId, note: 'Pink serum after spin', recollect: true });
    expect(res.statusCode).toBe(200);
    const { sample, recollect } = res.json();
    expect(sample.status).toBe('rejected');
    expect(sample.rejectionReason.code).toBe('HEMOLYZED');
    expect(sample.recollectedAs.barcode).toBe(recollect.barcode);
    expect(recollect.status).toBe('pending');
    expect(recollect.seq).toBe(fx.tubes.length + 1);
    expect(recollect.barcode).toBe(`${fx.accession}-0${fx.tubes.length + 1}`);
    expect(recollect.recollectOfId).toBe(cbcTube.id);
    expect(recollect.tests.map((t: { code: string }) => t.code)).toEqual(['CBC']);

    const [line] = await inLab(fx.labId, () => db().select().from(orderItems).where(eq(orderItems.id, fx.items.CBC!)));
    expect(line!.sampleId).toBe(recollect.id);
    const hgb = (await tech.get(`/results/${fx.results.HGB}/history`)).json();
    expect(hgb.result.status).toBe('pending');
    expect(hgb.result.value).toBeNull();

    const notes = await reception.get('/notifications');
    expect(notes.json().items.some((n: { kind: string; entityId: string }) => n.kind === 'rejection' && n.entityId === recollect.id)).toBe(true);
    // The rejected tube can't be received any more; the new one is in the collection queue.
    expect((await tech.post('/samples/receive', { barcodes: [cbcTube.barcode] })).json().items[0].outcome).toBe('rejected');
    const queue = (await reception.get('/samples', { view: 'collection' })).json();
    expect(queue.items.find((o: { order: { id: string } }) => o.order.id === fx.orderId).tubes.some((t: { id: string }) => t.id === recollect.id)).toBe(true);
  });

  it('rejects without recollection: the lines read as rejected', async () => {
    const fx = await createTestOrder('yasmin', { tests: ['GLU'] });
    const res = await tech.post(`/samples/${fx.tubes[0]!.id}/reject`, { reasonId, recollect: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().recollect).toBeNull();
    expect(res.json().sample.tests[0].status).toBe('rejected');
    expect((await tech.post(`/samples/${fx.tubes[0]!.id}/reject`, { reasonId })).json().code).toBe('sample_already_rejected');
    expect((await tech.put(`/results/${fx.results.GLU}`, { value: '90' })).json().code).toBe('sample_rejected');
  });

  it('transfers, stores and disposes of a tube with a timeline, refusing disposal while work is open', async () => {
    const fx = await createTestOrder('yasmin', { tests: ['TSH'] });
    const tube = fx.tubes[0]!;
    await reception.post('/samples/collect', { sampleIds: [tube.id] });
    const moved = await reception.post(`/samples/${tube.id}/transfer`, { toLocation: 'Main lab · Mezzeh' });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().status).toBe('in_transit');
    expect((await tech.post('/samples/receive', { barcodes: [tube.barcode] })).json().items[0].outcome).toBe('received');

    const stored = await tech.post(`/samples/${tube.id}/store`, { location: 'Fridge 2 · Rack B' });
    expect(stored.json()).toMatchObject({ status: 'stored', storageLocation: 'Fridge 2 · Rack B' });
    expect((await tech.post(`/samples/${tube.id}/dispose`, {})).json().code).toBe('sample_in_use');

    const byBarcode = await tech.get(`/samples/by-barcode/${encodeURIComponent(tube.barcode)}`);
    expect(byBarcode.statusCode).toBe(200);
    expect(byBarcode.json().events.map((e: { type: string }) => e.type)).toEqual(['collected', 'moved', 'received', 'stored']);
    const storage = await tech.get('/samples', { status: 'stored', q: tube.barcode });
    expect(storage.json().items.map((s: { id: string }) => s.id)).toContain(tube.id);
    expect((await reception.post(`/samples/${tube.id}/store`, { location: 'x' })).statusCode).toBe(403);
  });

  it('keeps a technician limited to haematology out of chemistry', async () => {
    const fx = await createTestOrder('yasmin', { tests: ['CBC', 'GLU'] });
    await reception.post('/samples/collect', { sampleIds: fx.tubes.map((t) => t.id) });
    await tech.post('/samples/receive', { barcodes: fx.tubes.map((t) => t.barcode) });

    const chem = await techHem.get('/worklists', { departmentId: departments.CHEM! });
    expect(chem.statusCode).toBe(403);
    expect(chem.json().code).toBe('department_not_allowed');
    const mine = await techHem.get('/worklists', { status: 'pending' });
    expect(mine.statusCode).toBe(200);
    const groups = mine.json().groups.filter((g: { order: { id: string } }) => g.order.id === fx.orderId);
    expect(groups.length).toBe(1);
    expect(groups[0].results.every((r: { test: { code: string } }) => r.test.code === 'CBC')).toBe(true);
    expect((await techHem.put(`/results/${fx.results.GLU}`, { value: '90' })).statusCode).toBe(403);
    expect((await techHem.put(`/results/${fx.results.HGB}`, { value: '14' })).statusCode).toBe(200);

    const all = await tech.get('/worklists', { departmentId: departments.CHEM! });
    expect(all.json().groups.some((g: { order: { id: string } }) => g.order.id === fx.orderId)).toBe(true);
  });

  it("answers 404 for another lab's tubes, results, orders and reports", async () => {
    const fx = await createTestOrder('yasmin', { tests: ['GLU'] });
    const [other, otherDoctor] = await Promise.all([login('orontes', 'tech'), login('orontes', 'doctor')]);
    const meta = (await other.get('/samples/meta')).json();
    const reason = meta.rejectionReasons[0].id;
    expect((await other.get(`/samples/by-barcode/${encodeURIComponent(fx.tubes[0]!.barcode)}`)).statusCode).toBe(404);
    expect((await other.get(`/samples/${fx.tubes[0]!.id}/events`)).statusCode).toBe(404);
    expect((await other.post(`/samples/${fx.tubes[0]!.id}/reject`, { reasonId: reason })).statusCode).toBe(404);
    expect((await other.post('/samples/receive', { barcodes: [fx.tubes[0]!.barcode] })).json().items[0].outcome).toBe('not_found');
    expect((await other.put(`/results/${fx.results.GLU}`, { value: '90' })).statusCode).toBe(404);
    expect((await other.get(`/results/${fx.results.GLU}/history`)).statusCode).toBe(404);
    expect((await otherDoctor.get(`/results/orders/${fx.orderId}`)).statusCode).toBe(404);
    expect((await otherDoctor.get(`/reports/orders/${fx.orderId}`)).statusCode).toBe(404);
    expect((await otherDoctor.post(`/reports/orders/${fx.orderId}/release`, {})).statusCode).toBe(404);
  });
});

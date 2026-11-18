/**
 * Test data for the bench tests: an order with its tubes, lines and empty results, written
 * straight to the database inside the lab's context (the same rows POST /orders creates),
 * or registered through the front desk's own API (createOrderViaApi).
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { analytes, labs, orderItems, orders, patients, payerGroups, results, samples, testAnalytes, tests } from '@natija/db';
import { buildSearchText, groupIntoTubes, tubeBarcode } from '@natija/domain';
import { appDb, db, withLab } from '../src/db';
import type { Client } from './helpers';

let seq = 0;

/** Register a patient and an order at the front desk (POST /patients, POST /orders), then read its tubes and results back. */
export async function createOrderViaApi(
  desk: Client,
  opts: { tests: string[]; sex?: 'male' | 'female'; birthDate?: string; priority?: 'routine' | 'urgent' | 'stat' },
): Promise<Omit<OrderFixture, 'labId' | 'patientId' | 'items'> & { status: string }> {
  seq += 1;
  const form = (await desk.get('/orders/form-data')).json() as { tests: Array<{ id: string; code: string }>; payerGroups: Array<{ id: string; code: string }> };
  const patient = await desk.post('/patients', {
    firstNameAr: 'نور',
    lastNameAr: `مكتب ${seq}`,
    firstNameEn: 'Nour',
    lastNameEn: `Desk ${seq}`,
    sex: opts.sex ?? 'female',
    birthDate: opts.birthDate ?? '1990-02-02',
    phone: '0933 000 111',
    contactPref: 'whatsapp',
  });
  if (patient.statusCode >= 300) throw new Error(`POST /patients ${patient.statusCode} ${patient.body}`);
  const created = await desk.post('/orders', {
    patientId: patient.json().id,
    payerGroupId: form.payerGroups.find((p) => p.code === 'PUBLIC')!.id,
    priority: opts.priority ?? 'routine',
    items: opts.tests.map((code) => ({ testId: form.tests.find((t) => t.code === code)!.id })),
  });
  if (created.statusCode >= 300) throw new Error(`POST /orders ${created.statusCode} ${created.body}`);
  const order = created.json() as { id: string; accession: string; portalCode: string; status: string };
  const tubes = (await desk.get('/samples', { orderId: order.id })).json().items as Array<{ id: string; barcode: string; tests: Array<{ code: string }> }>;
  const sections = (await desk.get(`/results/orders/${order.id}`)).json().sections as Array<{ items: Array<{ results: Array<{ id: string; analyte: { code: string } }> }> }>;
  const resultIds: Record<string, string> = {};
  for (const r of sections.flatMap((s) => s.items.flatMap((i) => i.results))) resultIds[r.analyte.code] = r.id;
  return {
    orderId: order.id,
    accession: order.accession,
    portalCode: order.portalCode,
    status: order.status,
    tubes: tubes.map((t) => ({ id: t.id, barcode: t.barcode, tests: t.tests.map((x) => x.code) })),
    results: resultIds,
  };
}

export async function labIdOf(code: string): Promise<string> {
  const [lab] = await appDb.select({ id: labs.id }).from(labs).where(eq(labs.code, code));
  if (!lab) throw new Error(`no lab ${code}`);
  return lab.id;
}

export type OrderFixture = {
  labId: string;
  orderId: string;
  accession: string;
  portalCode: string;
  patientId: string;
  tubes: Array<{ id: string; barcode: string; tests: string[] }>;
  /** Order line id by test code. */
  items: Record<string, string>;
  /** Result id by analyte code. */
  results: Record<string, string>;
};

export async function createTestOrder(
  labCode: string,
  opts: {
    tests: string[];
    sex?: 'male' | 'female';
    birthDate?: string;
    priority?: 'routine' | 'urgent' | 'stat';
    portalCode?: string;
    phone?: string | null;
    email?: string | null;
  },
): Promise<OrderFixture> {
  const labId = await labIdOf(labCode);
  seq += 1;
  const stamp = `${Date.now().toString(36).toUpperCase()}${seq}`;
  return withLab(labId, {}, async () => {
    const [payer] = await db().select().from(payerGroups).where(eq(payerGroups.code, 'PUBLIC'));
    const testRows = await db().select().from(tests).where(inArray(tests.code, opts.tests));
    const ordered = opts.tests.map((code) => testRows.find((t) => t.code === code)!);
    const firstNameAr = 'سامر';
    const lastNameAr = `اختبار ${stamp}`;
    const [patient] = await db()
      .insert(patients)
      .values({
        labId,
        mrn: `T-${stamp}`.slice(0, 20),
        firstNameAr,
        lastNameAr,
        firstNameEn: 'Samer',
        lastNameEn: `Test ${stamp}`,
        fullNameAr: `${firstNameAr} ${lastNameAr}`,
        fullNameEn: `Samer Test ${stamp}`,
        searchText: buildSearchText([firstNameAr, lastNameAr, 'Samer', stamp]),
        sex: opts.sex ?? 'male',
        birthDate: opts.birthDate ?? '1980-05-10',
        phone: opts.phone === undefined ? '0944 123 456' : opts.phone,
        email: opts.email ?? null,
      })
      .returning();
    const accession = `T-${stamp}`;
    const portalCode = opts.portalCode ?? '482915';
    const [order] = await db()
      .insert(orders)
      .values({
        labId,
        accession,
        dailyNo: 9000 + seq,
        patientId: patient!.id,
        payerGroupId: payer!.id,
        priority: opts.priority ?? 'routine',
        portalCode,
      })
      .returning();

    const plan = groupIntoTubes(
      ordered.map((t) => ({ key: t.code, containerId: t.containerId, sampleTypeId: t.sampleTypeId, departmentId: t.departmentId, separateTube: t.separateTube })),
    );
    const tubes: OrderFixture['tubes'] = [];
    const tubeOf = new Map<string, string>();
    for (const [i, tube] of plan.entries()) {
      const [s] = await db()
        .insert(samples)
        .values({
          labId,
          orderId: order!.id,
          barcode: tubeBarcode(accession, i + 1),
          seq: i + 1,
          containerId: tube.containerId,
          sampleTypeId: tube.sampleTypeId,
          departmentId: tube.departmentId,
          status: 'pending',
        })
        .returning();
      tubes.push({ id: s!.id, barcode: s!.barcode, tests: tube.itemKeys });
      for (const key of tube.itemKeys) tubeOf.set(key, s!.id);
    }

    const items: Record<string, string> = {};
    const resultIds: Record<string, string> = {};
    for (const t of ordered) {
      const [item] = await db()
        .insert(orderItems)
        .values({ labId, orderId: order!.id, testId: t.id, sampleId: tubeOf.get(t.code)!, units: t.units })
        .returning();
      items[t.code] = item!.id;
      const links = await db()
        .select({ id: analytes.id, code: analytes.code, unit: analytes.unit })
        .from(testAnalytes)
        .innerJoin(analytes, eq(analytes.id, testAnalytes.analyteId))
        .where(eq(testAnalytes.testId, t.id))
        .orderBy(asc(testAnalytes.sortOrder));
      for (const a of links) {
        const [r] = await db()
          .insert(results)
          .values({ labId, orderId: order!.id, orderItemId: item!.id, analyteId: a.id, unit: a.unit })
          .returning({ id: results.id });
        resultIds[a.code] = r!.id;
      }
    }
    return { labId, orderId: order!.id, accession, portalCode, patientId: patient!.id, tubes, items, results: resultIds };
  });
}

/** Run a query in a lab's context (for checks the API doesn't expose). */
export function inLab<T>(labId: string, fn: () => Promise<T>): Promise<T> {
  return withLab(labId, {}, fn);
}

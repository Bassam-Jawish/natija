/**
 * Tubes from the phlebotomy chair to the fridge: collection, reception at the bench,
 * rejection with recollection, transfer, storage and disposal. Every move writes a
 * sample_events row, then the order's line statuses are recomputed.
 * All functions run inside the current lab context (withLab).
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  containers,
  departments,
  instruments,
  orderItems,
  orders,
  patients,
  rejectionReasons,
  results,
  sampleEvents,
  samples,
  sampleTypes,
  tests,
} from '@natija/db';
import type {
  BenchCollectOutcome,
  BenchCollectResult,
  BenchItemStatus,
  BenchMeta,
  BenchReceiveOutcome,
  BenchReceiveResult,
  BenchRejectResult,
  BenchSample,
  BenchSampleEvent,
  BenchSampleStatus,
  CollectionQueue,
  ReportLanguage,
} from '@natija/contracts';
import { normalizeText, tubeBarcode } from '@natija/domain';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange } from '../../lib/http';
import { getLab } from '../../lib/lab';
import { notifyPermission } from '../../lib/notify';
import { refreshOrderStatus } from '../../services/order-status';
import { applyResultValue } from '../../services/results-engine';
import { inSequence, iso, loadUserRefs, orderCols, orderRef, patientCols, patientRef, priorityRank } from '../results/shared';

type SampleRow = typeof samples.$inferSelect;
type EventType = (typeof sampleEvents.$inferInsert)['type'];
export type MoveOptions = { at?: Date };

/* ------------------------------------------------------------------ reading */

const sampleSelect = {
  s: samples,
  o: orderCols,
  p: patientCols,
  c: { id: containers.id, code: containers.code, nameAr: containers.nameAr, nameEn: containers.nameEn, capColor: containers.capColor },
  st: { id: sampleTypes.id, code: sampleTypes.code, nameAr: sampleTypes.nameAr, nameEn: sampleTypes.nameEn },
  d: { id: departments.id, code: departments.code, nameAr: departments.nameAr, nameEn: departments.nameEn },
  rr: { id: rejectionReasons.id, code: rejectionReasons.code, nameAr: rejectionReasons.nameAr, nameEn: rejectionReasons.nameEn },
};

function sampleQuery() {
  return db()
    .select(sampleSelect)
    .from(samples)
    .innerJoin(orders, eq(orders.id, samples.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(containers, eq(containers.id, samples.containerId))
    .innerJoin(sampleTypes, eq(sampleTypes.id, samples.sampleTypeId))
    .leftJoin(departments, eq(departments.id, samples.departmentId))
    .leftJoin(rejectionReasons, eq(rejectionReasons.id, samples.rejectionReasonId));
}

function sampleCount() {
  return db()
    .select({ n: count() })
    .from(samples)
    .innerJoin(orders, eq(orders.id, samples.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId));
}

/** Tubes matching `where`, hydrated with tests, people, the replacement tube and (optionally) events. */
async function loadSamples(
  where: SQL | undefined,
  opts: { orderBy?: SQL[]; limit?: number; offset?: number; events?: boolean } = {},
): Promise<BenchSample[]> {
  let q = sampleQuery()
    .where(where)
    .orderBy(...(opts.orderBy ?? [asc(samples.orderId), asc(samples.seq)]))
    .$dynamic();
  if (opts.limit) q = q.limit(opts.limit).offset(opts.offset ?? 0);
  const rows = await q;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.s.id);

  const [testRows, replacements, userMap, eventRows] = await inSequence([
    () => db()
      .select({
        sampleId: orderItems.sampleId,
        orderItemId: orderItems.id,
        status: orderItems.status,
        testId: tests.id,
        code: tests.code,
        nameAr: tests.nameAr,
        nameEn: tests.nameEn,
        departmentId: tests.departmentId,
        sortOrder: tests.sortOrder,
      })
      .from(orderItems)
      .innerJoin(tests, eq(tests.id, orderItems.testId))
      .where(and(inArray(orderItems.sampleId, ids), ne(orderItems.status, 'cancelled')))
      .orderBy(asc(tests.sortOrder)),
    () => db().select({ id: samples.id, barcode: samples.barcode, of: samples.recollectOfId }).from(samples).where(inArray(samples.recollectOfId, ids)),
    () => loadUserRefs(rows.flatMap((r) => [r.s.collectedBy, r.s.receivedBy])),
    () => opts.events ? loadEvents(ids) : Promise.resolve(new Map<string, BenchSampleEvent[]>()),
  ]);
  const testsBySample = new Map<string, BenchSample['tests']>();
  for (const t of testRows) {
    const list = testsBySample.get(t.sampleId!) ?? [];
    list.push({ orderItemId: t.orderItemId, testId: t.testId, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn, status: t.status as BenchItemStatus, departmentId: t.departmentId });
    testsBySample.set(t.sampleId!, list);
  }
  const replacementOf = new Map(replacements.map((r) => [r.of!, { id: r.id, barcode: r.barcode }]));

  return rows.map(({ s, o, p, c, st, d, rr }) => ({
    id: s.id,
    barcode: s.barcode,
    seq: s.seq,
    status: s.status as BenchSampleStatus,
    order: orderRef(o),
    patient: patientRef(p),
    container: c,
    sampleType: st,
    department: d ?? null,
    tests: testsBySample.get(s.id) ?? [],
    collectedAt: iso(s.collectedAt),
    collectedBy: s.collectedBy ? (userMap.get(s.collectedBy) ?? null) : null,
    receivedAt: iso(s.receivedAt),
    receivedBy: s.receivedBy ? (userMap.get(s.receivedBy) ?? null) : null,
    rejectedAt: iso(s.rejectedAt),
    rejectionReason: rr ?? null,
    rejectionNote: s.rejectionNote,
    storedAt: iso(s.storedAt),
    disposedAt: iso(s.disposedAt),
    storageLocation: s.storageLocation,
    recollectOfId: s.recollectOfId,
    recollectedAs: replacementOf.get(s.id) ?? null,
    labelPrintedAt: iso(s.labelPrintedAt),
    createdAt: s.createdAt.toISOString(),
    ...(opts.events ? { events: eventRows.get(s.id) ?? [] } : {}),
  }));
}

async function loadEvents(sampleIds: string[]): Promise<Map<string, BenchSampleEvent[]>> {
  const rows = await db().select().from(sampleEvents).where(inArray(sampleEvents.sampleId, sampleIds)).orderBy(asc(sampleEvents.at), asc(sampleEvents.id));
  const userMap = await loadUserRefs(rows.map((r) => r.userId));
  const out = new Map<string, BenchSampleEvent[]>();
  for (const e of rows) {
    const list = out.get(e.sampleId) ?? [];
    list.push({
      id: e.id,
      type: e.type,
      at: e.at.toISOString(),
      user: e.userId ? (userMap.get(e.userId) ?? null) : null,
      fromLocation: e.fromLocation,
      toLocation: e.toLocation,
      note: e.note,
    });
    out.set(e.sampleId, list);
  }
  return out;
}

async function loadSamplesByIds(ids: string[]): Promise<Map<string, BenchSample>> {
  if (!ids.length) return new Map();
  const list = await loadSamples(inArray(samples.id, ids));
  return new Map(list.map((s) => [s.id, s]));
}

/** A tube belongs to a department directly, or through one of its tests (shared tubes). */
function departmentCondition(departmentId: string): SQL {
  return or(
    eq(samples.departmentId, departmentId),
    sql`exists (select 1 from order_items oi join tests t on t.id = oi.test_id where oi.sample_id = "samples"."id" and t.department_id = ${departmentId})`,
  )!;
}

function searchCondition(q: string): SQL | undefined {
  const raw = q.trim();
  if (!raw) return undefined;
  const term = normalizeText(raw).replace(/[%_]/g, '');
  const prefix = `${raw.replace(/[%_]/g, '')}%`;
  return or(
    ilike(samples.barcode, prefix),
    ilike(orders.accession, prefix),
    ilike(patients.mrn, prefix),
    term ? ilike(patients.searchText, `%${term}%`) : undefined,
  );
}

const DATE_COLUMNS = {
  created: samples.createdAt,
  collected: samples.collectedAt,
  received: samples.receivedAt,
  rejected: samples.rejectedAt,
  stored: samples.storedAt,
} as const;

export type SampleListParams = {
  status?: BenchSampleStatus[];
  departmentId?: string;
  orderId?: string;
  from?: string;
  to?: string;
  dateBy?: keyof typeof DATE_COLUMNS;
  sort?: 'asc' | 'desc';
  q?: string;
  events?: boolean;
  limit?: number;
  offset?: number;
};

async function listConditions(p: SampleListParams): Promise<SQL | undefined> {
  const conds: Array<SQL | undefined> = [];
  if (p.status?.length) conds.push(inArray(samples.status, p.status));
  if (p.departmentId) conds.push(departmentCondition(p.departmentId));
  if (p.orderId) conds.push(eq(samples.orderId, p.orderId));
  else conds.push(ne(orders.status, 'cancelled'));
  if (p.from || p.to) {
    const { start, end } = await dayRange(p.from, p.to);
    const col = DATE_COLUMNS[p.dateBy ?? 'created'];
    conds.push(gte(col, start), lt(col, end));
  }
  if (p.q) conds.push(searchCondition(p.q));
  return and(...conds);
}

/** Tubes for lists (reception tabs, storage, an order's tubes). */
export async function listSamples(p: SampleListParams): Promise<{ items: BenchSample[]; total: number }> {
  const where = await listConditions(p);
  const col = DATE_COLUMNS[p.dateBy ?? 'created'];
  const dir = p.sort === 'asc' ? asc : desc;
  const orderBy = p.orderId ? [asc(samples.seq)] : [asc(priorityRank), dir(sql`coalesce(${col}, ${samples.createdAt})`), asc(samples.barcode)];
  const [items, [total]] = await inSequence([
    () => loadSamples(where, { orderBy, limit: p.limit ?? 100, offset: p.offset ?? 0, events: p.events }),
    () => sampleCount().where(where),
  ]);
  return { items, total: Number(total?.n ?? 0) };
}

/** Orders with tubes still to collect: STAT and urgent first, then the longest waiting. */
export async function collectionQueue(p: { departmentId?: string; from?: string; to?: string; q?: string; limit?: number }): Promise<CollectionQueue> {
  const conds: Array<SQL | undefined> = [eq(samples.status, 'pending'), ne(orders.status, 'cancelled')];
  if (p.departmentId) conds.push(departmentCondition(p.departmentId));
  if (p.from || p.to) {
    const { start, end } = await dayRange(p.from, p.to);
    conds.push(gte(orders.createdAt, start), lt(orders.createdAt, end));
  }
  if (p.q) conds.push(searchCondition(p.q));
  const where = and(...conds);
  const orderRows = await db()
    .selectDistinct({ id: orders.id, rank: priorityRank, createdAt: orders.createdAt })
    .from(samples)
    .innerJoin(orders, eq(orders.id, samples.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .where(where)
    .orderBy(asc(priorityRank), asc(orders.createdAt))
    .limit(p.limit ?? 200);
  const [total] = await db()
    .select({ n: sql<number>`count(distinct ${orders.id})` })
    .from(samples)
    .innerJoin(orders, eq(orders.id, samples.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .where(where);
  if (!orderRows.length) return { items: [], total: 0 };

  const tubes = await loadSamples(and(inArray(samples.orderId, orderRows.map((o) => o.id)), notInArray(samples.status, ['disposed'])), {
    orderBy: [asc(samples.orderId), asc(samples.seq)],
  });
  const byOrder = new Map<string, BenchSample[]>();
  for (const t of tubes) {
    const list = byOrder.get(t.order.id) ?? [];
    list.push(t);
    byOrder.set(t.order.id, list);
  }
  const items = orderRows
    .map((o) => byOrder.get(o.id) ?? [])
    .filter((list) => list.length > 0)
    .map((list) => ({
      order: list[0]!.order,
      patient: list[0]!.patient,
      tubes: list,
      pendingCount: list.filter((t) => t.status === 'pending').length,
      totalCount: list.filter((t) => t.status !== 'rejected').length,
    }));
  return { items, total: Number(total?.n ?? 0) };
}

export async function getSampleByBarcode(barcode: string): Promise<BenchSample> {
  const [sample] = await loadSamples(eq(samples.barcode, barcode.trim()), { events: true });
  if (!sample) throw notFound('sample_not_found');
  return sample;
}

export async function getSample(sampleId: string): Promise<BenchSample> {
  const [sample] = await loadSamples(eq(samples.id, sampleId), { events: true });
  if (!sample) throw notFound('sample_not_found');
  return sample;
}

export async function getSampleEvents(sampleId: string): Promise<BenchSampleEvent[]> {
  const [row] = await db().select({ id: samples.id }).from(samples).where(eq(samples.id, sampleId));
  if (!row) throw notFound('sample_not_found');
  return (await loadEvents([sampleId])).get(sampleId) ?? [];
}

export async function getBenchMeta(myDepartmentIds: string[]): Promise<BenchMeta> {
  const lab = await getLab(ctx().labId);
  const [deptRows, containerRows, typeRows, reasonRows, instrumentRows] = await inSequence([
    () => db()
      .select({ id: departments.id, code: departments.code, nameAr: departments.nameAr, nameEn: departments.nameEn, sortOrder: departments.sortOrder })
      .from(departments)
      .orderBy(asc(departments.sortOrder), asc(departments.code)),
    () => db()
      .select({ id: containers.id, code: containers.code, nameAr: containers.nameAr, nameEn: containers.nameEn, capColor: containers.capColor })
      .from(containers)
      .orderBy(asc(containers.createdAt), asc(containers.code)),
    () => db()
      .select({ id: sampleTypes.id, code: sampleTypes.code, nameAr: sampleTypes.nameAr, nameEn: sampleTypes.nameEn })
      .from(sampleTypes)
      .orderBy(asc(sampleTypes.createdAt), asc(sampleTypes.code)),
    () => db()
      .select({ id: rejectionReasons.id, code: rejectionReasons.code, nameAr: rejectionReasons.nameAr, nameEn: rejectionReasons.nameEn })
      .from(rejectionReasons)
      .orderBy(asc(rejectionReasons.createdAt), asc(rejectionReasons.code)),
    () => db()
      .select({ id: instruments.id, code: instruments.code, name: instruments.name, departmentId: instruments.departmentId, status: instruments.status })
      .from(instruments)
      .where(eq(instruments.isActive, true))
      .orderBy(asc(instruments.code)),
  ]);
  return {
    departments: deptRows,
    containers: containerRows,
    sampleTypes: typeRows,
    rejectionReasons: reasonRows,
    instruments: instrumentRows,
    myDepartmentIds,
    settings: {
      requireCollectionStep: lab.settings.requireCollectionStep === true,
      segregationOfDuties: lab.settings.segregationOfDuties === true,
      reportLanguage: (lab.settings.reportLanguage ?? 'bilingual') as ReportLanguage,
    },
  };
}

/* ------------------------------------------------------------------ moves */

async function addEvent(sampleId: string, type: EventType, at: Date, extra: { note?: string | null; from?: string | null; to?: string | null } = {}) {
  const { labId, userId } = ctx();
  await db()
    .insert(sampleEvents)
    .values({ labId, sampleId, type, at, userId, note: extra.note ?? null, fromLocation: extra.from ?? null, toLocation: extra.to ?? null });
}

async function afterMoves(orderIds: Iterable<string>, sampleIds: string[]) {
  const unique = [...new Set(orderIds)];
  for (const orderId of unique) await refreshOrderStatus(orderId);
  if (sampleIds.length) publish({ type: 'samples.changed', data: { orderIds: unique, sampleIds } });
}

async function lockSample(sampleId: string): Promise<SampleRow & { orderStatus: string; accession: string }> {
  const [row] = await db()
    .select({ s: samples, orderStatus: orders.status, accession: orders.accession })
    .from(samples)
    .innerJoin(orders, eq(orders.id, samples.orderId))
    .where(eq(samples.id, sampleId))
    .for('update', { of: samples });
  if (!row) throw notFound('sample_not_found');
  return { ...row.s, orderStatus: row.orderStatus, accession: row.accession };
}

/** Mark tubes as drawn (by id from the queue, or by barcode from the scan box). */
export async function collectSamples(input: { sampleIds?: string[]; barcodes?: string[] }, opts: MoveOptions = {}): Promise<BenchCollectResult> {
  const { userId } = ctx();
  const now = opts.at ?? new Date();
  const ids = [...new Set(input.sampleIds ?? [])];
  const codes = [...new Set((input.barcodes ?? []).map((b) => b.trim()).filter(Boolean))];
  const rows = await db()
    .select({ s: samples, orderStatus: orders.status })
    .from(samples)
    .innerJoin(orders, eq(orders.id, samples.orderId))
    .where(or(ids.length ? inArray(samples.id, ids) : undefined, codes.length ? inArray(samples.barcode, codes) : undefined))
    .for('update', { of: samples });
  const byId = new Map(rows.map((r) => [r.s.id, r]));
  const byCode = new Map(rows.map((r) => [r.s.barcode, r]));

  const outcomes: Array<{ key: string; outcome: BenchCollectOutcome; sampleId: string | null }> = [];
  const touchedOrders: string[] = [];
  const touchedSamples: string[] = [];
  const done = new Set<string>();
  for (const key of [...ids, ...codes]) {
    const row = byId.get(key) ?? byCode.get(key);
    if (!row) {
      outcomes.push({ key, outcome: 'not_found', sampleId: null });
      continue;
    }
    const s = row.s;
    let outcome: BenchCollectOutcome;
    if (done.has(s.id)) outcome = 'already_collected';
    else if (row.orderStatus === 'cancelled') outcome = 'order_cancelled';
    else if (s.status === 'rejected') outcome = 'rejected';
    else if (s.status !== 'pending') outcome = 'already_collected';
    else {
      await db().update(samples).set({ status: 'collected', collectedAt: now, collectedBy: userId }).where(eq(samples.id, s.id));
      await addEvent(s.id, 'collected', now);
      await audit({ action: 'sample.collect', entityType: 'sample', entityId: s.id, summary: s.barcode, before: { status: s.status }, after: { status: 'collected' } });
      touchedOrders.push(s.orderId);
      touchedSamples.push(s.id);
      done.add(s.id);
      outcome = 'collected';
    }
    outcomes.push({ key, outcome, sampleId: s.id });
  }
  await afterMoves(touchedOrders, touchedSamples);
  const loaded = await loadSamplesByIds(outcomes.map((o) => o.sampleId).filter((x): x is string => !!x));
  return { items: outcomes.map((o) => ({ key: o.key, outcome: o.outcome, sample: o.sampleId ? (loaded.get(o.sampleId) ?? null) : null })) };
}

/**
 * Receive tubes at the bench, one outcome per scanned barcode. Tubes not yet marked as
 * collected are refused while the lab requires the collection step.
 */
export async function receiveSamples(barcodes: string[], opts: MoveOptions = {}): Promise<BenchReceiveResult> {
  const { labId, userId } = ctx();
  const now = opts.at ?? new Date();
  const lab = await getLab(labId);
  const requireCollection = lab.settings.requireCollectionStep === true;
  const codes = [...new Set(barcodes.map((b) => b.trim()).filter(Boolean))];
  const rows = codes.length
    ? await db()
        .select({ s: samples, orderStatus: orders.status })
        .from(samples)
        .innerJoin(orders, eq(orders.id, samples.orderId))
        .where(inArray(samples.barcode, codes))
        .for('update', { of: samples })
    : [];
  const byCode = new Map(rows.map((r) => [r.s.barcode, r]));
  const outcomes: Array<{ barcode: string; outcome: BenchReceiveOutcome; sampleId: string | null }> = [];
  const touchedOrders: string[] = [];
  const touchedSamples: string[] = [];
  for (const barcode of codes) {
    const row = byCode.get(barcode);
    if (!row) {
      outcomes.push({ barcode, outcome: 'not_found', sampleId: null });
      continue;
    }
    const s = row.s;
    let outcome: BenchReceiveOutcome;
    if (row.orderStatus === 'cancelled') outcome = 'order_cancelled';
    else if (s.status === 'rejected') outcome = 'rejected';
    else if (s.status === 'pending' && requireCollection) outcome = 'not_collected';
    else if (s.status === 'pending' || s.status === 'collected' || s.status === 'in_transit') {
      const firstCollect = s.status === 'pending';
      await db()
        .update(samples)
        .set({
          status: 'received',
          receivedAt: now,
          receivedBy: userId,
          ...(firstCollect ? { collectedAt: s.collectedAt ?? now, collectedBy: s.collectedBy ?? userId } : {}),
        })
        .where(eq(samples.id, s.id));
      if (firstCollect) await addEvent(s.id, 'collected', now, { note: 'Collected at reception' });
      await addEvent(s.id, 'received', now, { from: s.status === 'in_transit' ? s.storageLocation : null });
      await audit({ action: 'sample.receive', entityType: 'sample', entityId: s.id, summary: s.barcode, before: { status: s.status }, after: { status: 'received' } });
      touchedOrders.push(s.orderId);
      touchedSamples.push(s.id);
      outcome = 'received';
    } else outcome = 'already_received';
    outcomes.push({ barcode, outcome, sampleId: s.id });
  }
  await afterMoves(touchedOrders, touchedSamples);
  const loaded = await loadSamplesByIds(outcomes.map((o) => o.sampleId).filter((x): x is string => !!x));
  return { items: outcomes.map((o) => ({ barcode: o.barcode, outcome: o.outcome, sample: o.sampleId ? (loaded.get(o.sampleId) ?? null) : null })) };
}

/**
 * Reject a tube. With `recollect`, a new tube (next number, linked by recollectOfId) takes over
 * the tube's tests, values already entered from the rejected tube are cleared, and the staff
 * who collect samples are told to draw again.
 */
export async function rejectSample(
  sampleId: string,
  input: { reasonId: string; note?: string | null; recollect?: boolean },
  opts: MoveOptions = {},
): Promise<BenchRejectResult> {
  const { labId, userId } = ctx();
  const now = opts.at ?? new Date();
  const s = await lockSample(sampleId);
  if (s.status === 'rejected') throw conflict('sample_already_rejected', 'The tube is already rejected');
  if (s.status === 'disposed') throw conflict('sample_disposed', 'The tube was disposed of');
  if (s.orderStatus === 'cancelled') throw conflict('order_cancelled', 'The order is cancelled');
  const [reason] = await db().select().from(rejectionReasons).where(eq(rejectionReasons.id, input.reasonId));
  if (!reason) throw badRequest('invalid_reason', 'Unknown rejection reason');
  const [locked] = await db()
    .select({ n: count() })
    .from(results)
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .where(and(eq(orderItems.sampleId, s.id), inArray(results.status, ['validated', 'released'])));
  if (Number(locked?.n ?? 0) > 0) throw conflict('sample_has_validated_results', 'Results from this tube are already validated');

  const note = input.note?.trim() || null;
  await db()
    .update(samples)
    .set({ status: 'rejected', rejectedAt: now, rejectedBy: userId, rejectionReasonId: reason.id, rejectionNote: note })
    .where(eq(samples.id, s.id));
  await addEvent(s.id, 'rejected', now, { note: note ? `${reason.code}: ${note}` : reason.code });
  await audit({
    action: 'sample.reject',
    entityType: 'sample',
    entityId: s.id,
    summary: `${s.barcode} · ${reason.nameEn}${input.recollect ? ' · recollect' : ''}`,
    before: { status: s.status },
    after: { status: 'rejected', reason: reason.code, note, recollect: !!input.recollect },
  });

  let replacementId: string | null = null;
  let replacementBarcode: string | null = null;
  if (input.recollect) {
    await db().select({ id: orders.id }).from(orders).where(eq(orders.id, s.orderId)).for('update');
    const [max] = await db()
      .select({ seq: sql<number>`coalesce(max(${samples.seq}), 0)` })
      .from(samples)
      .where(eq(samples.orderId, s.orderId));
    const seq = Number(max?.seq ?? 0) + 1;
    const [created] = await db()
      .insert(samples)
      .values({
        labId,
        orderId: s.orderId,
        barcode: tubeBarcode(s.accession, seq),
        seq,
        containerId: s.containerId,
        sampleTypeId: s.sampleTypeId,
        departmentId: s.departmentId,
        status: 'pending',
        recollectOfId: s.id,
        createdAt: now,
      })
      .returning({ id: samples.id, barcode: samples.barcode });
    replacementId = created!.id;
    replacementBarcode = created!.barcode;
    await addEvent(replacementId, 'created', now, { note: `Recollection of ${s.barcode}` });
    await addEvent(s.id, 'recollect_requested', now, { note: replacementBarcode });
    const moved = await db()
      .update(orderItems)
      .set({ sampleId: replacementId })
      .where(and(eq(orderItems.sampleId, s.id), ne(orderItems.status, 'cancelled')))
      .returning({ id: orderItems.id });
    if (moved.length) {
      const withValues = await db()
        .select({ id: results.id })
        .from(results)
        .where(and(inArray(results.orderItemId, moved.map((m) => m.id)), inArray(results.status, ['resulted', 'verified'])));
      for (const r of withValues) {
        await applyResultValue({ resultId: r.id, value: null, source: 'manual', note: `Tube ${s.barcode} rejected (${reason.code}); recollected as ${replacementBarcode}`, skipRefresh: true });
      }
    }
    await audit({
      action: 'sample.recollect',
      entityType: 'sample',
      entityId: replacementId,
      summary: `${replacementBarcode} replaces ${s.barcode}`,
      after: { recollectOfId: s.id, movedLines: moved.length },
    });
  }

  await notifyPermission('samples.collect', {
    kind: 'rejection',
    severity: 'warning',
    titleAr: input.recollect ? `سحب عينة جديدة: ${replacementBarcode}` : `عينة مرفوضة: ${s.barcode}`,
    titleEn: input.recollect ? `New sample needed: ${replacementBarcode}` : `Sample rejected: ${s.barcode}`,
    bodyAr: `${reason.nameAr}${note ? ` · ${note}` : ''} · الطلب ${s.accession}`,
    bodyEn: `${reason.nameEn}${note ? ` · ${note}` : ''} · order ${s.accession}`,
    link: `/orders/${s.orderId}?tube=${encodeURIComponent(replacementBarcode ?? s.barcode)}`,
    entityType: 'sample',
    entityId: replacementId ?? s.id,
  });

  await afterMoves([s.orderId], replacementId ? [s.id, replacementId] : [s.id]);
  const loaded = await loadSamplesByIds(replacementId ? [s.id, replacementId] : [s.id]);
  return { sample: loaded.get(s.id)!, recollect: replacementId ? (loaded.get(replacementId) ?? null) : null };
}

/** Send a tube elsewhere (to the main lab, another branch or a reference lab). Receiving it ends the transit. */
export async function transferSample(sampleId: string, input: { toLocation: string; note?: string | null }, opts: MoveOptions = {}): Promise<BenchSample> {
  const now = opts.at ?? new Date();
  const s = await lockSample(sampleId);
  if (!['collected', 'received', 'stored', 'in_analysis'].includes(s.status)) throw conflict('invalid_sample_status', `Cannot transfer a ${s.status} tube`);
  await db().update(samples).set({ status: 'in_transit' }).where(eq(samples.id, s.id));
  await addEvent(s.id, 'moved', now, { from: s.storageLocation, to: input.toLocation, note: input.note ?? null });
  await audit({
    action: 'sample.transfer',
    entityType: 'sample',
    entityId: s.id,
    summary: `${s.barcode} → ${input.toLocation}`,
    before: { status: s.status, location: s.storageLocation },
    after: { status: 'in_transit', to: input.toLocation },
  });
  await afterMoves([s.orderId], [s.id]);
  return getSample(s.id);
}

/** Put a tube in storage (rack, fridge, freezer), or move it to another place. */
export async function storeSample(sampleId: string, input: { location: string; note?: string | null }, opts: MoveOptions = {}): Promise<BenchSample> {
  const now = opts.at ?? new Date();
  const s = await lockSample(sampleId);
  if (!['received', 'in_analysis', 'stored'].includes(s.status)) throw conflict('invalid_sample_status', `Cannot store a ${s.status} tube`);
  await db().update(samples).set({ status: 'stored', storageLocation: input.location, storedAt: now }).where(eq(samples.id, s.id));
  await addEvent(s.id, 'stored', now, { from: s.storageLocation, to: input.location, note: input.note ?? null });
  await audit({
    action: 'sample.store',
    entityType: 'sample',
    entityId: s.id,
    summary: `${s.barcode} → ${input.location}`,
    before: { status: s.status, location: s.storageLocation },
    after: { status: 'stored', location: input.location },
  });
  await afterMoves([s.orderId], [s.id]);
  return getSample(s.id);
}

/**
 * Dispose of a tube once its work is done (every result validated or released). A rejected
 * tube keeps its "rejected" status so its lines still read as rejected; only the disposal time is set.
 */
export async function disposeSample(sampleId: string, input: { note?: string | null } = {}, opts: MoveOptions = {}): Promise<BenchSample> {
  const { userId } = ctx();
  const now = opts.at ?? new Date();
  const s = await lockSample(sampleId);
  if (s.disposedAt) throw conflict('sample_disposed', 'The tube was already disposed of');
  if (!['stored', 'rejected', 'received', 'in_analysis'].includes(s.status)) throw conflict('invalid_sample_status', `Cannot dispose of a ${s.status} tube`);
  if (s.status !== 'rejected') {
    const [open] = await db()
      .select({ n: count() })
      .from(results)
      .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
      .where(and(eq(orderItems.sampleId, s.id), ne(orderItems.status, 'cancelled'), notInArray(results.status, ['validated', 'released'])));
    if (Number(open?.n ?? 0) > 0) throw conflict('sample_in_use', 'Results from this tube are still being worked on');
  }
  const status = s.status === 'rejected' ? 'rejected' : 'disposed';
  await db().update(samples).set({ status, disposedAt: now, disposedBy: userId }).where(eq(samples.id, s.id));
  await addEvent(s.id, 'disposed', now, { from: s.storageLocation, note: input.note ?? null });
  await audit({ action: 'sample.dispose', entityType: 'sample', entityId: s.id, summary: s.barcode, before: { status: s.status }, after: { status, disposedAt: now } });
  await afterMoves([s.orderId], [s.id]);
  return getSample(s.id);
}

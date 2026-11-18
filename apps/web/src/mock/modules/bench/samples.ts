/**
 * Tubes from the phlebotomy chair to the fridge (port of apps/api/src/modules/samples):
 * collection queue, reception at the bench, rejection with recollection, transfer, storage,
 * disposal, tube events and the bench meta. Every move writes a sample_events row, then the
 * order's line statuses are recomputed.
 *
 * Mock mode accepts what is typed: an unknown rejection reason falls back to the lab's first
 * one, and empty locations or notes are simply left empty. The workflow rules stay (a rejected
 * tube is never received, validated work is never rejected).
 */
import {
  benchCollectInput,
  benchDisposeInput,
  benchReceiveInput,
  benchRejectInput,
  benchSampleListQuery,
  benchStoreInput,
  benchTransferInput,
} from '@natija/contracts';
import type {
  BenchCollectOutcome,
  BenchCollectResult,
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
import { tubeBarcode } from '@natija/domain';
import { conflict, ctx, notFound, now } from '../../core/context';
import { by, find, insert, rows, update, type Row } from '../../core/db';
import { audit, dayRange, getLab, notifyPermission, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { refreshOrderStatus } from '../shared/order-status';
import { applyResultValue } from '../shared/results-engine';
import { compareText, iso, orderRef, patientRef, priorityRank, searchFilter, userRef } from './shared';

type EventType = Row<'sampleEvents'>['type'];
export type MoveOptions = { at?: Date };

/* ------------------------------------------------------------------ reading */

function events(sampleId: string): BenchSampleEvent[] {
  return by('sampleEvents', 'sampleId', sampleId)
    .sort((x, y) => x.at.getTime() - y.at.getTime())
    .map((e) => ({
      id: e.id,
      type: e.type,
      at: e.at.toISOString(),
      user: userRef(e.userId),
      fromLocation: e.fromLocation,
      toLocation: e.toLocation,
      note: e.note,
    }));
}

/** A tube hydrated with its order, patient, container, tests, people and replacement tube. */
function toSample(s: Row<'samples'>, withEvents = false): BenchSample | null {
  const o = find('orders', s.orderId);
  const p = o ? find('patients', o.patientId) : undefined;
  const c = find('containers', s.containerId);
  const st = find('sampleTypes', s.sampleTypeId);
  if (!o || !p || !c || !st) return null;
  const d = s.departmentId ? find('departments', s.departmentId) : undefined;
  const rr = s.rejectionReasonId ? find('rejectionReasons', s.rejectionReasonId) : undefined;
  const tests = by('orderItems', 'sampleId', s.id)
    .filter((i) => i.status !== 'cancelled')
    .map((i) => ({ i, t: find('tests', i.testId) }))
    .filter((x): x is { i: Row<'orderItems'>; t: Row<'tests'> } => !!x.t)
    .sort((x, y) => x.t.sortOrder - y.t.sortOrder)
    .map(({ i, t }) => ({ orderItemId: i.id, testId: t.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn, status: i.status, departmentId: t.departmentId }));
  const replacement = by('samples', 'recollectOfId', s.id).at(-1);
  return {
    id: s.id,
    barcode: s.barcode,
    seq: s.seq,
    status: s.status,
    order: orderRef(o),
    patient: patientRef(p),
    container: { id: c.id, code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, capColor: c.capColor },
    sampleType: { id: st.id, code: st.code, nameAr: st.nameAr, nameEn: st.nameEn },
    department: d ? { id: d.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn } : null,
    tests,
    collectedAt: iso(s.collectedAt),
    collectedBy: userRef(s.collectedBy),
    receivedAt: iso(s.receivedAt),
    receivedBy: userRef(s.receivedBy),
    rejectedAt: iso(s.rejectedAt),
    rejectionReason: rr ? { id: rr.id, code: rr.code, nameAr: rr.nameAr, nameEn: rr.nameEn } : null,
    rejectionNote: s.rejectionNote,
    storedAt: iso(s.storedAt),
    disposedAt: iso(s.disposedAt),
    storageLocation: s.storageLocation,
    recollectOfId: s.recollectOfId,
    recollectedAs: replacement ? { id: replacement.id, barcode: replacement.barcode } : null,
    labelPrintedAt: iso(s.labelPrintedAt),
    createdAt: s.createdAt.toISOString(),
    ...(withEvents ? { events: events(s.id) } : {}),
  };
}

function samplesByIds(ids: string[]): Map<string, BenchSample> {
  const out = new Map<string, BenchSample>();
  for (const id of new Set(ids)) {
    const s = find('samples', id);
    const view = s ? toSample(s) : null;
    if (view) out.set(id, view);
  }
  return out;
}

/** A tube belongs to a department directly, or through one of its tests (shared tubes). */
function inDepartment(s: Row<'samples'>, departmentId: string): boolean {
  if (s.departmentId === departmentId) return true;
  return by('orderItems', 'sampleId', s.id).some((i) => find('tests', i.testId)?.departmentId === departmentId);
}

const DATE_COLUMNS = {
  created: (s: Row<'samples'>) => s.createdAt as Date | null,
  collected: (s: Row<'samples'>) => s.collectedAt,
  received: (s: Row<'samples'>) => s.receivedAt,
  rejected: (s: Row<'samples'>) => s.rejectedAt,
  stored: (s: Row<'samples'>) => s.storedAt,
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

/** Tubes for lists (reception tabs, storage, an order's tubes). */
export function listSamples(p: SampleListParams): { items: BenchSample[]; total: number } {
  const statuses = p.status?.length ? new Set<string>(p.status) : null;
  const range = p.from || p.to ? dayRange(p.from, p.to) : null;
  const dateOf = DATE_COLUMNS[p.dateBy ?? 'created'] ?? DATE_COLUMNS.created;
  const match = searchFilter(p.q);
  const source = p.orderId
    ? by('samples', 'orderId', p.orderId)
    : statuses
      ? [...statuses].flatMap((st) => by('samples', 'status', st as BenchSampleStatus))
      : rows('samples');
  const found: Array<{ s: Row<'samples'>; o: Row<'orders'> }> = [];
  for (const s of source) {
    if (statuses && !statuses.has(s.status)) continue;
    const o = find('orders', s.orderId);
    const pt = o ? find('patients', o.patientId) : undefined;
    if (!o || !pt) continue;
    if (!p.orderId && o.status === 'cancelled') continue;
    if (p.departmentId && !inDepartment(s, p.departmentId)) continue;
    if (range) {
      const at = dateOf(s);
      if (!at || at < range.start || at >= range.end) continue;
    }
    if (match && !match({ barcode: s.barcode, accession: o.accession, mrn: pt.mrn, searchText: pt.searchText })) continue;
    found.push({ s, o });
  }
  if (p.orderId) found.sort((x, y) => x.s.seq - y.s.seq);
  else {
    const sign = p.sort === 'asc' ? 1 : -1;
    const time = (s: Row<'samples'>) => (dateOf(s) ?? s.createdAt).getTime();
    found.sort((x, y) => priorityRank(x.o.priority) - priorityRank(y.o.priority) || sign * (time(x.s) - time(y.s)) || compareText(x.s.barcode, y.s.barcode));
  }
  const offset = p.offset ?? 0;
  const items = found
    .slice(offset, offset + (p.limit ?? 100))
    .map((x) => toSample(x.s, !!p.events))
    .filter((x): x is BenchSample => !!x);
  return { items, total: found.length };
}

/** Orders with tubes still to collect: STAT and urgent first, then the longest waiting. */
export function collectionQueue(p: { departmentId?: string; from?: string; to?: string; q?: string; limit?: number }): CollectionQueue {
  const range = p.from || p.to ? dayRange(p.from, p.to) : null;
  const match = searchFilter(p.q);
  const seen = new Set<string>();
  const orders: Row<'orders'>[] = [];
  for (const s of by('samples', 'status', 'pending')) {
    const o = find('orders', s.orderId);
    const pt = o ? find('patients', o.patientId) : undefined;
    if (!o || !pt || o.status === 'cancelled') continue;
    if (p.departmentId && !inDepartment(s, p.departmentId)) continue;
    if (range && (o.createdAt < range.start || o.createdAt >= range.end)) continue;
    if (match && !match({ barcode: s.barcode, accession: o.accession, mrn: pt.mrn, searchText: pt.searchText })) continue;
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    orders.push(o);
  }
  orders.sort((x, y) => priorityRank(x.priority) - priorityRank(y.priority) || x.createdAt.getTime() - y.createdAt.getTime());
  const chosen = orders.slice(0, p.limit ?? 200);
  if (!chosen.length) return { items: [], total: 0 };
  const items = chosen
    .map((o) =>
      by('samples', 'orderId', o.id)
        .filter((t) => t.status !== 'disposed')
        .sort((x, y) => x.seq - y.seq)
        .map((t) => toSample(t))
        .filter((x): x is BenchSample => !!x),
    )
    .filter((list) => list.length > 0)
    .map((list) => ({
      order: list[0]!.order,
      patient: list[0]!.patient,
      tubes: list,
      pendingCount: list.filter((t) => t.status === 'pending').length,
      totalCount: list.filter((t) => t.status !== 'rejected').length,
    }));
  return { items, total: orders.length };
}

export function getSampleByBarcode(barcode: string): BenchSample {
  const s = by('samples', 'barcode', barcode.trim())[0];
  const view = s ? toSample(s, true) : null;
  if (!view) throw notFound('sample_not_found');
  return view;
}

export function getSample(sampleId: string): BenchSample {
  const s = find('samples', sampleId);
  const view = s ? toSample(s, true) : null;
  if (!view) throw notFound('sample_not_found');
  return view;
}

export function getSampleEvents(sampleId: string): BenchSampleEvent[] {
  if (!find('samples', sampleId)) throw notFound('sample_not_found');
  return events(sampleId);
}

function byCreated<T extends { createdAt: Date; code: string }>(list: readonly T[]): T[] {
  return [...list].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.code.localeCompare(y.code));
}

export function getBenchMeta(myDepartmentIds: string[]): BenchMeta {
  const lab = getLab();
  return {
    departments: [...rows('departments')]
      .sort((x, y) => x.sortOrder - y.sortOrder || x.code.localeCompare(y.code))
      .map((d) => ({ id: d.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn, sortOrder: d.sortOrder })),
    containers: byCreated(rows('containers')).map((c) => ({ id: c.id, code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, capColor: c.capColor })),
    sampleTypes: byCreated(rows('sampleTypes')).map((t) => ({ id: t.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn })),
    rejectionReasons: byCreated(rows('rejectionReasons')).map((r) => ({ id: r.id, code: r.code, nameAr: r.nameAr, nameEn: r.nameEn })),
    instruments: rows('instruments')
      .filter((i) => i.isActive)
      .sort((x, y) => x.code.localeCompare(y.code))
      .map((i) => ({ id: i.id, code: i.code, name: i.name, departmentId: i.departmentId, status: i.status })),
    myDepartmentIds,
    settings: {
      requireCollectionStep: lab.settings.requireCollectionStep === true,
      segregationOfDuties: lab.settings.segregationOfDuties === true,
      reportLanguage: (lab.settings.reportLanguage ?? 'bilingual') as ReportLanguage,
    },
  };
}

/* ------------------------------------------------------------------ moves */

function addEvent(sampleId: string, type: EventType, at: Date, extra: { note?: string | null; from?: string | null; to?: string | null } = {}): void {
  insert('sampleEvents', { sampleId, type, at, userId: ctx().userId, note: extra.note ?? null, fromLocation: extra.from ?? null, toLocation: extra.to ?? null });
}

function afterMoves(orderIds: Iterable<string>, sampleIds: string[]): void {
  const unique = [...new Set(orderIds)];
  for (const orderId of unique) refreshOrderStatus(orderId);
  if (sampleIds.length) publish({ type: 'samples.changed', data: { orderIds: unique, sampleIds } });
}

function lockSample(sampleId: string): { s: Row<'samples'>; o: Row<'orders'> } {
  const s = find('samples', sampleId);
  const o = s ? find('orders', s.orderId) : undefined;
  if (!s || !o) throw notFound('sample_not_found');
  return { s, o };
}

/** Mark tubes as drawn (by id from the queue, or by barcode from the scan box). */
export function collectSamples(input: { sampleIds?: string[]; barcodes?: string[] }, opts: MoveOptions = {}): BenchCollectResult {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const ids = [...new Set(input.sampleIds ?? [])];
  const codes = [...new Set((input.barcodes ?? []).map((b) => String(b).trim()).filter(Boolean))];
  const lookup = (key: string) => find('samples', key) ?? by('samples', 'barcode', key)[0];

  const outcomes: Array<{ key: string; outcome: BenchCollectOutcome; sampleId: string | null }> = [];
  const touchedOrders: string[] = [];
  const touchedSamples: string[] = [];
  const done = new Set<string>();
  for (const key of [...ids, ...codes]) {
    const s = lookup(key);
    const o = s ? find('orders', s.orderId) : undefined;
    if (!s || !o) {
      outcomes.push({ key, outcome: 'not_found', sampleId: null });
      continue;
    }
    let outcome: BenchCollectOutcome;
    if (done.has(s.id)) outcome = 'already_collected';
    else if (o.status === 'cancelled') outcome = 'order_cancelled';
    else if (s.status === 'rejected') outcome = 'rejected';
    else if (s.status !== 'pending') outcome = 'already_collected';
    else {
      const before = s.status;
      update('samples', s, { status: 'collected', collectedAt: at, collectedBy: userId });
      addEvent(s.id, 'collected', at);
      audit({ action: 'sample.collect', entityType: 'sample', entityId: s.id, summary: s.barcode, before: { status: before }, after: { status: 'collected' } });
      touchedOrders.push(s.orderId);
      touchedSamples.push(s.id);
      done.add(s.id);
      outcome = 'collected';
    }
    outcomes.push({ key, outcome, sampleId: s.id });
  }
  afterMoves(touchedOrders, touchedSamples);
  const loaded = samplesByIds(outcomes.map((o) => o.sampleId).filter((x): x is string => !!x));
  return { items: outcomes.map((o) => ({ key: o.key, outcome: o.outcome, sample: o.sampleId ? (loaded.get(o.sampleId) ?? null) : null })) };
}

/**
 * Receive tubes at the bench, one outcome per scanned barcode. Tubes not yet marked as
 * collected are refused while the lab requires the collection step; rejected tubes never.
 */
export function receiveSamples(barcodes: string[], opts: MoveOptions = {}): BenchReceiveResult {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const requireCollection = getLab().settings.requireCollectionStep === true;
  const codes = [...new Set((barcodes ?? []).map((b) => String(b).trim()).filter(Boolean))];
  const outcomes: Array<{ barcode: string; outcome: BenchReceiveOutcome; sampleId: string | null }> = [];
  const touchedOrders: string[] = [];
  const touchedSamples: string[] = [];
  for (const barcode of codes) {
    const s = by('samples', 'barcode', barcode)[0];
    const o = s ? find('orders', s.orderId) : undefined;
    if (!s || !o) {
      outcomes.push({ barcode, outcome: 'not_found', sampleId: null });
      continue;
    }
    let outcome: BenchReceiveOutcome;
    if (o.status === 'cancelled') outcome = 'order_cancelled';
    else if (s.status === 'rejected') outcome = 'rejected';
    else if (s.status === 'pending' && requireCollection) outcome = 'not_collected';
    else if (s.status === 'pending' || s.status === 'collected' || s.status === 'in_transit') {
      const before = s.status;
      const firstCollect = before === 'pending';
      const from = before === 'in_transit' ? s.storageLocation : null;
      update('samples', s, {
        status: 'received',
        receivedAt: at,
        receivedBy: userId,
        ...(firstCollect ? { collectedAt: s.collectedAt ?? at, collectedBy: s.collectedBy ?? userId } : {}),
      });
      if (firstCollect) addEvent(s.id, 'collected', at, { note: 'Collected at reception' });
      addEvent(s.id, 'received', at, { from });
      audit({ action: 'sample.receive', entityType: 'sample', entityId: s.id, summary: s.barcode, before: { status: before }, after: { status: 'received' } });
      touchedOrders.push(s.orderId);
      touchedSamples.push(s.id);
      outcome = 'received';
    } else outcome = 'already_received';
    outcomes.push({ barcode, outcome, sampleId: s.id });
  }
  afterMoves(touchedOrders, touchedSamples);
  const loaded = samplesByIds(outcomes.map((o) => o.sampleId).filter((x): x is string => !!x));
  return { items: outcomes.map((o) => ({ barcode: o.barcode, outcome: o.outcome, sample: o.sampleId ? (loaded.get(o.sampleId) ?? null) : null })) };
}

/**
 * Reject a tube. With `recollect`, a new tube (next number, linked by recollectOfId) takes over
 * the tube's tests, values already entered from the rejected tube are cleared, and the staff
 * who collect samples are told to draw again.
 */
export function rejectSample(
  sampleId: string,
  input: { reasonId: string; note?: string | null; recollect?: boolean },
  opts: MoveOptions = {},
): BenchRejectResult {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const { s, o } = lockSample(sampleId);
  if (s.status === 'rejected') throw conflict('sample_already_rejected', 'The tube is already rejected');
  if (s.status === 'disposed') throw conflict('sample_disposed', 'The tube was disposed of');
  if (o.status === 'cancelled') throw conflict('order_cancelled', 'The order is cancelled');
  // Mock mode: an unknown reason is not refused; the lab's first reason stands in for it.
  const reason = find('rejectionReasons', input.reasonId) ?? byCreated(rows('rejectionReasons'))[0] ?? null;
  const reasonCode = reason?.code ?? 'OTHER';
  const lines = by('orderItems', 'sampleId', s.id);
  const locked = lines.some((i) => by('results', 'orderItemId', i.id).some((r) => r.status === 'validated' || r.status === 'released'));
  if (locked) throw conflict('sample_has_validated_results', 'Results from this tube are already validated');

  const before = s.status;
  const note = input.note?.trim() || null;
  update('samples', s, { status: 'rejected', rejectedAt: at, rejectedBy: userId, rejectionReasonId: reason?.id ?? null, rejectionNote: note });
  addEvent(s.id, 'rejected', at, { note: note ? `${reasonCode}: ${note}` : reasonCode });
  audit({
    action: 'sample.reject',
    entityType: 'sample',
    entityId: s.id,
    summary: `${s.barcode} · ${reason?.nameEn ?? reasonCode}${input.recollect ? ' · recollect' : ''}`,
    before: { status: before },
    after: { status: 'rejected', reason: reasonCode, note, recollect: !!input.recollect },
  });

  let replacement: Row<'samples'> | null = null;
  if (input.recollect) {
    const seq = by('samples', 'orderId', s.orderId).reduce((m, x) => Math.max(m, x.seq), 0) + 1;
    replacement = insert('samples', {
      orderId: s.orderId,
      barcode: tubeBarcode(o.accession, seq),
      seq,
      containerId: s.containerId,
      sampleTypeId: s.sampleTypeId,
      departmentId: s.departmentId,
      status: 'pending',
      recollectOfId: s.id,
      createdAt: at,
    });
    addEvent(replacement.id, 'created', at, { note: `Recollection of ${s.barcode}` });
    addEvent(s.id, 'recollect_requested', at, { note: replacement.barcode });
    const moved = lines.filter((i) => i.status !== 'cancelled');
    for (const item of moved) update('orderItems', item, { sampleId: replacement.id });
    for (const item of moved) {
      for (const r of by('results', 'orderItemId', item.id)) {
        if (r.status !== 'resulted' && r.status !== 'verified') continue;
        applyResultValue({ resultId: r.id, value: null, source: 'manual', note: `Tube ${s.barcode} rejected (${reasonCode}); recollected as ${replacement.barcode}`, skipRefresh: true });
      }
    }
    audit({
      action: 'sample.recollect',
      entityType: 'sample',
      entityId: replacement.id,
      summary: `${replacement.barcode} replaces ${s.barcode}`,
      after: { recollectOfId: s.id, movedLines: moved.length },
    });
  }

  const shown = replacement?.barcode ?? s.barcode;
  notifyPermission('samples.collect', {
    kind: 'rejection',
    severity: 'warning',
    titleAr: replacement ? `سحب عينة جديدة: ${replacement.barcode}` : `عينة مرفوضة: ${s.barcode}`,
    titleEn: replacement ? `New sample needed: ${replacement.barcode}` : `Sample rejected: ${s.barcode}`,
    bodyAr: `${reason?.nameAr ?? reasonCode}${note ? ` · ${note}` : ''} · الطلب ${o.accession}`,
    bodyEn: `${reason?.nameEn ?? reasonCode}${note ? ` · ${note}` : ''} · order ${o.accession}`,
    link: `/orders/${s.orderId}?tube=${encodeURIComponent(shown)}`,
    entityType: 'sample',
    entityId: replacement?.id ?? s.id,
  });

  const ids = replacement ? [s.id, replacement.id] : [s.id];
  afterMoves([s.orderId], ids);
  const loaded = samplesByIds(ids);
  return { sample: loaded.get(s.id)!, recollect: replacement ? (loaded.get(replacement.id) ?? null) : null };
}

/** Send a tube elsewhere (to the main lab, another branch or a reference lab). Receiving it ends the transit. */
export function transferSample(sampleId: string, input: { toLocation: string; note?: string | null }, opts: MoveOptions = {}): BenchSample {
  const at = opts.at ?? now();
  const { s } = lockSample(sampleId);
  if (!['collected', 'received', 'stored', 'in_analysis'].includes(s.status)) throw conflict('invalid_sample_status', `Cannot transfer a ${s.status} tube`);
  const before = { status: s.status, location: s.storageLocation };
  const to = input.toLocation?.trim() || null;
  update('samples', s, { status: 'in_transit' });
  addEvent(s.id, 'moved', at, { from: before.location, to, note: input.note ?? null });
  audit({
    action: 'sample.transfer',
    entityType: 'sample',
    entityId: s.id,
    summary: `${s.barcode} → ${to ?? ''}`,
    before,
    after: { status: 'in_transit', to },
  });
  afterMoves([s.orderId], [s.id]);
  return getSample(s.id);
}

/** Put a tube in storage (rack, fridge, freezer), or move it to another place. */
export function storeSample(sampleId: string, input: { location: string; note?: string | null }, opts: MoveOptions = {}): BenchSample {
  const at = opts.at ?? now();
  const { s } = lockSample(sampleId);
  if (!['received', 'in_analysis', 'stored'].includes(s.status)) throw conflict('invalid_sample_status', `Cannot store a ${s.status} tube`);
  const before = { status: s.status, location: s.storageLocation };
  const location = input.location?.trim() || null;
  update('samples', s, { status: 'stored', storageLocation: location, storedAt: at });
  addEvent(s.id, 'stored', at, { from: before.location, to: location, note: input.note ?? null });
  audit({
    action: 'sample.store',
    entityType: 'sample',
    entityId: s.id,
    summary: `${s.barcode} → ${location ?? ''}`,
    before,
    after: { status: 'stored', location },
  });
  afterMoves([s.orderId], [s.id]);
  return getSample(s.id);
}

/**
 * Dispose of a tube once its work is done (every result validated or released). A rejected
 * tube keeps its "rejected" status so its lines still read as rejected; only the disposal time is set.
 */
export function disposeSample(sampleId: string, input: { note?: string | null } = {}, opts: MoveOptions = {}): BenchSample {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const { s } = lockSample(sampleId);
  if (s.disposedAt) throw conflict('sample_disposed', 'The tube was already disposed of');
  if (!['stored', 'rejected', 'received', 'in_analysis'].includes(s.status)) throw conflict('invalid_sample_status', `Cannot dispose of a ${s.status} tube`);
  if (s.status !== 'rejected') {
    const open = by('orderItems', 'sampleId', s.id)
      .filter((i) => i.status !== 'cancelled')
      .some((i) => by('results', 'orderItemId', i.id).some((r) => r.status !== 'validated' && r.status !== 'released'));
    if (open) throw conflict('sample_in_use', 'Results from this tube are still being worked on');
  }
  const before = s.status;
  const status = before === 'rejected' ? 'rejected' : 'disposed';
  update('samples', s, { status, disposedAt: at, disposedBy: userId });
  addEvent(s.id, 'disposed', at, { from: s.storageLocation, note: input.note ?? null });
  audit({ action: 'sample.dispose', entityType: 'sample', entityId: s.id, summary: s.barcode, before: { status: before }, after: { status, disposedAt: at.toISOString() } });
  afterMoves([s.orderId], [s.id]);
  return getSample(s.id);
}

/* ------------------------------------------------------------------ routes (/samples) */

const READ = ['samples.collect', 'samples.receive', 'samples.reject', 'samples.store', 'orders.read', 'results.read'];

export function registerSamples(): void {
  route('GET', '/samples/meta', { perm: [...READ, 'results.enter'] }, (req) => getBenchMeta(req.auth!.user.departmentIds));

  route('GET', '/samples', { perm: READ }, (req) => {
    const q = parse(benchSampleListQuery, req.query);
    if (q.view === 'collection') return collectionQueue({ departmentId: q.departmentId, from: q.from, to: q.to, q: q.q, limit: q.limit });
    return listSamples(q);
  });

  route('GET', '/samples/by-barcode/:barcode', { perm: READ }, (req) => getSampleByBarcode(req.params.barcode ?? ''));

  route('GET', '/samples/:id/events', { perm: READ }, (req) => ({ items: getSampleEvents(req.params.id!) }));

  route('POST', '/samples/collect', { perm: 'samples.collect' }, (req) => collectSamples(parse(benchCollectInput, req.body)));

  route('POST', '/samples/receive', { perm: 'samples.receive' }, (req) => receiveSamples(parse(benchReceiveInput, req.body).barcodes ?? []));

  route('POST', '/samples/:id/reject', { perm: 'samples.reject' }, (req) => rejectSample(req.params.id!, parse(benchRejectInput, req.body)));

  route('POST', '/samples/:id/transfer', { perm: ['samples.store', 'samples.collect', 'samples.receive'] }, (req) =>
    transferSample(req.params.id!, parse(benchTransferInput, req.body)),
  );

  route('POST', '/samples/:id/store', { perm: 'samples.store' }, (req) => storeSample(req.params.id!, parse(benchStoreInput, req.body)));

  route('POST', '/samples/:id/dispose', { perm: 'samples.store' }, (req) => disposeSample(req.params.id!, parse(benchDisposeInput, req.body)));
}

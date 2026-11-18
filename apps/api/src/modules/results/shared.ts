/**
 * Helpers shared by the bench modules (samples, worklists, results, reports): row selection
 * for results with their test, order and patient, mapping to the API shapes, previous values,
 * user names and the per-user department restriction.
 */
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  analytes,
  criticalCalls,
  instruments,
  orderItems,
  orders,
  patients,
  resultAttempts,
  results,
  samples,
  testAnalytes,
  tests,
  users,
} from '@natija/db';
import type { BenchFlag, BenchOrderRef, BenchPatient, BenchResult, BenchResultSource, BenchResultStatus, BenchUserRef } from '@natija/contracts';
import { formatValue } from '@natija/domain';
import { db } from '../../db';
import { forbidden } from '../../lib/errors';

/**
 * Run queries one after another and collect their results, like Promise.all. A transaction
 * has one connection, and node-postgres no longer accepts overlapping queries on a client.
 */
export async function inSequence<T extends readonly unknown[]>(tasks: readonly [...{ [K in keyof T]: () => PromiseLike<T[K]> }]): Promise<T> {
  const out: unknown[] = [];
  for (const task of tasks) out.push(await task());
  return out as unknown as T;
}

/* ------------------------------------------------------------------ small mappers */

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Stat first, then urgent, then routine. */
export const priorityRank = sql<number>`case ${orders.priority} when 'stat' then 0 when 'urgent' then 1 else 2 end`;
export const PRIORITY_ORDER: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };

export const orderCols = {
  id: orders.id,
  accession: orders.accession,
  dailyNo: orders.dailyNo,
  priority: orders.priority,
  status: orders.status,
  createdAt: orders.createdAt,
  fasting: orders.fasting,
  pregnant: orders.pregnant,
  clinicalInfo: orders.clinicalInfo,
  notes: orders.notes,
  patientId: orders.patientId,
  doctorId: orders.doctorId,
  referralClinic: orders.referralClinic,
};
export type OrderColsRow = {
  id: string;
  accession: string;
  dailyNo: number;
  priority: 'routine' | 'urgent' | 'stat';
  status: string;
  createdAt: Date;
  fasting: boolean;
  pregnant: boolean;
  clinicalInfo: string | null;
  notes: string | null;
};

export const patientCols = {
  id: patients.id,
  mrn: patients.mrn,
  fullNameAr: patients.fullNameAr,
  fullNameEn: patients.fullNameEn,
  sex: patients.sex,
  birthDate: patients.birthDate,
  phone: patients.phone,
};
export type PatientColsRow = {
  id: string;
  mrn: string;
  fullNameAr: string;
  fullNameEn: string | null;
  sex: 'male' | 'female';
  birthDate: string;
  phone: string | null;
};

export function orderRef(o: OrderColsRow): BenchOrderRef {
  return {
    id: o.id,
    accession: o.accession,
    dailyNo: o.dailyNo,
    priority: o.priority,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    fasting: o.fasting,
    pregnant: o.pregnant,
    clinicalInfo: o.clinicalInfo,
    notes: o.notes,
  };
}

export function patientRef(p: PatientColsRow): BenchPatient {
  return { id: p.id, mrn: p.mrn, fullNameAr: p.fullNameAr, fullNameEn: p.fullNameEn, sex: p.sex, birthDate: p.birthDate, phone: p.phone };
}

/** Value as printed: the analyte's decimals, keeping a "<" / ">" qualifier typed with it. */
export function displayValue(valueNum: number | null | undefined, valueText: string | null | undefined, decimals: number): string | null {
  if (valueNum !== null && valueNum !== undefined && !Number.isNaN(valueNum)) {
    const qualifier = /^\s*([<>]=?)/.exec(valueText ?? '')?.[1];
    const v = formatValue(valueNum, decimals);
    return qualifier ? `${qualifier} ${v}` : v;
  }
  const t = valueText?.trim();
  return t ? t : null;
}

export async function loadUserRefs(ids: Array<string | null | undefined>): Promise<Map<string, BenchUserRef>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db()
    .select({ id: users.id, fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn, title: users.title })
    .from(users)
    .where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Refuse when a restricted user touches a department outside their list (empty list = all). */
export function assertDepartments(departmentIds: Array<string | null>, allowed: string[] | undefined): void {
  if (!allowed?.length) return;
  if (departmentIds.some((d) => !d || !allowed.includes(d))) throw forbidden('department_not_allowed', 'This department is outside your assignment');
}

/* ------------------------------------------------------------------ result rows */

const resultRowSelect = {
  r: results,
  a: {
    id: analytes.id,
    code: analytes.code,
    nameAr: analytes.nameAr,
    nameEn: analytes.nameEn,
    unit: analytes.unit,
    resultType: analytes.resultType,
    decimals: analytes.decimals,
    options: analytes.options,
    formula: analytes.formula,
    sortOrder: analytes.sortOrder,
  },
  t: {
    id: tests.id,
    code: tests.code,
    nameAr: tests.nameAr,
    nameEn: tests.nameEn,
    reportNameAr: tests.reportNameAr,
    reportNameEn: tests.reportNameEn,
    departmentId: tests.departmentId,
    sortOrder: tests.sortOrder,
    method: tests.method,
  },
  item: { id: orderItems.id, status: orderItems.status, sampleId: orderItems.sampleId },
  o: orderCols,
  p: patientCols,
  s: {
    id: samples.id,
    barcode: samples.barcode,
    status: samples.status,
    receivedAt: samples.receivedAt,
    collectedAt: samples.collectedAt,
    containerId: samples.containerId,
    sampleTypeId: samples.sampleTypeId,
  },
  analyteSort: testAnalytes.sortOrder,
};

export type ResultRow = {
  r: typeof results.$inferSelect;
  a: { id: string; code: string; nameAr: string; nameEn: string; unit: string | null; resultType: 'numeric' | 'text' | 'option' | 'calculated'; decimals: number; options: string[]; formula: string | null; sortOrder: number };
  t: { id: string; code: string; nameAr: string; nameEn: string; reportNameAr: string | null; reportNameEn: string | null; departmentId: string; sortOrder: number; method: string | null };
  item: { id: string; status: string; sampleId: string | null };
  o: OrderColsRow & { patientId: string; doctorId: string | null; referralClinic: string | null };
  p: PatientColsRow;
  s: { id: string; barcode: string; status: string; receivedAt: Date | null; collectedAt: Date | null; containerId: string; sampleTypeId: string } | null;
  analyteSort: number | null;
};

/** Results joined to their analyte, test, order line, order, patient and tube. */
export async function selectResultRows(where: SQL | undefined, opts: { forUpdate?: boolean } = {}): Promise<ResultRow[]> {
  const base = db()
    .select(resultRowSelect)
    .from(results)
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .innerJoin(analytes, eq(analytes.id, results.analyteId))
    .innerJoin(orders, eq(orders.id, results.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .leftJoin(samples, eq(samples.id, orderItems.sampleId))
    .leftJoin(testAnalytes, and(eq(testAnalytes.testId, tests.id), eq(testAnalytes.analyteId, results.analyteId)))
    .where(where)
    .$dynamic();
  const rows = opts.forUpdate ? await base.for('update', { of: results }) : await base;
  return rows as ResultRow[];
}

/** Display order inside an order: test order, then the analyte's place in the test. */
export function compareResultRows(x: ResultRow, y: ResultRow): number {
  return (
    x.t.sortOrder - y.t.sortOrder ||
    x.t.code.localeCompare(y.t.code) ||
    (x.analyteSort ?? x.a.sortOrder) - (y.analyteSort ?? y.a.sortOrder) ||
    x.a.code.localeCompare(y.a.code)
  );
}

type PreviousValue = { value: string | null; valueNum: number | null; at: Date; flag: BenchFlag | null };

/**
 * The patient's previous result for each row's analyte, from an earlier order.
 * `statuses` decides what counts (released only on reports; validated too at the bench).
 */
export async function previousValues(
  rows: Array<{ resultId: string; patientId: string; analyteId: string; orderId: string; orderCreatedAt: Date; decimals: number }>,
  statuses: BenchResultStatus[] = ['validated', 'released'],
): Promise<Map<string, PreviousValue>> {
  const out = new Map<string, PreviousValue>();
  if (!rows.length) return out;
  const patientIds = [...new Set(rows.map((r) => r.patientId))];
  const analyteIds = [...new Set(rows.map((r) => r.analyteId))];
  const history = await db()
    .select({
      patientId: orders.patientId,
      analyteId: results.analyteId,
      orderId: results.orderId,
      at: orders.createdAt,
      valueNum: results.valueNum,
      valueText: results.valueText,
      flag: results.flag,
    })
    .from(results)
    .innerJoin(orders, eq(orders.id, results.orderId))
    .where(and(inArray(orders.patientId, patientIds), inArray(results.analyteId, analyteIds), inArray(results.status, statuses)))
    .orderBy(desc(orders.createdAt))
    .limit(5000);
  const byKey = new Map<string, typeof history>();
  for (const h of history) {
    const k = `${h.patientId}|${h.analyteId}`;
    const list = byKey.get(k) ?? [];
    list.push(h);
    byKey.set(k, list);
  }
  for (const row of rows) {
    const list = byKey.get(`${row.patientId}|${row.analyteId}`) ?? [];
    const prev = list.find((h) => h.orderId !== row.orderId && h.at < row.orderCreatedAt && (h.valueNum !== null || (h.valueText ?? '') !== ''));
    if (prev) {
      out.set(row.resultId, {
        value: displayValue(prev.valueNum, prev.valueText, row.decimals),
        valueNum: prev.valueNum,
        at: prev.at,
        flag: (prev.flag as BenchFlag | null) ?? null,
      });
    }
  }
  return out;
}

/** Map joined rows to the API result shape, with users, instruments, attempts, calls and previous values. */
export async function toBenchResults(rows: ResultRow[], opts: { previous?: boolean } = {}): Promise<BenchResult[]> {
  if (!rows.length) return [];
  const ids = rows.map((x) => x.r.id);
  const selectedIds = rows.map((x) => x.r.selectedAttemptId).filter((x): x is string => !!x);
  const instrumentIds = [...new Set(rows.map((x) => x.r.instrumentId).filter((x): x is string => !!x))];

  const [attemptCounts, selected, instrumentRows, calls, userMap, prev] = await inSequence([
    () => db()
      .select({ resultId: resultAttempts.resultId, n: count() })
      .from(resultAttempts)
      .where(inArray(resultAttempts.resultId, ids))
      .groupBy(resultAttempts.resultId),
    () => selectedIds.length
      ? db().select({ id: resultAttempts.id, source: resultAttempts.source }).from(resultAttempts).where(inArray(resultAttempts.id, selectedIds))
      : Promise.resolve([] as Array<{ id: string; source: BenchResultSource }>),
    () => instrumentIds.length
      ? db().select({ id: instruments.id, code: instruments.code, name: instruments.name }).from(instruments).where(inArray(instruments.id, instrumentIds))
      : Promise.resolve([] as Array<{ id: string; code: string; name: string }>),
    () => db().selectDistinct({ resultId: criticalCalls.resultId }).from(criticalCalls).where(inArray(criticalCalls.resultId, ids)),
    () => loadUserRefs(rows.flatMap((x) => [x.r.enteredBy, x.r.verifiedBy, x.r.validatedBy])),
    () => opts.previous === false
      ? Promise.resolve(new Map<string, PreviousValue>())
      : previousValues(
          rows.map((x) => ({ resultId: x.r.id, patientId: x.o.patientId, analyteId: x.a.id, orderId: x.o.id, orderCreatedAt: x.o.createdAt, decimals: x.a.decimals })),
          ['validated', 'released'],
        ),
  ]);
  const attempts = new Map(attemptCounts.map((x) => [x.resultId, Number(x.n)]));
  const sources = new Map(selected.map((x) => [x.id, x.source]));
  const instrumentMap = new Map(instrumentRows.map((x) => [x.id, x]));
  const called = new Set(calls.map((x) => x.resultId));

  return rows.map(({ r, a, t }) => {
    const n = attempts.get(r.id) ?? 0;
    const p = prev.get(r.id);
    return {
      id: r.id,
      orderId: r.orderId,
      orderItemId: r.orderItemId,
      analyte: { id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, unit: a.unit, resultType: a.resultType, decimals: a.decimals, options: a.options },
      test: { id: t.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn, departmentId: t.departmentId },
      status: r.status as BenchResultStatus,
      value: displayValue(r.valueNum, r.valueText, a.decimals),
      valueNum: r.valueNum,
      valueText: r.valueText,
      unit: r.unit ?? a.unit,
      flag: (r.flag as BenchFlag | null) ?? null,
      isCritical: r.isCritical,
      deltaFlag: r.deltaFlag,
      refText: r.refText,
      refLow: r.refLow,
      refHigh: r.refHigh,
      previous: p ? { value: p.value, at: p.at.toISOString(), flag: p.flag } : null,
      comment: r.comment,
      source: r.selectedAttemptId ? (sources.get(r.selectedAttemptId) ?? null) : null,
      instrument: r.instrumentId ? (instrumentMap.get(r.instrumentId) ?? null) : null,
      attempts: n,
      rerunRequested: r.status === 'pending' && n > 0,
      enteredAt: iso(r.enteredAt),
      enteredBy: r.enteredBy ? (userMap.get(r.enteredBy) ?? null) : null,
      verifiedAt: iso(r.verifiedAt),
      verifiedBy: r.verifiedBy ? (userMap.get(r.verifiedBy) ?? null) : null,
      validatedAt: iso(r.validatedAt),
      validatedBy: r.validatedBy ? (userMap.get(r.validatedBy) ?? null) : null,
      releasedAt: iso(r.releasedAt),
      amended: r.amended,
      version: r.version,
      criticalCalled: called.has(r.id),
    };
  });
}

/** Load results by id in display order (404-safe: missing ids are simply absent). */
export async function loadBenchResults(ids: string[], opts: { previous?: boolean } = {}): Promise<BenchResult[]> {
  if (!ids.length) return [];
  const rows = await selectResultRows(inArray(results.id, ids));
  rows.sort(compareResultRows);
  return toBenchResults(rows, opts);
}

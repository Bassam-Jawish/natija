/**
 * Helpers shared by the bench modules (port of apps/api/src/modules/results/shared.ts): result
 * rows joined to their analyte, test, order line, order, patient and tube; mapping to the API
 * shapes; previous values; user names; the per-user department restriction; and the search the
 * lists use. Also the browser stand-ins for the server's sha256 and random tokens.
 *
 * Rows come back in insertion order, which plays the part of the server's time-ordered uuidv7
 * ids wherever the server breaks ties by id: sorts here are stable.
 */
import type { BenchFlag, BenchOrderRef, BenchPatient, BenchResult, BenchResultStatus, BenchUserRef } from '@natija/contracts';
import { formatValue, normalizeText } from '@natija/domain';
import { forbidden, withContext, type MockContext } from '../../core/context';
import { by, find, rows, type Row } from '../../core/db';

/* ------------------------------------------------------------------ small mappers */

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Stat first, then urgent, then routine. */
export const PRIORITY_ORDER: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };

export function priorityRank(priority: string): number {
  return PRIORITY_ORDER[priority] ?? 2;
}

export function orderRef(o: Row<'orders'>): BenchOrderRef {
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

export function patientRef(p: Row<'patients'>): BenchPatient {
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

export function userRef(id: string | null | undefined): BenchUserRef | null {
  const u = id ? find('users', id) : undefined;
  return u ? { id: u.id, fullNameAr: u.fullNameAr, fullNameEn: u.fullNameEn, title: u.title } : null;
}

/** Refuse when a restricted user touches a department outside their list (empty list = all). */
export function assertDepartments(departmentIds: Array<string | null>, allowed: string[] | undefined): void {
  if (!allowed?.length) return;
  if (departmentIds.some((d) => !d || !allowed.includes(d))) throw forbidden('department_not_allowed', 'This department is outside your assignment');
}

/** Newest first by a time, ties newest-inserted first (the server's `desc(at), desc(id)`). */
export function newestFirst<T>(list: readonly T[], at: (x: T) => Date): T[] {
  return [...list].reverse().sort((x, y) => at(y).getTime() - at(x).getTime());
}

export function compareText(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/* ------------------------------------------------------------------ search */

export type SearchFields = { barcode?: string | null; accession: string; mrn: string; searchText: string | null };

/**
 * The lists' search box: barcode / order number / MRN by prefix, or a piece of the patient's
 * normalised name. Null when there is nothing to search for.
 */
export function searchFilter(q: string | null | undefined): ((f: SearchFields) => boolean) | null {
  const raw = (q ?? '').trim();
  if (!raw) return null;
  const term = normalizeText(raw).replace(/[%_]/g, '');
  const prefix = raw.replace(/[%_]/g, '').toLowerCase();
  return (f) =>
    (!!f.barcode && f.barcode.toLowerCase().startsWith(prefix)) ||
    f.accession.toLowerCase().startsWith(prefix) ||
    f.mrn.toLowerCase().startsWith(prefix) ||
    (!!term && (f.searchText ?? '').toLowerCase().includes(term));
}

/* ------------------------------------------------------------------ result rows */

export type ResultRow = {
  r: Row<'results'>;
  a: Row<'analytes'>;
  t: Row<'tests'>;
  item: Row<'orderItems'>;
  o: Row<'orders'>;
  p: Row<'patients'>;
  s: Row<'samples'> | null;
  analyteSort: number | null;
};

/** A result joined to its line, test, analyte, order and patient (inner) and tube (left). */
export function joinResult(r: Row<'results'>): ResultRow | null {
  const item = find('orderItems', r.orderItemId);
  const t = item ? find('tests', item.testId) : undefined;
  const a = find('analytes', r.analyteId);
  const o = find('orders', r.orderId);
  const p = o ? find('patients', o.patientId) : undefined;
  if (!item || !t || !a || !o || !p) return null;
  const s = item.sampleId ? (find('samples', item.sampleId) ?? null) : null;
  const link = by('testAnalytes', 'testId', t.id).find((x) => x.analyteId === r.analyteId);
  return { r, a, t, item, o, p, s, analyteSort: link?.sortOrder ?? null };
}

export function resultRowsOf(list: readonly Row<'results'>[]): ResultRow[] {
  const out: ResultRow[] = [];
  for (const r of list) {
    const row = joinResult(r);
    if (row) out.push(row);
  }
  return out;
}

/** Rows for result ids (missing ids are simply absent). */
export function resultRowsByIds(ids: readonly string[]): ResultRow[] {
  const out: ResultRow[] = [];
  for (const id of ids) {
    const r = find('results', id);
    const row = r ? joinResult(r) : null;
    if (row) out.push(row);
  }
  return out;
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

export type PreviousValue = { value: string | null; valueNum: number | null; at: Date; flag: BenchFlag | null };

/**
 * The patient's previous result for each row's analyte, from an earlier order.
 * `statuses` decides what counts (released only on reports; validated too at the bench).
 */
export function previousValues(
  list: Array<{ resultId: string; patientId: string; analyteId: string; orderId: string; orderCreatedAt: Date; decimals: number }>,
  statuses: BenchResultStatus[] = ['validated', 'released'],
): Map<string, PreviousValue> {
  const out = new Map<string, PreviousValue>();
  if (!list.length) return out;
  const wanted = new Set<string>(statuses);
  const ordersOf = new Map<string, Row<'orders'>[]>();
  for (const row of list) {
    let history = ordersOf.get(row.patientId);
    if (!history) {
      history = by('orders', 'patientId', row.patientId).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
      ordersOf.set(row.patientId, history);
    }
    for (const o of history) {
      if (o.id === row.orderId || o.createdAt.getTime() >= row.orderCreatedAt.getTime()) continue;
      const hit = by('results', 'orderId', o.id).find(
        (h) => h.analyteId === row.analyteId && wanted.has(h.status) && (h.valueNum !== null || (h.valueText ?? '') !== ''),
      );
      if (!hit) continue;
      out.set(row.resultId, { value: displayValue(hit.valueNum, hit.valueText, row.decimals), valueNum: hit.valueNum, at: o.createdAt, flag: hit.flag ?? null });
      break;
    }
  }
  return out;
}

/** Map joined rows to the API result shape, with users, instruments, attempts, calls and previous values. */
export function toBenchResults(list: ResultRow[], opts: { previous?: boolean } = {}): BenchResult[] {
  if (!list.length) return [];
  const prev =
    opts.previous === false
      ? new Map<string, PreviousValue>()
      : previousValues(
          list.map((x) => ({ resultId: x.r.id, patientId: x.o.patientId, analyteId: x.a.id, orderId: x.o.id, orderCreatedAt: x.o.createdAt, decimals: x.a.decimals })),
          ['validated', 'released'],
        );
  return list.map(({ r, a, t }) => {
    const n = by('resultAttempts', 'resultId', r.id).length;
    const p = prev.get(r.id);
    const selected = r.selectedAttemptId ? find('resultAttempts', r.selectedAttemptId) : undefined;
    const inst = r.instrumentId ? find('instruments', r.instrumentId) : undefined;
    return {
      id: r.id,
      orderId: r.orderId,
      orderItemId: r.orderItemId,
      analyte: { id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, unit: a.unit, resultType: a.resultType, decimals: a.decimals, options: a.options },
      test: { id: t.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn, departmentId: t.departmentId },
      status: r.status,
      value: displayValue(r.valueNum, r.valueText, a.decimals),
      valueNum: r.valueNum,
      valueText: r.valueText,
      unit: r.unit ?? a.unit,
      flag: r.flag ?? null,
      isCritical: r.isCritical,
      deltaFlag: r.deltaFlag,
      refText: r.refText,
      refLow: r.refLow,
      refHigh: r.refHigh,
      previous: p ? { value: p.value, at: p.at.toISOString(), flag: p.flag } : null,
      comment: r.comment,
      source: selected?.source ?? null,
      instrument: inst ? { id: inst.id, code: inst.code, name: inst.name } : null,
      attempts: n,
      rerunRequested: r.status === 'pending' && n > 0,
      enteredAt: iso(r.enteredAt),
      enteredBy: userRef(r.enteredBy),
      verifiedAt: iso(r.verifiedAt),
      verifiedBy: userRef(r.verifiedBy),
      validatedAt: iso(r.validatedAt),
      validatedBy: userRef(r.validatedBy),
      releasedAt: iso(r.releasedAt),
      amended: r.amended,
      version: r.version,
      criticalCalled: by('criticalCalls', 'resultId', r.id).length > 0,
    };
  });
}

/** Load results by id in display order (404-safe: missing ids are simply absent). */
export function loadBenchResults(ids: readonly string[], opts: { previous?: boolean } = {}): BenchResult[] {
  if (!ids.length) return [];
  const list = resultRowsByIds([...new Set(ids)]);
  list.sort(compareResultRows);
  return toBenchResults(list, opts);
}

/* ------------------------------------------------------------------ other labs, hashes and tokens */

/** A context for a lab with nobody signed in (public pages, cross-lab lookups). */
export function anonymous(labId: string, actorName: string | null = null): MockContext {
  return { labId, userId: null, actorName, auth: null };
}

/** Run a lookup in each lab in turn (the public pages arrive before any lab is known). */
export function inAnyLab<T>(fn: (labId: string) => T | undefined | null): T | null {
  for (const lab of rows('labs')) {
    const hit = withContext(anonymous(lab.id), () => fn(lab.id));
    if (hit !== undefined && hit !== null) return hit;
  }
  return null;
}

/**
 * A stand-in for sha256 (the browser has no synchronous one): the same 64-hex shape, stable for
 * the same text, not cryptographic. Mock data protects nothing.
 */
export function hash64(text: string): string {
  const h = new Uint32Array(8);
  for (let k = 0; k < 8; k++) h[k] = (2166136261 ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    for (let k = 0; k < 8; k++) h[k] = Math.imul(h[k]! ^ (c + k * 131), 16777619);
  }
  let out = '';
  for (let k = 0; k < 8; k++) {
    let x = h[k]! ^ h[(k + 3) % 8]!;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    out += ((x ^ (x >>> 16)) >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Random URL-safe token (base64url), like the server's randomToken(). */
export function randomToken(bytes = 32): string {
  let s = '';
  for (const b of randomBytes(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** What is stored for a patient link token, so the link can be found again. */
export function tokenHash(token: string): string {
  return hash64(token);
}

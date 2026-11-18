/**
 * Dashboard and management reports: port of apps/api/src/modules/analytics/service.ts. Every
 * figure is for the signed-in lab and a calendar range in the lab's time zone. Money figures are
 * only filled in for users who can read finance.
 *
 * The server computes these with SQL. Here each report walks the lab's rows once, groups them in
 * maps and joins by id (find / by), so a month of history (about a thousand orders and tens of
 * thousands of results across the labs) stays quick.
 */
import { formatValue } from '@natija/domain';
import type {
  AnalyticsDashboard,
  AnalyticsInstruments,
  AnalyticsProductivity,
  AnalyticsRejections,
  AnalyticsRevenue,
  AnalyticsTat,
  AnalyticsTatStats,
  AnalyticsVolume,
} from '@natija/contracts';
import { now } from '../../core/context';
import { by, find, rows, type Row } from '../../core/db';
import { dayRange, getLab, labToday, zonedDayStart } from '../../core/lib';
import { methodTotals } from './finance';
import { userName } from '../shared/billing';
import { cents, countBy, fillDays, groupBy, labClock, type LabClock } from './util';

type OrderRow = Row<'orders'>;
type ItemRow = Row<'orderItems'>;

/* ================================================================== range */

export type Range = { from: string; to: string; start: string; end: string; tz: string };

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/**
 * The calendar range of a report. The server refuses a reversed range and one over 400 days;
 * mock mode takes any range, reading a reversed one the right way round and keeping the last
 * 400 days of a longer one.
 */
export function resolveRange(from?: string, to?: string): Range {
  const lab = getLab();
  const today = labToday(lab.timezone);
  let f = from ?? to ?? today;
  let t = to ?? from ?? today;
  if (f > t) [f, t] = [t, f];
  if (daysBetween(f, t) > 400) f = shiftDay(t, -400);
  const { start, end } = dayRange(f, t);
  return { from: f, to: t, start: start.toISOString(), end: end.toISOString(), tz: lab.timezone };
}

/** [start, end) of a range in ms, with a test for instants. */
function rangeOf(r: Range) {
  const s = Date.parse(r.start);
  const e = Date.parse(r.end);
  return { s, e, has: (d: Date | null | undefined) => !!d && d.getTime() >= s && d.getTime() < e };
}

/** Orders created in the range, not cancelled. */
function ordersIn(r: Range): OrderRow[] {
  const w = rangeOf(r);
  return rows('orders').filter((o) => o.status !== 'cancelled' && w.has(o.createdAt));
}

/** The lines of the given orders, not cancelled. */
function activeItems(orders: readonly OrderRow[]): ItemRow[] {
  const out: ItemRow[] = [];
  for (const o of orders) for (const item of by('orderItems', 'orderId', o.id)) if (item.status !== 'cancelled') out.push(item);
  return out;
}

/** Tests per department (inner joins on tests and departments), most first. */
function testsByDepartment(items: readonly ItemRow[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const te = find('tests', item.testId);
    if (te) counts.set(te.departmentId, (counts.get(te.departmentId) ?? 0) + 1);
  }
  const out: Array<{ departmentId: string; code: string; nameAr: string; nameEn: string; tests: number }> = [];
  for (const [id, n] of counts) {
    const d = find('departments', id);
    if (d) out.push({ departmentId: d.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn, tests: n });
  }
  return out.sort((a, b) => b.tests - a.tests || a.code.localeCompare(b.code));
}

/** Requests per test, most first. */
function countsByTest(items: readonly ItemRow[], limit: number) {
  const out: Array<{ testId: string; code: string; nameAr: string; nameEn: string; count: number }> = [];
  for (const [id, n] of countBy(items, (i) => i.testId)) {
    const te = find('tests', id);
    if (te) out.push({ testId: te.id, code: te.code, nameAr: te.nameAr, nameEn: te.nameEn, count: n });
  }
  return out.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, limit);
}

/** Orders per hour of the day (lab time). */
function ordersByHour(orders: readonly OrderRow[], clock: LabClock) {
  const hours = new Array<number>(24).fill(0);
  for (const o of orders) hours[clock.hour(o.createdAt)]! += 1;
  return hours.map((n, hour) => ({ hour, orders: n }));
}

/* ================================================================== turnaround */

type TatRow = {
  testId: string;
  departmentId: string;
  tatHours: number;
  collectedAt: number | null;
  receivedAt: number;
  firstEntered: number | null;
  lastEntered: number | null;
  validatedAt: number;
  minutes: number;
  day: string;
};

/** Order lines validated in the range, with receipt → validation minutes. */
function tatRows(r: Range): TatRow[] {
  const { s, e } = rangeOf(r);
  const from = s - 7 * DAY;
  const groups = new Map<string, { validated: number; first: number | null; last: number | null }>();
  for (const x of rows('results')) {
    if (!x.validatedAt) continue;
    const v = x.validatedAt.getTime();
    if (v < from || v >= e) continue;
    const entered = x.enteredAt ? x.enteredAt.getTime() : null;
    const g = groups.get(x.orderItemId);
    if (!g) {
      groups.set(x.orderItemId, { validated: v, first: entered, last: entered });
      continue;
    }
    if (v > g.validated) g.validated = v;
    if (entered !== null) {
      if (g.first === null || entered < g.first) g.first = entered;
      if (g.last === null || entered > g.last) g.last = entered;
    }
  }
  const clock = labClock(r.tz);
  const out: TatRow[] = [];
  for (const [itemId, g] of groups) {
    if (g.validated < s) continue;
    const oi = find('orderItems', itemId);
    if (!oi || (oi.status !== 'validated' && oi.status !== 'released') || !oi.sampleId) continue;
    const sample = find('samples', oi.sampleId);
    const te = find('tests', oi.testId);
    if (!sample?.receivedAt || !te) continue;
    const received = sample.receivedAt.getTime();
    if (g.validated < received) continue;
    out.push({
      testId: oi.testId,
      departmentId: te.departmentId,
      tatHours: te.tatHours,
      collectedAt: sample.collectedAt ? sample.collectedAt.getTime() : null,
      receivedAt: received,
      firstEntered: g.first,
      lastEntered: g.last,
      validatedAt: g.validated,
      minutes: (g.validated - received) / MINUTE,
      day: clock.day(g.validated),
    });
  }
  return out;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
const minutesBetween = (a: number | null, b: number | null) => (a !== null && b !== null ? (b - a) / MINUTE : null);

function tatStats(list: readonly TatRow[]): AnalyticsTatStats {
  const m = list.map((x) => x.minutes).sort((a, b) => a - b);
  let onTime = 0;
  for (const x of list) if (x.minutes <= x.tatHours * 60) onTime += 1;
  return {
    count: m.length,
    median: round1(percentile(m, 0.5)),
    p90: round1(percentile(m, 0.9)),
    onTimePct: m.length ? round1((100 * onTime) / m.length) : null,
  };
}

function medianOf(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null && x >= 0).sort((a, b) => a - b);
  return round1(percentile(v, 0.5));
}

/** TAT figures per department, in the departments' order. */
function tatByDepartment(tat: readonly TatRow[]) {
  return [...groupBy(tat, (x) => x.departmentId)]
    .map(([id, list]) => {
      const d = find('departments', id);
      return { sort: d?.sortOrder ?? 0, row: { departmentId: id, code: d?.code ?? '', nameAr: d?.nameAr ?? '', nameEn: d?.nameEn ?? '', ...tatStats(list) } };
    })
    .sort((a, b) => a.sort - b.sort || a.row.code.localeCompare(b.row.code))
    .map((x) => x.row);
}

const BUCKETS: Array<[string, number]> = [
  ['<1h', 60],
  ['1-2h', 120],
  ['2-4h', 240],
  ['4-8h', 480],
  ['8-24h', 1440],
  ['24-48h', 2880],
  ['>48h', Number.POSITIVE_INFINITY],
];

export function tatReport(r: Range): AnalyticsTat {
  const list = tatRows(r);
  const overall = tatStats(list);
  const mean = list.length ? round1(list.reduce((a, x) => a + x.minutes, 0) / list.length) : null;
  const byTest = [...groupBy(list, (x) => x.testId)]
    .map(([id, list]) => {
      const t = find('tests', id);
      return { testId: id, code: t?.code ?? '', nameAr: t?.nameAr ?? '', nameEn: t?.nameEn ?? '', tatHours: Number(t?.tatHours ?? 0), ...tatStats(list) };
    })
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 40);
  const byDay = fillDays(
    r.from,
    r.to,
    [...groupBy(list, (x) => x.day)].map(([date, list]) => {
      const st = tatStats(list);
      return { date, count: st.count, median: st.median, p90: st.p90 };
    }),
    (date) => ({ date, count: 0, median: null, p90: null }),
  );
  const counts = new Array<number>(BUCKETS.length).fill(0);
  for (const x of list) {
    const i = BUCKETS.findIndex(([, max]) => x.minutes <= max);
    if (i >= 0) counts[i]! += 1;
  }
  return {
    overall: { ...overall, mean },
    phases: {
      collectToReceive: medianOf(list.map((x) => minutesBetween(x.collectedAt, x.receivedAt))),
      receiveToResult: medianOf(list.map((x) => minutesBetween(x.receivedAt, x.firstEntered))),
      resultToValidate: medianOf(list.map((x) => minutesBetween(x.lastEntered, x.validatedAt))),
    },
    byDepartment: tatByDepartment(list),
    byTest,
    byDay,
    histogram: BUCKETS.map(([bucket], i) => ({ bucket, count: counts[i]! })),
  };
}

/* ================================================================== money helpers */

/** Net (gross − discounts) of non-void invoices by created day, and payments − refunds by received day. */
function moneyDays(from: string, to: string, startMs: number, endMs: number, clock: LabClock) {
  const days = new Map<string, { net: number; collected: number }>();
  const day = (d: Date) => {
    const key = clock.day(d);
    let v = days.get(key);
    if (!v) days.set(key, (v = { net: 0, collected: 0 }));
    return v;
  };
  for (const inv of rows('invoices')) {
    const t = inv.createdAt.getTime();
    if (inv.status === 'void' || t < startMs || t >= endMs) continue;
    day(inv.createdAt).net += inv.subtotal - inv.discountTotal;
  }
  for (const p of rows('payments')) {
    const t = p.receivedAt.getTime();
    if (t < startMs || t >= endMs) continue;
    day(p.receivedAt).collected += p.kind === 'payment' ? p.amount : -p.amount;
  }
  return fillDays(
    from,
    to,
    [...days].map(([date, v]) => ({ date, net: cents(v.net), collected: cents(v.collected) })),
    (date) => ({ date, net: 0, collected: 0 }),
  );
}

/* ================================================================== dashboard */

const ACTIVE_ORDER = new Set(['registered', 'collected', 'in_progress', 'partial']);

export function dashboard(r: Range, showMoney: boolean): AnalyticsDashboard {
  const at = now().getTime();
  const clock = labClock(r.tz);
  const w = rangeOf(r);
  const orders = ordersIn(r);
  const items = activeItems(orders);

  const newPatients = rows('patients').filter((p) => w.has(p.createdAt) && !p.deletedAt && !p.mergedIntoId).length;

  // Work in progress: lines of the orders still open, whenever they were registered.
  const wip = { toCollect: 0, toReceive: 0, inAnalysis: 0, toVerify: 0, toValidate: 0, toRelease: 0, toDeliver: 0 };
  const openLines: Array<{ item: ItemRow; order: OrderRow }> = [];
  for (const status of ACTIVE_ORDER) {
    for (const order of by('orders', 'status', status as OrderRow['status'])) {
      for (const item of by('orderItems', 'orderId', order.id)) {
        openLines.push({ item, order });
        if (item.status === 'ordered') wip.toCollect += 1;
        else if (item.status === 'collected') wip.toReceive += 1;
        else if (item.status === 'received' || item.status === 'in_analysis') wip.inAnalysis += 1;
        else if (item.status === 'resulted') wip.toVerify += 1;
        else if (item.status === 'verified') wip.toValidate += 1;
        else if (item.status === 'validated') wip.toRelease += 1;
      }
    }
  }
  wip.toDeliver = by('orders', 'status', 'completed').filter((o) => o.createdAt.getTime() > at - 30 * DAY).length;

  // Critical results nobody has phoned in yet (last 7 days).
  const called = new Set(rows('criticalCalls').map((c) => c.resultId));
  const criticals: Array<{ x: Row<'results'>; order: OrderRow; when: number }> = [];
  for (const x of rows('results')) {
    if (!x.isCritical || x.status === 'pending' || called.has(x.id) || x.updatedAt.getTime() <= at - 7 * DAY) continue;
    const order = find('orders', x.orderId);
    if (!order || order.status === 'cancelled') continue;
    criticals.push({ x, order, when: (x.enteredAt ?? x.updatedAt).getTime() });
  }
  criticals.sort((a, b) => b.when - a.when);
  const criticalItems: AnalyticsDashboard['criticals']['items'] = [];
  for (const { x, order, when } of criticals) {
    if (criticalItems.length >= 10) break;
    const p = find('patients', order.patientId);
    const a = find('analytes', x.analyteId);
    if (!p || !a) continue;
    criticalItems.push({
      resultId: x.id,
      orderId: x.orderId,
      accession: order.accession,
      patientNameAr: p.fullNameAr,
      patientNameEn: p.fullNameEn ?? null,
      analyteCode: a.code,
      analyteNameAr: a.nameAr,
      analyteNameEn: a.nameEn,
      value: x.valueNum !== null && x.valueNum !== undefined ? formatValue(Number(x.valueNum), Number(a.decimals ?? 1)) : (x.valueText ?? ''),
      unit: x.unit ?? null,
      flag: x.flag ?? null,
      at: new Date(when).toISOString(),
    });
  }

  // Rejected tubes in the range, by reason.
  const rejectCounts = countBy(
    rows('samples').filter((s) => w.has(s.rejectedAt)),
    (s) => s.rejectionReasonId,
  );
  const byReason = [...rejectCounts]
    .map(([id, n]) => {
      const rr = id ? find('rejectionReasons', id) : undefined;
      return { reasonId: id ?? null, nameAr: rr?.nameAr ?? null, nameEn: rr?.nameEn ?? null, count: n };
    })
    .sort((a, b) => b.count - a.count);

  const tat = tatRows(r);

  // Lines past their turnaround target, oldest due first.
  const overdue: Array<{ item: ItemRow; order: OrderRow; test: Row<'tests'>; due: number }> = [];
  for (const { item, order } of openLines) {
    if (item.status !== 'received' && item.status !== 'in_analysis' && item.status !== 'resulted' && item.status !== 'verified') continue;
    const sample = item.sampleId ? find('samples', item.sampleId) : undefined;
    const test = find('tests', item.testId);
    if (!sample?.receivedAt || !test) continue;
    const due = sample.receivedAt.getTime() + test.tatHours * HOUR;
    if (due < at) overdue.push({ item, order, test, due });
  }
  overdue.sort((a, b) => a.due - b.due);
  const overdueItems: AnalyticsDashboard['overdue']['items'] = [];
  for (const { item, order, test, due } of overdue) {
    if (overdueItems.length >= 12) break;
    const p = find('patients', order.patientId);
    if (!p) continue;
    overdueItems.push({
      itemId: item.id,
      orderId: order.id,
      accession: order.accession,
      priority: order.priority,
      patientNameAr: p.fullNameAr,
      patientNameEn: p.fullNameEn ?? null,
      testCode: test.code,
      testNameAr: test.nameAr,
      testNameEn: test.nameEn,
      status: item.status,
      dueAt: new Date(due).toISOString(),
      overdueMinutes: Math.max(0, Math.round((at - due) / MINUTE)),
    });
  }

  // Orders and net billed per payer group.
  const payers = new Map<string, { orders: number; net: number }>();
  for (const o of orders) {
    let v = payers.get(o.payerGroupId);
    if (!v) payers.set(o.payerGroupId, (v = { orders: 0, net: 0 }));
    v.orders += 1;
    for (const inv of by('invoices', 'orderId', o.id)) if (inv.status !== 'void') v.net += inv.subtotal - inv.discountTotal;
  }
  const payerMix: AnalyticsDashboard['payerMix'] = [];
  for (const [id, v] of payers) {
    const pg = find('payerGroups', id);
    if (pg) payerMix.push({ payerGroupId: pg.id, code: pg.code, nameAr: pg.nameAr, nameEn: pg.nameEn, kind: pg.kind, orders: v.orders, net: showMoney ? cents(v.net) : null });
  }
  payerMix.sort((a, b) => b.orders - a.orders || a.code.localeCompare(b.code));

  const instruments = rows('instruments')
    .filter((i) => i.isActive)
    .sort((a, b) => a.code.localeCompare(b.code));
  const instrumentCounts: Record<string, number> = {};
  for (const i of instruments) instrumentCounts[i.status] = (instrumentCounts[i.status] ?? 0) + 1;

  let money: AnalyticsDashboard['money'] = null;
  let revenueDays: AnalyticsDashboard['revenueDays'] = null;
  if (showMoney) {
    let billed = 0;
    let discounts = 0;
    let outstanding = 0;
    let insurer = 0;
    for (const inv of rows('invoices')) {
      if (inv.status === 'void' || !w.has(inv.createdAt)) continue;
      billed += inv.subtotal;
      discounts += inv.discountTotal;
      outstanding += Math.max(inv.patientTotal - inv.paidTotal, 0);
      insurer += inv.insurerTotal;
    }
    let collected = 0;
    for (const p of rows('payments')) if (w.has(p.receivedAt)) collected += p.kind === 'payment' ? p.amount : -p.amount;
    money = {
      billed: cents(billed),
      discounts: cents(discounts),
      revenue: cents(billed) - cents(discounts),
      collected: cents(collected),
      outstanding: cents(outstanding),
      insurer: cents(insurer),
    };
    const first = shiftDay(r.to, -13);
    revenueDays = moneyDays(first, r.to, zonedDayStart(first, r.tz).getTime(), w.e, clock);
  }

  return {
    from: r.from,
    to: r.to,
    kpis: { orders: orders.length, patients: new Set(orders.map((o) => o.patientId)).size, tests: items.length, newPatients },
    money,
    wip,
    criticals: { count: criticals.length, items: criticalItems },
    rejections: { count: byReason.reduce((a, x) => a + x.count, 0), byReason },
    tat: { ...tatStats(tat), byDepartment: tatByDepartment(tat) },
    overdue: { count: overdue.length, items: overdueItems },
    ordersByHour: ordersByHour(orders, clock),
    testsByDepartment: testsByDepartment(items),
    topTests: countsByTest(items, 10),
    payerMix,
    instruments: {
      counts: instrumentCounts,
      items: instruments.map((i) => ({ id: i.id, code: i.code, name: i.name, status: i.status, lastMessageAt: i.lastMessageAt ? i.lastMessageAt.toISOString() : null })),
    },
    revenueDays,
  };
}

/* ================================================================== volume */

export function volumeReport(r: Range): AnalyticsVolume {
  const clock = labClock(r.tz);
  const w = rangeOf(r);
  const orders = ordersIn(r);
  const items = activeItems(orders);
  let samples = 0;
  const days = new Map<string, { orders: number; tests: number; patients: Set<string> }>();
  const weekdays = new Array<number>(7).fill(0);
  for (const o of orders) {
    samples += by('samples', 'orderId', o.id).length;
    const key = clock.day(o.createdAt);
    let d = days.get(key);
    if (!d) days.set(key, (d = { orders: 0, tests: 0, patients: new Set() }));
    d.orders += 1;
    d.patients.add(o.patientId);
    for (const item of by('orderItems', 'orderId', o.id)) if (item.status !== 'cancelled') d.tests += 1;
    weekdays[clock.weekday(o.createdAt)]! += 1;
  }
  const ranked = <K extends string>(counts: Map<K, number>) => [...counts].sort((a, b) => b[1] - a[1]);
  return {
    totals: {
      orders: orders.length,
      tests: items.length,
      patients: new Set(orders.map((o) => o.patientId)).size,
      newPatients: rows('patients').filter((p) => w.has(p.createdAt) && !p.deletedAt && !p.mergedIntoId).length,
      samples,
    },
    byDay: fillDays(
      r.from,
      r.to,
      [...days].map(([date, d]) => ({ date, orders: d.orders, tests: d.tests, patients: d.patients.size })),
      (date) => ({ date, orders: 0, tests: 0, patients: 0 }),
    ),
    byHour: ordersByHour(orders, clock),
    byWeekday: weekdays.map((n, weekday) => ({ weekday, orders: n })),
    byDepartment: testsByDepartment(items),
    byTest: countsByTest(items, 40),
    bySource: ranked(countBy(orders, (o) => o.source)).map(([source, n]) => ({ source, orders: n })),
    byPriority: ranked(countBy(orders, (o) => o.priority)).map(([priority, n]) => ({ priority, orders: n })),
  };
}

/* ================================================================== revenue */

export function revenueReport(r: Range): AnalyticsRevenue {
  const clock = labClock(r.tz);
  const w = rangeOf(r);
  let billed = 0;
  let discounts = 0;
  let patient = 0;
  let insurer = 0;
  let outstanding = 0;
  const payers = new Map<string, { invoices: number; net: number; patient: number; insurer: number; paid: number; outstanding: number }>();
  const depts = new Map<string, { net: number; n: number }>();
  const tests = new Map<string, { net: number; n: number }>();
  for (const inv of rows('invoices')) {
    if (inv.status === 'void' || !w.has(inv.createdAt)) continue;
    billed += inv.subtotal;
    discounts += inv.discountTotal;
    patient += inv.patientTotal;
    insurer += inv.insurerTotal;
    outstanding += Math.max(inv.patientTotal - inv.paidTotal, 0);
    let pv = payers.get(inv.payerGroupId);
    if (!pv) payers.set(inv.payerGroupId, (pv = { invoices: 0, net: 0, patient: 0, insurer: 0, paid: 0, outstanding: 0 }));
    pv.invoices += 1;
    pv.net += inv.subtotal - inv.discountTotal;
    pv.patient += inv.patientTotal;
    pv.insurer += inv.insurerTotal;
    pv.paid += inv.paidTotal;
    pv.outstanding += Math.max(inv.patientTotal - inv.paidTotal, 0);
    for (const line of by('invoiceLines', 'invoiceId', inv.id)) {
      const oi = line.orderItemId ? find('orderItems', line.orderItemId) : undefined;
      const te = oi ? find('tests', oi.testId) : undefined;
      if (!te) continue;
      const net = line.price - line.discount;
      const t = tests.get(te.id);
      if (t) {
        t.net += net;
        t.n += 1;
      } else tests.set(te.id, { net, n: 1 });
      if (!find('departments', te.departmentId)) continue;
      const d = depts.get(te.departmentId);
      if (d) {
        d.net += net;
        d.n += 1;
      } else depts.set(te.departmentId, { net, n: 1 });
    }
  }
  let collected = 0;
  let refunds = 0;
  const payments: Row<'payments'>[] = [];
  for (const p of rows('payments')) {
    if (!w.has(p.receivedAt)) continue;
    payments.push(p);
    if (p.kind === 'payment') collected += p.amount;
    else refunds += p.amount;
  }

  const byPayer: AnalyticsRevenue['byPayer'] = [];
  for (const [id, v] of payers) {
    const pg = find('payerGroups', id);
    if (!pg) continue;
    byPayer.push({
      payerGroupId: pg.id,
      code: pg.code,
      nameAr: pg.nameAr,
      nameEn: pg.nameEn,
      kind: pg.kind,
      invoices: v.invoices,
      net: cents(v.net),
      patient: cents(v.patient),
      insurer: cents(v.insurer),
      paid: cents(v.paid),
      outstanding: cents(v.outstanding),
    });
  }
  byPayer.sort((a, b) => b.net - a.net || a.code.localeCompare(b.code));

  const byDepartment = [...depts]
    .map(([id, v]) => {
      const d = find('departments', id)!;
      return { departmentId: d.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn, net: cents(v.net), tests: v.n };
    })
    .sort((a, b) => b.net - a.net || a.code.localeCompare(b.code));

  const topTests = [...tests]
    .map(([id, v]) => {
      const te = find('tests', id)!;
      return { testId: te.id, code: te.code, nameAr: te.nameAr, nameEn: te.nameEn, count: v.n, net: cents(v.net) };
    })
    .sort((a, b) => b.net - a.net || a.code.localeCompare(b.code))
    .slice(0, 25);

  return {
    totals: {
      billed: cents(billed),
      discounts: cents(discounts),
      net: cents(billed) - cents(discounts),
      patientShare: cents(patient),
      insurerShare: cents(insurer),
      collected: cents(collected) - cents(refunds),
      refunds: cents(refunds),
      outstanding: cents(outstanding),
    },
    byDay: moneyDays(r.from, r.to, w.s, w.e, clock),
    byPayer,
    byDepartment,
    byMethod: methodTotals(payments),
    topTests,
  };
}

/* ================================================================== productivity */

export function productivityReport(r: Range): AnalyticsProductivity {
  const w = rangeOf(r);
  type Work = { entered: number; verified: number; validated: number; orders: number; collected: number; received: number };
  const users = new Map<string | null, Work>();
  const of = (userId: string | null) => {
    let v = users.get(userId);
    if (!v) users.set(userId, (v = { entered: 0, verified: 0, validated: 0, orders: 0, collected: 0, received: 0 }));
    return v;
  };
  for (const x of rows('results')) {
    if (w.has(x.enteredAt)) of(x.enteredBy).entered += 1;
    if (w.has(x.verifiedAt)) of(x.verifiedBy).verified += 1;
    if (w.has(x.validatedAt)) of(x.validatedBy).validated += 1;
  }
  for (const o of rows('orders')) if (w.has(o.createdAt)) of(o.createdBy).orders += 1;
  for (const s of rows('samples')) {
    if (w.has(s.collectedAt)) of(s.collectedBy).collected += 1;
    if (w.has(s.receivedAt)) of(s.receivedBy).received += 1;
  }
  return {
    users: [...users]
      .sort(([, a], [, b]) => b.validated + b.verified + b.entered - (a.validated + a.verified + a.entered) || b.orders - a.orders)
      .map(([userId, v]) => {
        const u = userName(userId);
        return {
          userId,
          nameAr: u?.fullNameAr ?? null,
          nameEn: u?.fullNameEn ?? null,
          entered: v.entered,
          verified: v.verified,
          validated: v.validated,
          ordersCreated: v.orders,
          samplesCollected: v.collected,
          samplesReceived: v.received,
        };
      }),
  };
}

/* ================================================================== rejections */

export function rejectionsReport(r: Range): AnalyticsRejections {
  const clock = labClock(r.tz);
  const w = rangeOf(r);
  let evaluated = 0;
  const rejected: Row<'samples'>[] = [];
  for (const s of rows('samples')) {
    const isRejected = w.has(s.rejectedAt);
    if (isRejected || w.has(s.receivedAt)) evaluated += 1;
    if (isRejected) rejected.push(s);
  }
  const byDesc = <T extends { count: number }>(list: T[]) => list.sort((a, b) => b.count - a.count);
  const byReason = byDesc(
    [...countBy(rejected, (s) => s.rejectionReasonId)].map(([id, n]) => {
      const rr = id ? find('rejectionReasons', id) : undefined;
      return { reasonId: id ?? null, code: rr?.code ?? null, nameAr: rr?.nameAr ?? null, nameEn: rr?.nameEn ?? null, count: n };
    }),
  );
  const byDepartment = byDesc(
    [...countBy(rejected, (s) => s.departmentId)].map(([id, n]) => {
      const d = id ? find('departments', id) : undefined;
      return { departmentId: id ?? null, nameAr: d?.nameAr ?? null, nameEn: d?.nameEn ?? null, count: n };
    }),
  );
  const byCollector = byDesc(
    [...countBy(rejected, (s) => s.collectedBy)].map(([id, n]) => {
      const u = userName(id);
      return { userId: id ?? null, nameAr: u?.fullNameAr ?? null, nameEn: u?.fullNameEn ?? null, count: n };
    }),
  );
  const recent: AnalyticsRejections['recent'] = [];
  for (const s of rejected.slice().sort((a, b) => b.rejectedAt!.getTime() - a.rejectedAt!.getTime())) {
    if (recent.length >= 25) break;
    const o = find('orders', s.orderId);
    const p = o ? find('patients', o.patientId) : undefined;
    if (!o || !p) continue;
    const rr = s.rejectionReasonId ? find('rejectionReasons', s.rejectionReasonId) : undefined;
    const u = userName(s.rejectedBy);
    recent.push({
      sampleId: s.id,
      barcode: s.barcode,
      orderId: o.id,
      accession: o.accession,
      patientNameAr: p.fullNameAr,
      patientNameEn: p.fullNameEn ?? null,
      reasonNameAr: rr?.nameAr ?? null,
      reasonNameEn: rr?.nameEn ?? null,
      note: s.rejectionNote ?? null,
      rejectedAt: s.rejectedAt!.toISOString(),
      rejectedByNameAr: u?.fullNameAr ?? null,
      rejectedByNameEn: u?.fullNameEn ?? null,
    });
  }
  return {
    totals: { evaluated, rejected: rejected.length, ratePct: evaluated ? round1((100 * rejected.length) / evaluated) : null },
    byReason,
    byDepartment,
    byCollector,
    byDay: fillDays(
      r.from,
      r.to,
      [...countBy(rejected, (s) => clock.day(s.rejectedAt!))].map(([date, n]) => ({ date, rejected: n })),
      (date) => ({ date, rejected: 0 }),
    ),
    recent,
  };
}

/* ================================================================== instruments */

export function instrumentsReport(r: Range): AnalyticsInstruments {
  const w = rangeOf(r);
  type Stats = { messages: number; errors: number; unmatched: number; results: number; qcRuns: number; qcWarnings: number; qcRejected: number; lastMaintenance: number | null };
  const stats = new Map<string, Stats>();
  const of = (id: string) => {
    let v = stats.get(id);
    if (!v) stats.set(id, (v = { messages: 0, errors: 0, unmatched: 0, results: 0, qcRuns: 0, qcWarnings: 0, qcRejected: 0, lastMaintenance: null }));
    return v;
  };
  for (const m of rows('integrationMessages')) {
    if (!w.has(m.receivedAt)) continue;
    const v = of(m.instrumentId);
    v.messages += 1;
    if (m.status === 'error') v.errors += 1;
    if (m.status === 'unmatched' || m.status === 'partial') v.unmatched += 1;
  }
  for (const x of rows('results')) if (x.instrumentId && w.has(x.enteredAt)) of(x.instrumentId).results += 1;
  for (const q of rows('qcRuns')) {
    if (!w.has(q.runAt)) continue;
    const instrumentId = find('qcMaterials', q.materialId)?.instrumentId;
    if (!instrumentId) continue;
    const v = of(instrumentId);
    v.qcRuns += 1;
    if (q.status === 'warning') v.qcWarnings += 1;
    if (q.status === 'rejected') v.qcRejected += 1;
  }
  for (const m of rows('maintenanceLogs')) {
    const v = of(m.instrumentId);
    const t = m.performedAt.getTime();
    if (v.lastMaintenance === null || t > v.lastMaintenance) v.lastMaintenance = t;
  }
  const list = rows('instruments')
    .slice()
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.code.localeCompare(b.code));
  const counts: Record<string, number> = {};
  for (const i of list) if (i.isActive) counts[i.status] = (counts[i.status] ?? 0) + 1;
  return {
    counts,
    items: list.map((i) => {
      const v = stats.get(i.id);
      return {
        id: i.id,
        code: i.code,
        name: i.name,
        model: i.model,
        status: i.status,
        integrationLevel: i.integrationLevel,
        isSimulated: !!i.isSimulated,
        isActive: !!i.isActive,
        lastMessageAt: i.lastMessageAt ? i.lastMessageAt.toISOString() : null,
        messages: v?.messages ?? 0,
        errors: v?.errors ?? 0,
        unmatched: v?.unmatched ?? 0,
        results: v?.results ?? 0,
        qcRuns: v?.qcRuns ?? 0,
        qcWarnings: v?.qcWarnings ?? 0,
        qcRejected: v?.qcRejected ?? 0,
        lastMaintenanceAt: v?.lastMaintenance ? new Date(v.lastMaintenance).toISOString() : null,
      };
    }),
  };
}

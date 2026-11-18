/**
 * Dashboard and management reports. Every figure is for the lab's own data (row-level
 * security) and a calendar range in the lab's time zone. Money figures are only filled in for
 * users who can read finance.
 */
import { sql } from 'drizzle-orm';
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
  FinanceMethodTotal,
} from '@natija/contracts';
import { ctx } from '../../db';
import { badRequest } from '../../lib/errors';
import { dayRange, zonedDayStart } from '../../lib/http';
import { getLab } from '../../lib/lab';
import { num, rowsOf } from '../audit/kit';
import { fillDays } from '../finance/service';

/* ================================================================== range */

export type Range = { from: string; to: string; start: string; end: string; tz: string };

export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export async function resolveRange(from?: string, to?: string): Promise<Range> {
  const lab = await getLab(ctx().labId);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: lab.timezone }).format(new Date());
  const f = from ?? to ?? today;
  const t = to ?? from ?? today;
  if (f > t) throw badRequest('validation', 'The start is after the end', { from: ['after_to'] });
  if (daysBetween(f, t) > 400) throw badRequest('range_too_long', 'At most 400 days');
  const { start, end } = await dayRange(f, t);
  return { from: f, to: t, start: start.toISOString(), end: end.toISOString(), tz: lab.timezone };
}

const inRange = (col: string, r: Range) => sql.raw(`${col} >= '${r.start}'::timestamptz and ${col} < '${r.end}'::timestamptz`);

/* ================================================================== turnaround */

type TatRow = {
  test_id: string;
  department_id: string;
  tat_hours: number;
  collected_at: Date | null;
  received_at: Date;
  first_entered: Date | null;
  last_entered: Date | null;
  validated_at: Date;
  minutes: number;
  day: string;
};

/** Order lines validated in the range, with receipt → validation minutes. */
async function tatRows(r: Range): Promise<TatRow[]> {
  const rows = await rowsOf<TatRow>(sql`
    with v as (
      select r.order_item_id, max(r.validated_at) as validated_at, min(r.entered_at) as first_entered, max(r.entered_at) as last_entered
      from results r
      where r.validated_at is not null and r.validated_at >= (${r.start}::timestamptz - interval '7 days') and r.validated_at < ${r.end}::timestamptz
      group by r.order_item_id
      having max(r.validated_at) >= ${r.start}::timestamptz
    )
    select oi.test_id, te.department_id, te.tat_hours, s.collected_at, s.received_at, v.first_entered, v.last_entered, v.validated_at,
      extract(epoch from (v.validated_at - s.received_at)) / 60.0 as minutes,
      to_char((v.validated_at at time zone ${r.tz})::date, 'YYYY-MM-DD') as day
    from v
    join order_items oi on oi.id = v.order_item_id
    join samples s on s.id = oi.sample_id
    join tests te on te.id = oi.test_id
    where oi.status in ('validated', 'released') and s.received_at is not null and v.validated_at >= s.received_at`);
  // Raw queries return timestamps as text (drizzle's pg type parsers), so convert them here.
  const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
  return rows.map((x) => ({
    ...x,
    collected_at: date(x.collected_at),
    received_at: date(x.received_at)!,
    first_entered: date(x.first_entered),
    last_entered: date(x.last_entered),
    validated_at: date(x.validated_at)!,
    minutes: Number(x.minutes),
    tat_hours: Number(x.tat_hours),
  }));
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
const minutesBetween = (a: Date | null, b: Date | null) => (a && b ? (b.getTime() - a.getTime()) / 60_000 : null);

function tatStats(rows: Array<{ minutes: number; tat_hours: number }>): AnalyticsTatStats {
  const m = rows.map((r) => r.minutes).sort((a, b) => a - b);
  return {
    count: m.length,
    median: round1(percentile(m, 0.5)),
    p90: round1(percentile(m, 0.9)),
    onTimePct: m.length ? round1((100 * rows.filter((r) => r.minutes <= r.tat_hours * 60).length) / m.length) : null,
  };
}

function medianOf(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null && x >= 0).sort((a, b) => a - b);
  return round1(percentile(v, 0.5));
}

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

type DeptRow = { id: string; code: string; name_ar: string; name_en: string; sort_order: number };
type TestRow = { id: string; code: string; name_ar: string; name_en: string; tat_hours: number };

async function departmentsMap() {
  const rows = await rowsOf<DeptRow>(sql`select id, code, name_ar, name_en, sort_order from departments order by sort_order, code`);
  return new Map(rows.map((d) => [d.id, d]));
}

export async function tatReport(r: Range): Promise<AnalyticsTat> {
  const rows = await tatRows(r);
  const deps = await departmentsMap();
  const testIds = [...new Set(rows.map((x) => x.test_id))];
  const testRows = testIds.length
    ? await rowsOf<TestRow>(sql`select id, code, name_ar, name_en, tat_hours from tests where id in (${sql.join(testIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
    : [];
  const testInfo = new Map(testRows.map((t) => [t.id, t]));
  const overall = tatStats(rows);
  const mean = rows.length ? round1(rows.reduce((a, x) => a + x.minutes, 0) / rows.length) : null;
  const byDepartment = [...groupBy(rows, (x) => x.department_id)]
    .map(([id, list]) => {
      const d = deps.get(id);
      return { departmentId: id, code: d?.code ?? '', nameAr: d?.name_ar ?? '', nameEn: d?.name_en ?? '', ...tatStats(list), sort: d?.sort_order ?? 0 };
    })
    .sort((a, b) => a.sort - b.sort)
    .map(({ sort, ...x }) => (void sort, x));
  const byTest = [...groupBy(rows, (x) => x.test_id)]
    .map(([id, list]) => {
      const t = testInfo.get(id);
      return { testId: id, code: t?.code ?? '', nameAr: t?.name_ar ?? '', nameEn: t?.name_en ?? '', tatHours: Number(t?.tat_hours ?? 0), ...tatStats(list) };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
  const dayGroups = groupBy(rows, (x) => x.day);
  const byDay = fillDays(
    r.from,
    r.to,
    [...dayGroups].map(([date, list]) => {
      const s = tatStats(list);
      return { date, count: s.count, median: s.median, p90: s.p90 };
    }),
    (date) => ({ date, count: 0, median: null, p90: null }),
  );
  const buckets: Array<[string, number]> = [
    ['<1h', 60],
    ['1-2h', 120],
    ['2-4h', 240],
    ['4-8h', 480],
    ['8-24h', 1440],
    ['24-48h', 2880],
    ['>48h', Number.POSITIVE_INFINITY],
  ];
  const histogram = buckets.map(([bucket, max], i) => {
    const min = i === 0 ? Number.NEGATIVE_INFINITY : buckets[i - 1]![1];
    return { bucket, count: rows.filter((x) => x.minutes > min && x.minutes <= max).length };
  });
  return {
    overall: { ...overall, mean },
    phases: {
      collectToReceive: medianOf(rows.map((x) => minutesBetween(x.collected_at, x.received_at))),
      receiveToResult: medianOf(rows.map((x) => minutesBetween(x.received_at, x.first_entered))),
      resultToValidate: medianOf(rows.map((x) => minutesBetween(x.last_entered, x.validated_at))),
    },
    byDepartment,
    byTest,
    byDay,
    histogram,
  };
}

/* ================================================================== dashboard */

export async function dashboard(r: Range, showMoney: boolean): Promise<AnalyticsDashboard> {
  const orderRange = inRange('o.created_at', r);
  const [kpi] = await rowsOf<Record<string, string>>(sql`
    select
      (select count(*) from orders o where ${orderRange} and o.status <> 'cancelled') as orders,
      (select count(distinct o.patient_id) from orders o where ${orderRange} and o.status <> 'cancelled') as patients,
      (select count(*) from order_items oi join orders o on o.id = oi.order_id where ${orderRange} and o.status <> 'cancelled' and oi.status <> 'cancelled') as tests,
      (select count(*) from patients p where ${inRange('p.created_at', r)} and p.deleted_at is null and p.merged_into_id is null) as new_patients`);

  const [wip] = await rowsOf<Record<string, string>>(sql`
    select
      count(*) filter (where oi.status = 'ordered') as to_collect,
      count(*) filter (where oi.status = 'collected') as to_receive,
      count(*) filter (where oi.status in ('received', 'in_analysis')) as in_analysis,
      count(*) filter (where oi.status = 'resulted') as to_verify,
      count(*) filter (where oi.status = 'verified') as to_validate,
      count(*) filter (where oi.status = 'validated') as to_release,
      (select count(*) from orders d where d.status = 'completed' and d.created_at > now() - interval '30 days') as to_deliver
    from order_items oi join orders o on o.id = oi.order_id
    where o.status in ('registered', 'collected', 'in_progress', 'partial')`);

  const criticalWhere = sql`r.is_critical and o.status <> 'cancelled' and r.status <> 'pending'
      and not exists (select 1 from critical_calls c where c.result_id = r.id)
      and r.updated_at > now() - interval '7 days'`;
  const criticalRows = await rowsOf<Record<string, unknown>>(sql`
    select r.id, r.order_id, o.accession, p.full_name_ar, p.full_name_en, a.code, a.name_ar, a.name_en, a.decimals,
      r.value_num, r.value_text, r.unit, r.flag, coalesce(r.entered_at, r.updated_at) as at
    from results r join orders o on o.id = r.order_id join patients p on p.id = o.patient_id join analytes a on a.id = r.analyte_id
    where ${criticalWhere}
    order by coalesce(r.entered_at, r.updated_at) desc limit 10`);
  const [criticalCount] = await rowsOf<{ n: string }>(sql`
    select count(*) as n from results r join orders o on o.id = r.order_id where ${criticalWhere}`);

  const rejectRows = await rowsOf<Record<string, unknown>>(sql`
    select s.rejection_reason_id as id, rr.name_ar, rr.name_en, count(*) as n
    from samples s left join rejection_reasons rr on rr.id = s.rejection_reason_id
    where ${inRange('s.rejected_at', r)}
    group by 1, 2, 3 order by n desc`);

  const tat = await tatRows(r);
  const deps = await departmentsMap();

  const overdueWhere = sql`o.status in ('registered', 'collected', 'in_progress', 'partial')
      and oi.status in ('received', 'in_analysis', 'resulted', 'verified')
      and s.received_at is not null
      and s.received_at + make_interval(hours => te.tat_hours) < now()`;
  const overdueRows = await rowsOf<Record<string, unknown>>(sql`
    select oi.id, o.id as order_id, o.accession, o.priority, p.full_name_ar, p.full_name_en, te.code, te.name_ar, te.name_en, oi.status,
      s.received_at + make_interval(hours => te.tat_hours) as due_at
    from order_items oi join orders o on o.id = oi.order_id join tests te on te.id = oi.test_id
    join patients p on p.id = o.patient_id join samples s on s.id = oi.sample_id
    where ${overdueWhere}
    order by due_at asc limit 12`);
  const [overdueCount] = await rowsOf<{ n: string }>(sql`
    select count(*) as n from order_items oi join orders o on o.id = oi.order_id join tests te on te.id = oi.test_id join samples s on s.id = oi.sample_id
    where ${overdueWhere}`);

  const hours = await rowsOf<{ hour: number; n: string }>(sql`
    select extract(hour from o.created_at at time zone ${r.tz})::int as hour, count(*) as n
    from orders o where ${orderRange} and o.status <> 'cancelled' group by 1`);
  const hourMap = new Map(hours.map((h) => [Number(h.hour), num(h.n)]));

  const byDept = await rowsOf<Record<string, unknown>>(sql`
    select d.id, d.code, d.name_ar, d.name_en, count(*) as n
    from order_items oi join orders o on o.id = oi.order_id join tests te on te.id = oi.test_id join departments d on d.id = te.department_id
    where ${orderRange} and o.status <> 'cancelled' and oi.status <> 'cancelled'
    group by d.id order by n desc`);

  const topTests = await rowsOf<Record<string, unknown>>(sql`
    select te.id, te.code, te.name_ar, te.name_en, count(*) as n
    from order_items oi join orders o on o.id = oi.order_id join tests te on te.id = oi.test_id
    where ${orderRange} and o.status <> 'cancelled' and oi.status <> 'cancelled'
    group by te.id order by n desc limit 10`);

  const payerRows = await rowsOf<Record<string, unknown>>(sql`
    select pg.id, pg.code, pg.name_ar, pg.name_en, pg.kind, count(o.id) as orders,
      coalesce(sum(i.subtotal - i.discount_total) filter (where i.status <> 'void'), 0) as net
    from orders o join payer_groups pg on pg.id = o.payer_group_id left join invoices i on i.order_id = o.id
    where ${orderRange} and o.status <> 'cancelled'
    group by pg.id order by orders desc`);

  const instrumentRows = await rowsOf<Record<string, unknown>>(sql`
    select id, code, name, status, last_message_at from instruments where is_active order by code`);
  const instrumentCounts: Record<string, number> = {};
  for (const i of instrumentRows) instrumentCounts[i.status as string] = (instrumentCounts[i.status as string] ?? 0) + 1;

  let money: AnalyticsDashboard['money'] = null;
  let revenueDays: AnalyticsDashboard['revenueDays'] = null;
  if (showMoney) {
    const [inv] = await rowsOf<Record<string, string>>(sql`
      select coalesce(sum(i.subtotal), 0) as billed, coalesce(sum(i.discount_total), 0) as discounts,
        coalesce(sum(greatest(i.patient_total - i.paid_total, 0)), 0) as outstanding, coalesce(sum(i.insurer_total), 0) as insurer
      from invoices i where ${inRange('i.created_at', r)} and i.status <> 'void'`);
    const [pay] = await rowsOf<Record<string, string>>(sql`
      select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) as collected from payments p where ${inRange('p.received_at', r)}`);
    money = {
      billed: num(inv?.billed),
      discounts: num(inv?.discounts),
      revenue: num(inv?.billed) - num(inv?.discounts),
      collected: num(pay?.collected),
      outstanding: num(inv?.outstanding),
      insurer: num(inv?.insurer),
    };
    const first = shiftDay(r.to, -13);
    const span: Range = { ...r, from: first, start: zonedDayStart(first, r.tz).toISOString() };
    const days = await rowsOf<{ day: string; net: string; collected: string }>(sql`
      with d as (
        select to_char((i.created_at at time zone ${r.tz})::date, 'YYYY-MM-DD') as day, sum(i.subtotal - i.discount_total) as net, 0::numeric as collected
        from invoices i where ${inRange('i.created_at', span)} and i.status <> 'void' group by 1
        union all
        select to_char((p.received_at at time zone ${r.tz})::date, 'YYYY-MM-DD'), 0, sum(case when p.kind = 'payment' then p.amount else -p.amount end)
        from payments p where ${inRange('p.received_at', span)} group by 1
      )
      select day, sum(net) as net, sum(collected) as collected from d group by day`);
    revenueDays = fillDays(
      first,
      r.to,
      days.map((d) => ({ date: d.day, net: num(d.net), collected: num(d.collected) })),
      (date) => ({ date, net: 0, collected: 0 }),
    );
  }

  const tatByDept = [...groupBy(tat, (x) => x.department_id)].map(([id, list]) => {
    const d = deps.get(id);
    return { departmentId: id, code: d?.code ?? '', nameAr: d?.name_ar ?? '', nameEn: d?.name_en ?? '', ...tatStats(list), sort: d?.sort_order ?? 0 };
  });

  return {
    from: r.from,
    to: r.to,
    kpis: { orders: num(kpi?.orders), patients: num(kpi?.patients), tests: num(kpi?.tests), newPatients: num(kpi?.new_patients) },
    money,
    wip: {
      toCollect: num(wip?.to_collect),
      toReceive: num(wip?.to_receive),
      inAnalysis: num(wip?.in_analysis),
      toVerify: num(wip?.to_verify),
      toValidate: num(wip?.to_validate),
      toRelease: num(wip?.to_release),
      toDeliver: num(wip?.to_deliver),
    },
    criticals: {
      count: num(criticalCount?.n),
      items: criticalRows.map((c) => ({
        resultId: c.id as string,
        orderId: c.order_id as string,
        accession: c.accession as string,
        patientNameAr: c.full_name_ar as string,
        patientNameEn: (c.full_name_en as string | null) ?? null,
        analyteCode: c.code as string,
        analyteNameAr: c.name_ar as string,
        analyteNameEn: c.name_en as string,
        value: c.value_num !== null && c.value_num !== undefined ? formatValue(Number(c.value_num), Number(c.decimals ?? 1)) : ((c.value_text as string | null) ?? ''),
        unit: (c.unit as string | null) ?? null,
        flag: (c.flag as string | null) ?? null,
        at: new Date(c.at as string).toISOString(),
      })),
    },
    rejections: {
      count: rejectRows.reduce((a, x) => a + num(x.n), 0),
      byReason: rejectRows.map((x) => ({ reasonId: (x.id as string | null) ?? null, nameAr: (x.name_ar as string | null) ?? null, nameEn: (x.name_en as string | null) ?? null, count: num(x.n) })),
    },
    tat: { ...tatStats(tat), byDepartment: tatByDept.sort((a, b) => a.sort - b.sort).map(({ sort, ...x }) => (void sort, x)) },
    overdue: {
      count: num(overdueCount?.n),
      items: overdueRows.map((o) => {
        const due = new Date(o.due_at as string);
        return {
          itemId: o.id as string,
          orderId: o.order_id as string,
          accession: o.accession as string,
          priority: o.priority as string,
          patientNameAr: o.full_name_ar as string,
          patientNameEn: (o.full_name_en as string | null) ?? null,
          testCode: o.code as string,
          testNameAr: o.name_ar as string,
          testNameEn: o.name_en as string,
          status: o.status as string,
          dueAt: due.toISOString(),
          overdueMinutes: Math.max(0, Math.round((Date.now() - due.getTime()) / 60_000)),
        };
      }),
    },
    ordersByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, orders: hourMap.get(hour) ?? 0 })),
    testsByDepartment: byDept.map((d) => ({ departmentId: d.id as string, code: d.code as string, nameAr: d.name_ar as string, nameEn: d.name_en as string, tests: num(d.n) })),
    topTests: topTests.map((t) => ({ testId: t.id as string, code: t.code as string, nameAr: t.name_ar as string, nameEn: t.name_en as string, count: num(t.n) })),
    payerMix: payerRows.map((p) => ({
      payerGroupId: p.id as string,
      code: p.code as string,
      nameAr: p.name_ar as string,
      nameEn: p.name_en as string,
      kind: p.kind as string,
      orders: num(p.orders),
      net: showMoney ? num(p.net) : null,
    })),
    instruments: {
      counts: instrumentCounts,
      items: instrumentRows.map((i) => ({
        id: i.id as string,
        code: i.code as string,
        name: i.name as string,
        status: i.status as string,
        lastMessageAt: i.last_message_at ? new Date(i.last_message_at as string).toISOString() : null,
      })),
    },
    revenueDays,
  };
}

/* ================================================================== volume */

export async function volumeReport(r: Range): Promise<AnalyticsVolume> {
  const orderRange = inRange('o.created_at', r);
  const [tot] = await rowsOf<Record<string, string>>(sql`
    select
      (select count(*) from orders o where ${orderRange} and o.status <> 'cancelled') as orders,
      (select count(*) from order_items oi join orders o on o.id = oi.order_id where ${orderRange} and o.status <> 'cancelled' and oi.status <> 'cancelled') as tests,
      (select count(distinct o.patient_id) from orders o where ${orderRange} and o.status <> 'cancelled') as patients,
      (select count(*) from patients p where ${inRange('p.created_at', r)} and p.deleted_at is null and p.merged_into_id is null) as new_patients,
      (select count(*) from samples s join orders o on o.id = s.order_id where ${orderRange} and o.status <> 'cancelled') as samples`);
  const days = await rowsOf<Record<string, string>>(sql`
    select to_char((o.created_at at time zone ${r.tz})::date, 'YYYY-MM-DD') as day, count(distinct o.id) as orders,
      count(oi.id) filter (where oi.status <> 'cancelled') as tests, count(distinct o.patient_id) as patients
    from orders o left join order_items oi on oi.order_id = o.id
    where ${orderRange} and o.status <> 'cancelled' group by 1`);
  const hours = await rowsOf<Record<string, string>>(sql`
    select extract(hour from o.created_at at time zone ${r.tz})::int as hour, count(*) as n
    from orders o where ${orderRange} and o.status <> 'cancelled' group by 1`);
  const weekdays = await rowsOf<Record<string, string>>(sql`
    select extract(dow from o.created_at at time zone ${r.tz})::int as dow, count(*) as n
    from orders o where ${orderRange} and o.status <> 'cancelled' group by 1`);
  const byDept = await rowsOf<Record<string, string>>(sql`
    select d.id, d.code, d.name_ar, d.name_en, count(*) as n
    from order_items oi join orders o on o.id = oi.order_id join tests te on te.id = oi.test_id join departments d on d.id = te.department_id
    where ${orderRange} and o.status <> 'cancelled' and oi.status <> 'cancelled' group by d.id order by n desc`);
  const byTest = await rowsOf<Record<string, string>>(sql`
    select te.id, te.code, te.name_ar, te.name_en, count(*) as n
    from order_items oi join orders o on o.id = oi.order_id join tests te on te.id = oi.test_id
    where ${orderRange} and o.status <> 'cancelled' and oi.status <> 'cancelled' group by te.id order by n desc limit 40`);
  const bySource = await rowsOf<Record<string, string>>(sql`
    select o.source, count(*) as n from orders o where ${orderRange} and o.status <> 'cancelled' group by 1 order by n desc`);
  const byPriority = await rowsOf<Record<string, string>>(sql`
    select o.priority, count(*) as n from orders o where ${orderRange} and o.status <> 'cancelled' group by 1 order by n desc`);
  const hourMap = new Map(hours.map((h) => [Number(h.hour), num(h.n)]));
  const dowMap = new Map(weekdays.map((h) => [Number(h.dow), num(h.n)]));
  return {
    totals: { orders: num(tot?.orders), tests: num(tot?.tests), patients: num(tot?.patients), newPatients: num(tot?.new_patients), samples: num(tot?.samples) },
    byDay: fillDays(
      r.from,
      r.to,
      days.map((d) => ({ date: d.day!, orders: num(d.orders), tests: num(d.tests), patients: num(d.patients) })),
      (date) => ({ date, orders: 0, tests: 0, patients: 0 }),
    ),
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, orders: hourMap.get(hour) ?? 0 })),
    byWeekday: Array.from({ length: 7 }, (_, weekday) => ({ weekday, orders: dowMap.get(weekday) ?? 0 })),
    byDepartment: byDept.map((d) => ({ departmentId: d.id!, code: d.code!, nameAr: d.name_ar!, nameEn: d.name_en!, tests: num(d.n) })),
    byTest: byTest.map((t) => ({ testId: t.id!, code: t.code!, nameAr: t.name_ar!, nameEn: t.name_en!, count: num(t.n) })),
    bySource: bySource.map((s) => ({ source: s.source!, orders: num(s.n) })),
    byPriority: byPriority.map((s) => ({ priority: s.priority!, orders: num(s.n) })),
  };
}

/* ================================================================== revenue */

export async function revenueReport(r: Range): Promise<AnalyticsRevenue> {
  const invRange = inRange('i.created_at', r);
  const payRange = inRange('p.received_at', r);
  const [inv] = await rowsOf<Record<string, string>>(sql`
    select coalesce(sum(i.subtotal), 0) as billed, coalesce(sum(i.discount_total), 0) as discounts,
      coalesce(sum(i.patient_total), 0) as patient, coalesce(sum(i.insurer_total), 0) as insurer,
      coalesce(sum(greatest(i.patient_total - i.paid_total, 0)), 0) as outstanding
    from invoices i where ${invRange} and i.status <> 'void'`);
  const [pay] = await rowsOf<Record<string, string>>(sql`
    select coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) as collected, coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as refunds
    from payments p where ${payRange}`);
  const days = await rowsOf<{ day: string; net: string; collected: string }>(sql`
    with d as (
      select to_char((i.created_at at time zone ${r.tz})::date, 'YYYY-MM-DD') as day, sum(i.subtotal - i.discount_total) as net, 0::numeric as collected
      from invoices i where ${invRange} and i.status <> 'void' group by 1
      union all
      select to_char((p.received_at at time zone ${r.tz})::date, 'YYYY-MM-DD'), 0, sum(case when p.kind = 'payment' then p.amount else -p.amount end)
      from payments p where ${payRange} group by 1
    )
    select day, sum(net) as net, sum(collected) as collected from d group by day`);
  const payers = await rowsOf<Record<string, string>>(sql`
    select pg.id, pg.code, pg.name_ar, pg.name_en, pg.kind, count(*) as invoices, sum(i.subtotal - i.discount_total) as net,
      sum(i.patient_total) as patient, sum(i.insurer_total) as insurer, sum(i.paid_total) as paid,
      sum(greatest(i.patient_total - i.paid_total, 0)) as outstanding
    from invoices i join payer_groups pg on pg.id = i.payer_group_id
    where ${invRange} and i.status <> 'void' group by pg.id order by net desc`);
  const depts = await rowsOf<Record<string, string>>(sql`
    select d.id, d.code, d.name_ar, d.name_en, sum(l.price - l.discount) as net, count(*) as n
    from invoice_lines l join invoices i on i.id = l.invoice_id join order_items oi on oi.id = l.order_item_id
    join tests te on te.id = oi.test_id join departments d on d.id = te.department_id
    where ${invRange} and i.status <> 'void' group by d.id order by net desc`);
  const methods = await rowsOf<Record<string, unknown>>(sql`
    select m.id, m.code, m.name_ar, m.name_en, m.is_cash,
      coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) as payments, coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as refunds,
      count(*) filter (where p.kind = 'payment') as n
    from payments p join payment_methods m on m.id = p.method_id where ${payRange} group by m.id order by m.sort_order`);
  const tests = await rowsOf<Record<string, string>>(sql`
    select te.id, te.code, te.name_ar, te.name_en, count(*) as n, sum(l.price - l.discount) as net
    from invoice_lines l join invoices i on i.id = l.invoice_id join order_items oi on oi.id = l.order_item_id join tests te on te.id = oi.test_id
    where ${invRange} and i.status <> 'void' group by te.id order by net desc limit 25`);
  const byMethod: FinanceMethodTotal[] = methods.map((m) => ({
    methodId: m.id as string,
    code: m.code as string,
    nameAr: m.name_ar as string,
    nameEn: m.name_en as string,
    isCash: !!m.is_cash,
    payments: num(m.payments),
    refunds: num(m.refunds),
    net: num(m.payments) - num(m.refunds),
    count: num(m.n),
  }));
  return {
    totals: {
      billed: num(inv?.billed),
      discounts: num(inv?.discounts),
      net: num(inv?.billed) - num(inv?.discounts),
      patientShare: num(inv?.patient),
      insurerShare: num(inv?.insurer),
      collected: num(pay?.collected) - num(pay?.refunds),
      refunds: num(pay?.refunds),
      outstanding: num(inv?.outstanding),
    },
    byDay: fillDays(
      r.from,
      r.to,
      days.map((d) => ({ date: d.day, net: num(d.net), collected: num(d.collected) })),
      (date) => ({ date, net: 0, collected: 0 }),
    ),
    byPayer: payers.map((p) => ({
      payerGroupId: p.id!,
      code: p.code!,
      nameAr: p.name_ar!,
      nameEn: p.name_en!,
      kind: p.kind!,
      invoices: num(p.invoices),
      net: num(p.net),
      patient: num(p.patient),
      insurer: num(p.insurer),
      paid: num(p.paid),
      outstanding: num(p.outstanding),
    })),
    byDepartment: depts.map((d) => ({ departmentId: d.id!, code: d.code!, nameAr: d.name_ar!, nameEn: d.name_en!, net: num(d.net), tests: num(d.n) })),
    byMethod,
    topTests: tests.map((t) => ({ testId: t.id!, code: t.code!, nameAr: t.name_ar!, nameEn: t.name_en!, count: num(t.n), net: num(t.net) })),
  };
}

/* ================================================================== productivity */

export async function productivityReport(r: Range): Promise<AnalyticsProductivity> {
  const rows = await rowsOf<Record<string, unknown>>(sql`
    with w as (
      select entered_by as u, count(*) as entered, 0 as verified, 0 as validated, 0 as orders, 0 as collected, 0 as received
        from results where ${inRange('entered_at', r)} group by 1
      union all select verified_by, 0, count(*), 0, 0, 0, 0 from results where ${inRange('verified_at', r)} group by 1
      union all select validated_by, 0, 0, count(*), 0, 0, 0 from results where ${inRange('validated_at', r)} group by 1
      union all select created_by, 0, 0, 0, count(*), 0, 0 from orders where ${inRange('created_at', r)} group by 1
      union all select collected_by, 0, 0, 0, 0, count(*), 0 from samples where ${inRange('collected_at', r)} group by 1
      union all select received_by, 0, 0, 0, 0, 0, count(*) from samples where ${inRange('received_at', r)} group by 1
    )
    select w.u as user_id, u.full_name_ar, u.full_name_en, sum(entered) as entered, sum(verified) as verified, sum(validated) as validated,
      sum(orders) as orders, sum(collected) as collected, sum(received) as received
    from w left join users u on u.id = w.u
    group by w.u, u.full_name_ar, u.full_name_en
    order by sum(validated) + sum(verified) + sum(entered) desc, sum(orders) desc`);
  return {
    users: rows.map((x) => ({
      userId: (x.user_id as string | null) ?? null,
      nameAr: (x.full_name_ar as string | null) ?? null,
      nameEn: (x.full_name_en as string | null) ?? null,
      entered: num(x.entered),
      verified: num(x.verified),
      validated: num(x.validated),
      ordersCreated: num(x.orders),
      samplesCollected: num(x.collected),
      samplesReceived: num(x.received),
    })),
  };
}

/* ================================================================== rejections */

export async function rejectionsReport(r: Range): Promise<AnalyticsRejections> {
  const [tot] = await rowsOf<Record<string, string>>(sql`
    select count(*) filter (where ${inRange('s.rejected_at', r)}) as rejected,
      count(*) filter (where ${inRange('s.received_at', r)} or ${inRange('s.rejected_at', r)}) as evaluated
    from samples s where ${inRange('s.received_at', r)} or ${inRange('s.rejected_at', r)}`);
  const reasons = await rowsOf<Record<string, unknown>>(sql`
    select s.rejection_reason_id as id, rr.code, rr.name_ar, rr.name_en, count(*) as n
    from samples s left join rejection_reasons rr on rr.id = s.rejection_reason_id
    where ${inRange('s.rejected_at', r)} group by 1, 2, 3, 4 order by n desc`);
  const depts = await rowsOf<Record<string, unknown>>(sql`
    select s.department_id as id, d.name_ar, d.name_en, count(*) as n
    from samples s left join departments d on d.id = s.department_id
    where ${inRange('s.rejected_at', r)} group by 1, 2, 3 order by n desc`);
  const collectors = await rowsOf<Record<string, unknown>>(sql`
    select s.collected_by as id, u.full_name_ar, u.full_name_en, count(*) as n
    from samples s left join users u on u.id = s.collected_by
    where ${inRange('s.rejected_at', r)} group by 1, 2, 3 order by n desc`);
  const days = await rowsOf<{ day: string; n: string }>(sql`
    select to_char((s.rejected_at at time zone ${r.tz})::date, 'YYYY-MM-DD') as day, count(*) as n
    from samples s where ${inRange('s.rejected_at', r)} group by 1`);
  const recent = await rowsOf<Record<string, unknown>>(sql`
    select s.id, s.barcode, o.id as order_id, o.accession, p.full_name_ar, p.full_name_en, rr.name_ar as reason_ar, rr.name_en as reason_en,
      s.rejection_note, s.rejected_at, u.full_name_ar as by_ar, u.full_name_en as by_en
    from samples s join orders o on o.id = s.order_id join patients p on p.id = o.patient_id
    left join rejection_reasons rr on rr.id = s.rejection_reason_id left join users u on u.id = s.rejected_by
    where ${inRange('s.rejected_at', r)} order by s.rejected_at desc limit 25`);
  const rejected = num(tot?.rejected);
  const evaluated = num(tot?.evaluated);
  return {
    totals: { evaluated, rejected, ratePct: evaluated ? round1((100 * rejected) / evaluated) : null },
    byReason: reasons.map((x) => ({ reasonId: (x.id as string | null) ?? null, code: (x.code as string | null) ?? null, nameAr: (x.name_ar as string | null) ?? null, nameEn: (x.name_en as string | null) ?? null, count: num(x.n) })),
    byDepartment: depts.map((x) => ({ departmentId: (x.id as string | null) ?? null, nameAr: (x.name_ar as string | null) ?? null, nameEn: (x.name_en as string | null) ?? null, count: num(x.n) })),
    byCollector: collectors.map((x) => ({ userId: (x.id as string | null) ?? null, nameAr: (x.full_name_ar as string | null) ?? null, nameEn: (x.full_name_en as string | null) ?? null, count: num(x.n) })),
    byDay: fillDays(r.from, r.to, days.map((d) => ({ date: d.day, rejected: num(d.n) })), (date) => ({ date, rejected: 0 })),
    recent: recent.map((x) => ({
      sampleId: x.id as string,
      barcode: x.barcode as string,
      orderId: x.order_id as string,
      accession: x.accession as string,
      patientNameAr: x.full_name_ar as string,
      patientNameEn: (x.full_name_en as string | null) ?? null,
      reasonNameAr: (x.reason_ar as string | null) ?? null,
      reasonNameEn: (x.reason_en as string | null) ?? null,
      note: (x.rejection_note as string | null) ?? null,
      rejectedAt: new Date(x.rejected_at as string).toISOString(),
      rejectedByNameAr: (x.by_ar as string | null) ?? null,
      rejectedByNameEn: (x.by_en as string | null) ?? null,
    })),
  };
}

/* ================================================================== instruments */

export async function instrumentsReport(r: Range): Promise<AnalyticsInstruments> {
  const rows = await rowsOf<Record<string, unknown>>(sql`
    select i.id, i.code, i.name, i.model, i.status, i.integration_level, i.is_simulated, i.is_active, i.last_message_at,
      (select count(*) from integration_messages m where m.instrument_id = i.id and ${inRange('m.received_at', r)}) as messages,
      (select count(*) from integration_messages m where m.instrument_id = i.id and ${inRange('m.received_at', r)} and m.status = 'error') as errors,
      (select count(*) from integration_messages m where m.instrument_id = i.id and ${inRange('m.received_at', r)} and m.status in ('unmatched', 'partial')) as unmatched,
      (select count(*) from results x where x.instrument_id = i.id and ${inRange('x.entered_at', r)}) as results,
      (select count(*) from qc_runs q join qc_materials qm on qm.id = q.material_id where qm.instrument_id = i.id and ${inRange('q.run_at', r)}) as qc_runs,
      (select count(*) from qc_runs q join qc_materials qm on qm.id = q.material_id where qm.instrument_id = i.id and ${inRange('q.run_at', r)} and q.status = 'warning') as qc_warnings,
      (select count(*) from qc_runs q join qc_materials qm on qm.id = q.material_id where qm.instrument_id = i.id and ${inRange('q.run_at', r)} and q.status = 'rejected') as qc_rejected,
      (select max(ml.performed_at) from maintenance_logs ml where ml.instrument_id = i.id) as last_maintenance
    from instruments i order by i.is_active desc, i.code`);
  const counts: Record<string, number> = {};
  for (const i of rows) if (i.is_active) counts[i.status as string] = (counts[i.status as string] ?? 0) + 1;
  return {
    counts,
    items: rows.map((i) => ({
      id: i.id as string,
      code: i.code as string,
      name: i.name as string,
      model: i.model as string,
      status: i.status as string,
      integrationLevel: i.integration_level as string,
      isSimulated: !!i.is_simulated,
      isActive: !!i.is_active,
      lastMessageAt: i.last_message_at ? new Date(i.last_message_at as string).toISOString() : null,
      messages: num(i.messages),
      errors: num(i.errors),
      unmatched: num(i.unmatched),
      results: num(i.results),
      qcRuns: num(i.qc_runs),
      qcWarnings: num(i.qc_warnings),
      qcRejected: num(i.qc_rejected),
      lastMaintenanceAt: i.last_maintenance ? new Date(i.last_maintenance as string).toISOString() : null,
    })),
  };
}


import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { doctors, orders } from '@natija/db';
import type { AnalyticsDoctors, DoctorReferral, DoctorRow, DoctorUpsertInput } from '@natija/contracts';
import { normalizeText } from '@natija/domain';
import { ctx, db } from '../../db';
import { conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange } from '../../lib/http';
import { changes, countRows, num, record, rowsOf } from '../audit/kit';

type In<T extends z.ZodTypeAny> = z.output<T>;
const changed = () => publish({ type: 'doctors.changed' });

const columns = {
  id: doctors.id,
  nameAr: doctors.nameAr,
  nameEn: doctors.nameEn,
  specialtyAr: doctors.specialtyAr,
  specialtyEn: doctors.specialtyEn,
  phone: doctors.phone,
  clinic: doctors.clinic,
  notes: doctors.notes,
  isActive: doctors.isActive,
  orderCount: sql<number>`(select count(*)::int from orders o where o.doctor_id = "doctors"."id")`,
};

export async function listDoctors(f: { q?: string; active?: 'true' | 'false' | 'all' }): Promise<DoctorRow[]> {
  const where: SQL[] = [];
  if (f.active === 'true') where.push(eq(doctors.isActive, true));
  if (f.active === 'false') where.push(eq(doctors.isActive, false));
  if (f.q) {
    const raw = f.q.replace(/[%_]/g, '');
    const norm = normalizeText(f.q).replace(/[%_]/g, '');
    where.push(
      or(
        ilike(doctors.nameAr, `%${raw}%`),
        ilike(doctors.nameEn, `%${raw}%`),
        ilike(doctors.clinic, `%${raw}%`),
        ilike(doctors.phone, `%${raw}%`),
        ilike(doctors.specialtyAr, `%${raw}%`),
        ilike(doctors.specialtyEn, `%${raw}%`),
        norm ? ilike(doctors.nameAr, `%${norm}%`) : undefined,
      )!,
    );
  }
  return db()
    .select(columns)
    .from(doctors)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(doctors.nameAr));
}

async function getDoctor(id: string): Promise<DoctorRow> {
  const [row] = await db().select(columns).from(doctors).where(eq(doctors.id, id));
  if (!row) throw notFound();
  return row;
}

export async function createDoctor(input: In<typeof DoctorUpsertInput>) {
  const [row] = await db()
    .insert(doctors)
    .values({ labId: ctx().labId, ...input })
    .returning();
  await record({ action: 'doctors.created', entityType: 'doctor', entityId: row!.id, summary: row!.nameAr, after: input });
  changed();
  return getDoctor(row!.id);
}

export async function updateDoctor(id: string, input: In<typeof DoctorUpsertInput>) {
  const [before] = await db().select().from(doctors).where(eq(doctors.id, id));
  if (!before) throw notFound();
  await db().update(doctors).set(input).where(eq(doctors.id, id));
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) await record({ action: 'doctors.updated', entityType: 'doctor', entityId: id, summary: input.nameAr, ...diff });
  changed();
  return getDoctor(id);
}

export async function deleteDoctor(id: string) {
  const [before] = await db().select().from(doctors).where(eq(doctors.id, id));
  if (!before) throw notFound();
  if ((await countRows(orders, eq(orders.doctorId, id))) > 0) throw conflict('doctor_in_use', 'Orders reference this doctor; deactivate instead');
  await db().delete(doctors).where(eq(doctors.id, id));
  await record({ action: 'doctors.deleted', entityType: 'doctor', entityId: id, summary: before.nameAr, before });
  changed();
  return { ok: true };
}

/**
 * Referral statistics per doctor for orders created in the range: orders, distinct patients,
 * tests and net billed revenue. Orders without a doctor are reported as walk-in.
 */
export async function referrals(from: string | undefined, to: string | undefined, showMoney: boolean): Promise<AnalyticsDoctors> {
  const { start, end } = await dayRange(from, to);
  const rows = await rowsOf<{ doctor_id: string | null; orders: string; patients: string; tests: string; revenue: string }>(sql`
    with o as (
      select o.id, o.doctor_id, o.patient_id from orders o
      where o.created_at >= ${start.toISOString()}::timestamptz and o.created_at < ${end.toISOString()}::timestamptz and o.status <> 'cancelled'
    ),
    items as (
      select oi.order_id, count(*) as n from order_items oi join o on o.id = oi.order_id
      where oi.status <> 'cancelled' group by oi.order_id
    ),
    inv as (
      select i.order_id, sum(i.subtotal - i.discount_total) as net from invoices i join o on o.id = i.order_id
      where i.status <> 'void' group by i.order_id
    )
    select o.doctor_id, count(*) as orders, count(distinct o.patient_id) as patients,
      coalesce(sum(items.n), 0) as tests, coalesce(sum(inv.net), 0) as revenue
    from o left join items on items.order_id = o.id left join inv on inv.order_id = o.id
    group by o.doctor_id`);
  const people = new Map((await db().select().from(doctors)).map((d) => [d.id, d]));
  const toRow = (r: (typeof rows)[number]): DoctorReferral => {
    const d = r.doctor_id ? people.get(r.doctor_id) : undefined;
    return {
      doctorId: r.doctor_id,
      nameAr: d?.nameAr ?? null,
      nameEn: d?.nameEn ?? null,
      specialtyAr: d?.specialtyAr ?? null,
      specialtyEn: d?.specialtyEn ?? null,
      orders: num(r.orders),
      patients: num(r.patients),
      tests: num(r.tests),
      revenue: showMoney ? num(r.revenue) : null,
    };
  };
  const items = rows.filter((r) => r.doctor_id).map(toRow).sort((a, b) => b.orders - a.orders || (b.revenue ?? 0) - (a.revenue ?? 0));
  const walkInRow = rows.find((r) => !r.doctor_id);
  const walkIn: DoctorReferral = walkInRow
    ? toRow(walkInRow)
    : { doctorId: null, nameAr: null, nameEn: null, specialtyAr: null, specialtyEn: null, orders: 0, patients: 0, tests: 0, revenue: showMoney ? 0 : null };
  const totals = items.reduce(
    (acc, r) => ({ orders: acc.orders + r.orders, patients: acc.patients + r.patients, tests: acc.tests + r.tests, revenue: acc.revenue === null ? null : acc.revenue + (r.revenue ?? 0) }),
    { orders: 0, patients: 0, tests: 0, revenue: showMoney ? 0 : null } as AnalyticsDoctors['totals'],
  );
  return { items, totals, walkIn };
}

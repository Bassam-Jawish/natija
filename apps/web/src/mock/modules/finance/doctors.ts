/**
 * Referring doctors: port of apps/api/src/modules/doctors/{service,routes}.ts. The directory
 * (readable by any signed-in user for order entry), its upkeep, and referral statistics per
 * doctor, which also feed the analytics "doctors" report.
 */
import { z } from 'zod';
import { adminRangeQuery, DoctorUpsertInput } from '@natija/contracts';
import type { AnalyticsDoctors, DoctorReferral, DoctorRow } from '@natija/contracts';
import { normalizeText } from '@natija/domain';
import { conflict, notFound, now } from '../../core/context';
import { by, find, insert, remove, rows, update, type Row } from '../../core/db';
import { dayRange, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { changes, cents, record, textOf } from './util';

type In<T extends z.ZodTypeAny> = z.output<T>;
const changed = () => publish({ type: 'doctors.changed' });

function doctorOut(d: Row<'doctors'>): DoctorRow {
  return {
    id: d.id,
    nameAr: d.nameAr,
    nameEn: d.nameEn,
    specialtyAr: d.specialtyAr,
    specialtyEn: d.specialtyEn,
    phone: d.phone,
    clinic: d.clinic,
    notes: d.notes,
    isActive: d.isActive,
    orderCount: by('orders', 'doctorId', d.id).length,
  };
}

export function listDoctors(f: { q?: string; active?: 'true' | 'false' | 'all' }): DoctorRow[] {
  let list = rows('doctors').slice();
  if (f.active === 'true') list = list.filter((d) => d.isActive);
  if (f.active === 'false') list = list.filter((d) => !d.isActive);
  if (f.q) {
    const raw = f.q.replace(/[%_]/g, '').toLowerCase();
    const norm = normalizeText(f.q).replace(/[%_]/g, '');
    const has = (v: string | null, part: string) => (v ?? '').toLowerCase().includes(part);
    list = list.filter(
      (d) =>
        has(d.nameAr, raw) ||
        has(d.nameEn, raw) ||
        has(d.clinic, raw) ||
        has(d.phone, raw) ||
        has(d.specialtyAr, raw) ||
        has(d.specialtyEn, raw) ||
        (!!norm && has(d.nameAr, norm)),
    );
  }
  return list.sort((a, b) => (a.nameAr ?? '').localeCompare(b.nameAr ?? '', 'ar')).map(doctorOut);
}

function getDoctor(id: string): DoctorRow {
  const row = find('doctors', id);
  if (!row) throw notFound();
  return doctorOut(row);
}

export function createDoctor(input: In<typeof DoctorUpsertInput>): DoctorRow {
  const row = insert('doctors', { ...input, createdAt: now() });
  record({ action: 'doctors.created', entityType: 'doctor', entityId: row.id, summary: row.nameAr, after: input });
  changed();
  return getDoctor(row.id);
}

export function updateDoctor(id: string, input: In<typeof DoctorUpsertInput>): DoctorRow {
  const before = find('doctors', id);
  if (!before) throw notFound();
  const snapshot = { ...before };
  update('doctors', before, input);
  const diff = changes(snapshot as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) record({ action: 'doctors.updated', entityType: 'doctor', entityId: id, summary: input.nameAr, ...diff });
  changed();
  return getDoctor(id);
}

export function deleteDoctor(id: string): { ok: true } {
  const before = find('doctors', id);
  if (!before) throw notFound();
  if (by('orders', 'doctorId', id).length > 0) throw conflict('doctor_in_use', 'Orders reference this doctor; deactivate instead');
  remove('doctors', (d) => d.id === id);
  record({ action: 'doctors.deleted', entityType: 'doctor', entityId: id, summary: before.nameAr, before });
  changed();
  return { ok: true };
}

/**
 * Referral statistics per doctor for orders created in the range: orders, distinct patients,
 * tests and net billed revenue. Orders without a doctor are reported as walk-in.
 */
export function referrals(from: string | undefined, to: string | undefined, showMoney: boolean): AnalyticsDoctors {
  const { start, end } = dayRange(from, to);
  const s = start.getTime();
  const e = end.getTime();
  const groups = new Map<string | null, { orders: number; patients: Set<string>; tests: number; revenue: number }>();
  for (const o of rows('orders')) {
    const t = o.createdAt.getTime();
    if (t < s || t >= e || o.status === 'cancelled') continue;
    let g = groups.get(o.doctorId);
    if (!g) groups.set(o.doctorId, (g = { orders: 0, patients: new Set(), tests: 0, revenue: 0 }));
    g.orders += 1;
    g.patients.add(o.patientId);
    for (const item of by('orderItems', 'orderId', o.id)) if (item.status !== 'cancelled') g.tests += 1;
    for (const inv of by('invoices', 'orderId', o.id)) if (inv.status !== 'void') g.revenue += inv.subtotal - inv.discountTotal;
  }
  const toRow = (doctorId: string | null, g: { orders: number; patients: Set<string>; tests: number; revenue: number }): DoctorReferral => {
    const d = doctorId ? find('doctors', doctorId) : undefined;
    return {
      doctorId,
      nameAr: d?.nameAr ?? null,
      nameEn: d?.nameEn ?? null,
      specialtyAr: d?.specialtyAr ?? null,
      specialtyEn: d?.specialtyEn ?? null,
      orders: g.orders,
      patients: g.patients.size,
      tests: g.tests,
      revenue: showMoney ? cents(g.revenue) : null,
    };
  };
  const items = [...groups]
    .filter(([doctorId]) => doctorId)
    .map(([doctorId, g]) => toRow(doctorId, g))
    .sort((a, b) => b.orders - a.orders || (b.revenue ?? 0) - (a.revenue ?? 0));
  const walkInGroup = groups.get(null);
  const walkIn: DoctorReferral = walkInGroup
    ? toRow(null, walkInGroup)
    : { doctorId: null, nameAr: null, nameEn: null, specialtyAr: null, specialtyEn: null, orders: 0, patients: 0, tests: 0, revenue: showMoney ? 0 : null };
  const totals = items.reduce(
    (acc, r) => ({ orders: acc.orders + r.orders, patients: acc.patients + r.patients, tests: acc.tests + r.tests, revenue: acc.revenue === null ? null : acc.revenue + (r.revenue ?? 0) }),
    { orders: 0, patients: 0, tests: 0, revenue: showMoney ? 0 : null } as AnalyticsDoctors['totals'],
  );
  return { items, totals, walkIn };
}

/* ================================================================== routes */

/** The doctor form as typed: fields the server would refuse are kept as entered (mock mode takes any input). */
function doctorInput(body: unknown): In<typeof DoctorUpsertInput> {
  const input = parse(DoctorUpsertInput, body) as Partial<In<typeof DoctorUpsertInput>>;
  const raw = (body ?? {}) as Record<string, unknown>;
  const opt = (parsed: string | null | undefined, value: unknown) => {
    const v = textOf(parsed, value);
    return v ? v : null;
  };
  return {
    nameAr: textOf(input.nameAr, raw.nameAr) || textOf(input.nameEn, raw.nameEn),
    nameEn: opt(input.nameEn, raw.nameEn),
    specialtyAr: opt(input.specialtyAr, raw.specialtyAr),
    specialtyEn: opt(input.specialtyEn, raw.specialtyEn),
    phone: opt(input.phone, raw.phone),
    clinic: opt(input.clinic, raw.clinic),
    notes: opt(input.notes, raw.notes),
    isActive: typeof input.isActive === 'boolean' ? input.isActive : raw.isActive !== false,
  };
}

/** Referring doctors: directory and referral statistics. */
export function registerDoctorRoutes(): void {
  const manage = { perm: 'doctors.manage' };

  route('GET', '/doctors', (req) =>
    listDoctors(parse(z.object({ q: z.string().trim().max(80).optional(), active: z.enum(['true', 'false', 'all']).default('all') }), req.query)),
  );
  route('POST', '/doctors', manage, (req) => createDoctor(doctorInput(req.body)));
  route('PUT', '/doctors/:id', manage, (req) => updateDoctor(req.params.id!, doctorInput(req.body)));
  route('DELETE', '/doctors/:id', manage, (req) => deleteDoctor(req.params.id!));

  route('GET', '/doctors/referrals', { perm: ['doctors.manage', 'analytics.read'] }, (req) => {
    const q = parse(adminRangeQuery, req.query);
    return referrals(q.from, q.to, req.auth!.permissions.has('finance.read'));
  });
}

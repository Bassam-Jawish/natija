/**
 * Payer groups, per-test price overrides, the price list and bulk unit-price changes (port of
 * apps/api/src/modules/pricing). Payer groups are readable by any signed-in user (order entry).
 * The price-list export comes out as CSV in mock mode, laid out like the server's workbook.
 */
import { z } from 'zod';
import { priceTest, roundMoney, splitLine } from '@natija/domain';
import {
  PricingBulkUnitPriceInput,
  PricingOverrideInput,
  PricingPayerGroupInput,
  type PricingBulkResult,
  type PricingCell,
  type PricingOverride,
  type PricingPayerGroup,
  type PricingPriceList,
} from '@natija/contracts';
import { conflict, notFound, now } from '../../core/context';
import { by, find, insert, remove, rows, update, type Row } from '../../core/db';
import { csvFile } from '../../core/file';
import { getLab, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { assertUnique, changes, cmp, contains, fieldError, input, likeTerm, record, startsWith } from './kit';

type In<T extends z.ZodTypeAny> = z.output<T>;
const changed = (kind: string) => publish({ type: 'pricing.changed', data: { kind } });

function countBy(values: Array<string | null | undefined>): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) if (v) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}

function payerOut(p: Row<'payerGroups'>, overrides: Map<string, number>, orders: Map<string, number>): PricingPayerGroup {
  return {
    id: p.id,
    code: p.code,
    nameAr: p.nameAr,
    nameEn: p.nameEn,
    kind: p.kind,
    unitPrice: p.unitPrice,
    patientSharePct: p.patientSharePct,
    discountPct: p.discountPct,
    onAccount: p.onAccount,
    organization: p.organization,
    contactName: p.contactName,
    phone: p.phone,
    isActive: p.isActive,
    overrideCount: overrides.get(p.id) ?? 0,
    orderCount: orders.get(p.id) ?? 0,
  };
}

export function listPayerGroups(f: { active?: boolean } = {}): PricingPayerGroup[] {
  const overrides = countBy(rows('priceOverrides').map((o) => o.payerGroupId));
  const orders = countBy(rows('orders').map((o) => o.payerGroupId));
  return rows('payerGroups')
    .filter((p) => !f.active || p.isActive)
    .sort((a, b) => cmp(a.kind, b.kind) || cmp(a.code, b.code))
    .map((p) => payerOut(p, overrides, orders));
}

function getPayer(id: string): PricingPayerGroup {
  const p = find('payerGroups', id);
  if (!p) throw notFound();
  return payerOut(p, new Map([[id, by('priceOverrides', 'payerGroupId', id).length]]), new Map([[id, by('orders', 'payerGroupId', id).length]]));
}

export function createPayerGroup(input: In<typeof PricingPayerGroupInput>): PricingPayerGroup {
  assertUnique('payerGroups', 'code', input.code, 'payer_groups_code_uq');
  const row = insert('payerGroups', input);
  record({ action: 'pricing.payer.created', entityType: 'payer_group', entityId: row.id, summary: `${row.code} · ${row.nameEn}`, after: input });
  changed('payer');
  return getPayer(row.id);
}

export function updatePayerGroup(id: string, input: In<typeof PricingPayerGroupInput>): PricingPayerGroup {
  const row = find('payerGroups', id);
  if (!row) throw notFound();
  assertUnique('payerGroups', 'code', input.code, 'payer_groups_code_uq', id);
  const before = { ...row };
  update('payerGroups', row, input);
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) record({ action: 'pricing.payer.updated', entityType: 'payer_group', entityId: id, summary: `${input.code} · ${input.nameEn}`, ...diff });
  changed('payer');
  return getPayer(id);
}

export function deletePayerGroup(id: string) {
  const before = find('payerGroups', id);
  if (!before) throw notFound();
  if (by('orders', 'payerGroupId', id).length > 0) throw conflict('payer_in_use', 'Orders use this payer group; deactivate it instead');
  remove('payerGroups', (p) => p.id === id);
  remove('priceOverrides', (o) => o.payerGroupId === id);
  record({ action: 'pricing.payer.deleted', entityType: 'payer_group', entityId: id, summary: `${before.code} · ${before.nameEn}`, before });
  changed('payer');
  return { ok: true };
}

/* ------------------------------------------------------------------ overrides */

export function listOverrides(payerGroupId?: string): PricingOverride[] {
  const currency = getLab().currency;
  const out: PricingOverride[] = [];
  for (const o of payerGroupId ? by('priceOverrides', 'payerGroupId', payerGroupId) : rows('priceOverrides')) {
    const test = find('tests', o.testId);
    const payer = find('payerGroups', o.payerGroupId);
    if (!test || !payer) continue;
    out.push({
      id: o.id,
      payerGroupId: o.payerGroupId,
      testId: o.testId,
      price: o.price,
      testCode: test.code,
      testNameAr: test.nameAr,
      testNameEn: test.nameEn,
      computedPrice: priceTest({ units: test.units, fixedPrice: test.fixedPrice }, { unitPrice: payer.unitPrice, patientSharePct: 100, discountPct: 0 }, currency).price,
    });
  }
  return out.sort((a, b) => cmp(a.testCode, b.testCode));
}

export function upsertOverride(input: In<typeof PricingOverrideInput>): Row<'priceOverrides'> {
  const payer = find('payerGroups', input.payerGroupId);
  if (!payer) fieldError('payerGroupId', 'not_found');
  const test = find('tests', input.testId);
  if (!test) fieldError('testId', 'not_found');
  const existing = by('priceOverrides', 'payerGroupId', input.payerGroupId).find((o) => o.testId === input.testId);
  const before = existing ? { price: existing.price } : undefined;
  const row = existing ? update('priceOverrides', existing, { price: input.price }) : insert('priceOverrides', input);
  record({
    action: existing ? 'pricing.override.updated' : 'pricing.override.created',
    entityType: 'price_override',
    entityId: row.id,
    summary: `${payer.code} · ${test.code}`,
    before,
    after: { payerGroupId: input.payerGroupId, testId: input.testId, price: input.price },
  });
  changed('override');
  return row;
}

export function deleteOverride(id: string) {
  const before = find('priceOverrides', id);
  if (!before) throw notFound();
  remove('priceOverrides', (o) => o.id === id);
  record({ action: 'pricing.override.deleted', entityType: 'price_override', entityId: id, before });
  changed('override');
  return { ok: true };
}

/* ------------------------------------------------------------------ price list */

export function priceList(f: { payerGroupId?: string; q?: string; departmentId?: string; includeInactive?: boolean }): PricingPriceList {
  const currency = getLab().currency;
  const payers = listPayerGroups({ active: !f.payerGroupId }).filter((p) => !f.payerGroupId || p.id === f.payerGroupId);
  const term = f.q ? likeTerm(f.q) : '';
  const tests = rows('tests')
    .filter((t) => {
      if (!f.includeInactive && !t.isActive) return false;
      if (f.departmentId && t.departmentId !== f.departmentId) return false;
      if (f.q && !(startsWith(t.code, term) || contains(t.nameEn, term) || contains(t.nameAr, term))) return false;
      return true;
    })
    .map((t) => ({ t, dept: find('departments', t.departmentId) }))
    .filter((x): x is { t: Row<'tests'>; dept: Row<'departments'> } => !!x.dept)
    .sort((a, b) => cmp(a.dept.sortOrder, b.dept.sortOrder) || cmp(a.t.sortOrder, b.t.sortOrder) || cmp(a.t.code, b.t.code));
  const payerIds = new Set(payers.map((p) => p.id));
  const ov = new Map(rows('priceOverrides').filter((o) => payerIds.has(o.payerGroupId)).map((o) => [`${o.payerGroupId}|${o.testId}`, o.price]));
  return {
    payers,
    rows: tests.map(({ t }) => {
      const prices: Record<string, PricingCell> = {};
      for (const p of payers) {
        const override = ov.get(`${p.id}|${t.id}`);
        const { price } = priceTest({ units: t.units, fixedPrice: t.fixedPrice, overridePrice: override ?? null }, p, currency);
        const split = splitLine(price, p, 0, currency);
        prices[p.id] = {
          price,
          net: split.net,
          patientShare: split.patientShare,
          insurerShare: split.insurerShare,
          source: override !== undefined ? 'override' : t.fixedPrice !== null ? 'fixed' : 'units',
        };
      }
      return { testId: t.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn, departmentId: t.departmentId, units: t.units, fixedPrice: t.fixedPrice, prices };
    }),
  };
}

/* ------------------------------------------------------------------ bulk unit price */

/** Set or raise the unit price of several payer groups at once (e.g. a yearly price update). */
export function bulkUnitPrice(input: In<typeof PricingBulkUnitPriceInput>): PricingBulkResult {
  const ids = new Set(input.payerGroupIds ?? []);
  const list = rows('payerGroups').filter((p) => ids.has(p.id));
  if (list.length !== ids.size) fieldError('payerGroupIds', 'not_found');
  const currency = getLab().currency;
  const roundTo = input.roundTo || 1;
  const out: PricingBulkResult['changes'] = [];
  for (const p of list) {
    const raw = input.mode === 'set' ? input.value : p.unitPrice * (1 + input.value / 100);
    const rounded = Math.max(0, Math.round(raw / roundTo) * roundTo);
    const after = roundTo === 1 ? roundMoney(rounded, currency) : rounded;
    if (after === p.unitPrice || !Number.isFinite(after)) continue;
    const before = p.unitPrice;
    update('payerGroups', p, { unitPrice: after });
    record({
      action: 'pricing.unit_price.bulk',
      entityType: 'payer_group',
      entityId: p.id,
      summary: `${p.code}: ${before} → ${after}${input.reason ? ` · ${input.reason}` : ''}`,
      before: { unitPrice: before },
      after: { unitPrice: after, mode: input.mode, value: input.value, roundTo: input.roundTo },
    });
    out.push({ payerGroupId: p.id, code: p.code, before, after });
  }
  if (out.length) changed('payer');
  return { changes: out };
}

/* ------------------------------------------------------------------ routes */

const priceListQuery = z.object({
  payerGroupId: z.string().uuid().optional(),
  q: z.string().trim().max(80).optional(),
  departmentId: z.string().uuid().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

/** The server's Excel export, as CSV: title, date, a blank row, the header, then one row per test. */
function exportPriceList(query: unknown) {
  const q = parse(priceListQuery.extend({ lang: z.enum(['ar', 'en']).default('ar') }), query);
  const lab = getLab();
  const list = priceList({ ...q, includeInactive: q.includeInactive === 'true' });
  const lang = q.lang ?? 'ar';
  const L = (en: string, ar: string) => (lang === 'ar' ? ar : en);
  const nm = (r: { nameAr: string; nameEn: string }) => (lang === 'ar' ? r.nameAr : r.nameEn);
  const day = now().toISOString().slice(0, 10);
  return csvFile(`natija-price-list-${day}.xlsx`, [
    [`${lang === 'ar' ? lab.nameAr : lab.nameEn} · ${L('Price list', 'لائحة الأسعار')}`],
    [day],
    [],
    [L('Code', 'الرمز'), L('Test', 'التحليل'), L('Department', 'القسم'), L('Units', 'الوحدات'), ...list.payers.map(nm)],
    ...list.rows.map((r) => {
      const dept = find('departments', r.departmentId);
      return [r.code, nm(r), dept ? nm(dept) : '', r.units, ...list.payers.map((p) => r.prices[p.id]?.price ?? null)];
    }),
  ]);
}

export function registerPricing(): void {
  const manage = { perm: 'pricing.manage' };
  const readList = { perm: ['pricing.manage', 'finance.read', 'orders.create'] };

  route('GET', '/pricing/payer-groups', (req) => listPayerGroups({ active: parse(z.object({ active: z.enum(['true', 'false']).optional() }), req.query).active === 'true' }));
  route('POST', '/pricing/payer-groups', manage, (req) => createPayerGroup(input(PricingPayerGroupInput, req.body)));
  route('PUT', '/pricing/payer-groups/:id', manage, (req) => updatePayerGroup(req.params.id, input(PricingPayerGroupInput, req.body)));
  route('DELETE', '/pricing/payer-groups/:id', manage, (req) => deletePayerGroup(req.params.id));

  route('GET', '/pricing/overrides', manage, (req) => listOverrides(parse(z.object({ payerGroupId: z.string().uuid().optional() }), req.query).payerGroupId));
  route('PUT', '/pricing/overrides', manage, (req) => upsertOverride(input(PricingOverrideInput, req.body)));
  route('DELETE', '/pricing/overrides/:id', manage, (req) => deleteOverride(req.params.id));

  route('GET', '/pricing/price-list', readList, (req) => {
    const q = parse(priceListQuery, req.query);
    return priceList({ ...q, includeInactive: q.includeInactive === 'true' });
  });
  route('GET', '/pricing/price-list/export', readList, (req) => exportPriceList(req.query));

  route('POST', '/pricing/bulk-unit-price', manage, (req) => bulkUnitPrice(input(PricingBulkUnitPriceInput, req.body)));
}

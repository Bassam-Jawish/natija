import { and, asc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { departments, orders, payerGroups, priceOverrides, tests } from '@natija/db';
import { priceTest, roundMoney, splitLine } from '@natija/domain';
import type {
  PricingBulkResult,
  PricingBulkUnitPriceInput,
  PricingCell,
  PricingOverride,
  PricingOverrideInput,
  PricingPayerGroup,
  PricingPayerGroupInput,
  PricingPriceList,
} from '@natija/contracts';
import { ctx, db } from '../../db';
import { conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { getLab } from '../../lib/lab';
import { changes, countRows, fieldError, record } from '../audit/kit';

type In<T extends z.ZodTypeAny> = z.output<T>;
const changed = (kind: string) => publish({ type: 'pricing.changed', data: { kind } });

const payerColumns = {
  id: payerGroups.id,
  code: payerGroups.code,
  nameAr: payerGroups.nameAr,
  nameEn: payerGroups.nameEn,
  kind: payerGroups.kind,
  unitPrice: payerGroups.unitPrice,
  patientSharePct: payerGroups.patientSharePct,
  discountPct: payerGroups.discountPct,
  onAccount: payerGroups.onAccount,
  organization: payerGroups.organization,
  contactName: payerGroups.contactName,
  phone: payerGroups.phone,
  isActive: payerGroups.isActive,
  overrideCount: sql<number>`(select count(*)::int from price_overrides po where po.payer_group_id = "payer_groups"."id")`,
  orderCount: sql<number>`(select count(*)::int from orders o where o.payer_group_id = "payer_groups"."id")`,
};

export async function listPayerGroups(f: { active?: boolean } = {}): Promise<PricingPayerGroup[]> {
  return db()
    .select(payerColumns)
    .from(payerGroups)
    .where(f.active ? eq(payerGroups.isActive, true) : undefined)
    .orderBy(asc(payerGroups.kind), asc(payerGroups.code));
}

async function getPayer(id: string): Promise<PricingPayerGroup> {
  const [row] = await db().select(payerColumns).from(payerGroups).where(eq(payerGroups.id, id));
  if (!row) throw notFound();
  return row;
}

export async function createPayerGroup(input: In<typeof PricingPayerGroupInput>) {
  const [row] = await db()
    .insert(payerGroups)
    .values({ labId: ctx().labId, ...input })
    .returning();
  await record({ action: 'pricing.payer.created', entityType: 'payer_group', entityId: row!.id, summary: `${row!.code} · ${row!.nameEn}`, after: input });
  changed('payer');
  return getPayer(row!.id);
}

export async function updatePayerGroup(id: string, input: In<typeof PricingPayerGroupInput>) {
  const [before] = await db().select().from(payerGroups).where(eq(payerGroups.id, id));
  if (!before) throw notFound();
  await db().update(payerGroups).set(input).where(eq(payerGroups.id, id));
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) await record({ action: 'pricing.payer.updated', entityType: 'payer_group', entityId: id, summary: `${input.code} · ${input.nameEn}`, ...diff });
  changed('payer');
  return getPayer(id);
}

export async function deletePayerGroup(id: string) {
  const [before] = await db().select().from(payerGroups).where(eq(payerGroups.id, id));
  if (!before) throw notFound();
  if ((await countRows(orders, eq(orders.payerGroupId, id))) > 0) throw conflict('payer_in_use', 'Orders use this payer group; deactivate it instead');
  await db().delete(payerGroups).where(eq(payerGroups.id, id));
  await record({ action: 'pricing.payer.deleted', entityType: 'payer_group', entityId: id, summary: `${before.code} · ${before.nameEn}`, before });
  changed('payer');
  return { ok: true };
}

/* ------------------------------------------------------------------ overrides */

export async function listOverrides(payerGroupId?: string): Promise<PricingOverride[]> {
  const currency = (await getLab(ctx().labId)).currency;
  const rows = await db()
    .select({
      id: priceOverrides.id,
      payerGroupId: priceOverrides.payerGroupId,
      testId: priceOverrides.testId,
      price: priceOverrides.price,
      testCode: tests.code,
      testNameAr: tests.nameAr,
      testNameEn: tests.nameEn,
      units: tests.units,
      fixedPrice: tests.fixedPrice,
      unitPrice: payerGroups.unitPrice,
    })
    .from(priceOverrides)
    .innerJoin(tests, eq(tests.id, priceOverrides.testId))
    .innerJoin(payerGroups, eq(payerGroups.id, priceOverrides.payerGroupId))
    .where(payerGroupId ? eq(priceOverrides.payerGroupId, payerGroupId) : undefined)
    .orderBy(asc(tests.code));
  return rows.map(({ units, fixedPrice, unitPrice, ...r }) => ({
    ...r,
    computedPrice: priceTest({ units, fixedPrice }, { unitPrice, patientSharePct: 100, discountPct: 0 }, currency).price,
  }));
}

export async function upsertOverride(input: In<typeof PricingOverrideInput>) {
  const [payer] = await db().select({ id: payerGroups.id, code: payerGroups.code }).from(payerGroups).where(eq(payerGroups.id, input.payerGroupId));
  if (!payer) fieldError('payerGroupId', 'not_found');
  const [test] = await db().select({ id: tests.id, code: tests.code }).from(tests).where(eq(tests.id, input.testId));
  if (!test) fieldError('testId', 'not_found');
  const [existing] = await db()
    .select()
    .from(priceOverrides)
    .where(and(eq(priceOverrides.payerGroupId, input.payerGroupId), eq(priceOverrides.testId, input.testId)));
  const [row] = await db()
    .insert(priceOverrides)
    .values({ labId: ctx().labId, ...input })
    .onConflictDoUpdate({ target: [priceOverrides.payerGroupId, priceOverrides.testId], set: { price: input.price } })
    .returning();
  await record({
    action: existing ? 'pricing.override.updated' : 'pricing.override.created',
    entityType: 'price_override',
    entityId: row!.id,
    summary: `${payer!.code} · ${test!.code}`,
    before: existing ? { price: existing.price } : undefined,
    after: { payerGroupId: input.payerGroupId, testId: input.testId, price: input.price },
  });
  changed('override');
  return row!;
}

export async function deleteOverride(id: string) {
  const [before] = await db().select().from(priceOverrides).where(eq(priceOverrides.id, id));
  if (!before) throw notFound();
  await db().delete(priceOverrides).where(eq(priceOverrides.id, id));
  await record({ action: 'pricing.override.deleted', entityType: 'price_override', entityId: id, before });
  changed('override');
  return { ok: true };
}

/* ------------------------------------------------------------------ price list */

export async function priceList(f: { payerGroupId?: string; q?: string; departmentId?: string; includeInactive?: boolean }): Promise<PricingPriceList> {
  const currency = (await getLab(ctx().labId)).currency;
  const payers = (await listPayerGroups({ active: !f.payerGroupId })).filter((p) => !f.payerGroupId || p.id === f.payerGroupId);
  const where: SQL[] = [];
  if (!f.includeInactive) where.push(eq(tests.isActive, true));
  if (f.departmentId) where.push(eq(tests.departmentId, f.departmentId));
  if (f.q) {
    const term = f.q.replace(/[%_]/g, '');
    where.push(or(ilike(tests.code, `${term}%`), ilike(tests.nameEn, `%${term}%`), ilike(tests.nameAr, `%${term}%`))!);
  }
  const testRows = await db()
    .select({
      testId: tests.id,
      code: tests.code,
      nameAr: tests.nameAr,
      nameEn: tests.nameEn,
      departmentId: tests.departmentId,
      units: tests.units,
      fixedPrice: tests.fixedPrice,
      deptOrder: departments.sortOrder,
    })
    .from(tests)
    .innerJoin(departments, eq(departments.id, tests.departmentId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(departments.sortOrder), asc(tests.sortOrder), asc(tests.code));
  const overrides = payers.length
    ? await db()
        .select({ payerGroupId: priceOverrides.payerGroupId, testId: priceOverrides.testId, price: priceOverrides.price })
        .from(priceOverrides)
        .where(inArray(priceOverrides.payerGroupId, payers.map((p) => p.id)))
    : [];
  const ov = new Map(overrides.map((o) => [`${o.payerGroupId}|${o.testId}`, o.price]));
  return {
    payers,
    rows: testRows.map(({ deptOrder, ...t }) => {
      void deptOrder;
      const prices: Record<string, PricingCell> = {};
      for (const p of payers) {
        const override = ov.get(`${p.id}|${t.testId}`);
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
      return { ...t, prices };
    }),
  };
}

/* ------------------------------------------------------------------ bulk unit price */

/** Set or raise the unit price of several payer groups at once (e.g. a yearly price update). */
export async function bulkUnitPrice(input: In<typeof PricingBulkUnitPriceInput>): Promise<PricingBulkResult> {
  const rows = await db().select().from(payerGroups).where(inArray(payerGroups.id, input.payerGroupIds));
  if (rows.length !== new Set(input.payerGroupIds).size) fieldError('payerGroupIds', 'not_found');
  const currency = (await getLab(ctx().labId)).currency;
  const out: PricingBulkResult['changes'] = [];
  for (const p of rows) {
    const raw = input.mode === 'set' ? input.value : p.unitPrice * (1 + input.value / 100);
    const rounded = Math.max(0, Math.round(raw / input.roundTo) * input.roundTo);
    const after = input.roundTo === 1 ? roundMoney(rounded, currency) : rounded;
    if (after === p.unitPrice) continue;
    await db().update(payerGroups).set({ unitPrice: after }).where(eq(payerGroups.id, p.id));
    await record({
      action: 'pricing.unit_price.bulk',
      entityType: 'payer_group',
      entityId: p.id,
      summary: `${p.code}: ${p.unitPrice} → ${after}${input.reason ? ` · ${input.reason}` : ''}`,
      before: { unitPrice: p.unitPrice },
      after: { unitPrice: after, mode: input.mode, value: input.value, roundTo: input.roundTo },
    });
    out.push({ payerGroupId: p.id, code: p.code, before: p.unitPrice, after });
  }
  if (out.length) changed('payer');
  return { changes: out };
}

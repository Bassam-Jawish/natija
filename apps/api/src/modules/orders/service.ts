/**
 * Orders at the front desk: the reception form data, quotes, creating an order (lines, tubes,
 * results, invoice, optional payment), editing, adding and removing tests, cancelling, labels,
 * the receipt and the activity trail. Every function runs inside the current lab context.
 */
import { randomInt } from 'node:crypto';
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  analytes,
  approvals,
  auditLog,
  branches,
  containers,
  deliveries,
  departments,
  doctors,
  invoices,
  orderItems,
  orders,
  packageTests,
  packages,
  patients,
  payerGroups,
  paymentMethods,
  payments,
  priceOverrides,
  reports,
  results,
  sampleEvents,
  samples,
  sampleTypes,
  testAnalytes,
  tests,
  users,
  type Order,
} from '@natija/db';
import { accessionFor, dateKey, portalCode, roundMoney, tubeBarcode } from '@natija/domain';
import type {
  ActivityEntry,
  CancelResult,
  ItemsChanged,
  OrderCreated,
  OrderDetail,
  OrderFormData,
  OrderItemRow,
  OrderLabels,
  OrderListItem,
  OrderQuote,
  OrderReceipt,
  OrderTube,
  QuoteWarning,
  ResultCounts,
  addItemsInput,
  orderCreateInput,
  orderListQuery,
  orderQuoteInput,
  orderUpdateInput,
} from '@natija/contracts';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { nextCounter } from '../../lib/counters';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange } from '../../lib/http';
import { getLab } from '../../lib/lab';
import { notifyPermission } from '../../lib/notify';
import { refreshOrderStatus } from '../../services/order-status';
import {
  balanceOf,
  createDiscountApproval,
  currentCashSession,
  getInvoiceDetail,
  recomputeInvoice,
  refreshInvoiceTotals,
  takePayment,
  type InvoiceTotals,
} from '../billing/service';
import { escapeLike, patientSearchCondition, toSummary } from '../patients/search';
import { analyteOverlaps, loadPayer, loadTests, planTubes, priceItems, quoteResult, totalsOf, type PricedLine } from './pricing';

export type CreateOrderInput = z.output<typeof orderCreateInput>;
export type QuoteInput = z.output<typeof orderQuoteInput>;
export type OrderListQuery = z.output<typeof orderListQuery>;
export type UpdateOrderInput = z.output<typeof orderUpdateInput>;
export type AddItemsInput = z.output<typeof addItemsInput>;

const DEAD_TUBE = ['rejected', 'disposed'] as const;

/* ------------------------------------------------------------------ helpers */

async function lockOrder(id: string): Promise<Order> {
  const [order] = await db().select().from(orders).where(eq(orders.id, id)).for('update');
  if (!order) throw notFound('order_not_found');
  return order;
}

function assertActive(order: Order) {
  if (order.status === 'cancelled') throw conflict('order_cancelled', 'The order is cancelled.');
}

async function bumpVersion(orderId: string) {
  await db()
    .update(orders)
    .set({ updatedAt: new Date(), version: sql`${orders.version} + 1` })
    .where(eq(orders.id, orderId));
}

function newPortalCode(): string {
  return portalCode(() => randomInt(0, 1_000_000) / 1_000_000);
}

/** Insert planned tubes ("pending", with a "created" event). Returns line key → tube id. */
async function insertTubes(order: Pick<Order, 'id' | 'accession'>, plans: ReturnType<typeof planTubes>): Promise<Map<string, string>> {
  const { labId, userId } = ctx();
  const out = new Map<string, string>();
  if (!plans.length) return out;
  const rows = await db()
    .insert(samples)
    .values(
      plans.map((p) => ({
        labId,
        orderId: order.id,
        barcode: tubeBarcode(order.accession, p.seq),
        seq: p.seq,
        containerId: p.containerId,
        sampleTypeId: p.sampleTypeId,
        departmentId: p.departmentId,
        status: 'pending' as const,
      })),
    )
    .returning({ id: samples.id, seq: samples.seq });
  const bySeq = new Map(rows.map((r) => [r.seq, r.id]));
  await db()
    .insert(sampleEvents)
    .values(rows.map((r) => ({ labId, sampleId: r.id, type: 'created' as const, userId })));
  for (const p of plans) for (const key of p.lineKeys) out.set(key, bySeq.get(p.seq)!);
  return out;
}

/** Insert order lines with their price snapshot, and one pending result per analyte. */
async function insertLines(orderId: string, lines: PricedLine[], tubeByKey: Map<string, string>): Promise<void> {
  const { labId } = ctx();
  if (!lines.length) return;
  const rows = await db()
    .insert(orderItems)
    .values(
      lines.map((l) => ({
        labId,
        orderId,
        testId: l.testId,
        packageId: l.packageId,
        sampleId: tubeByKey.get(l.key) ?? null,
        status: 'ordered' as const,
        units: l.units,
        unitPrice: l.unitPrice,
        price: l.price,
        discount: l.discount,
        isExternal: l.isExternal,
      })),
    )
    .returning({ id: orderItems.id, testId: orderItems.testId });
  const itemByTest = new Map(rows.map((r) => [r.testId, r.id]));
  const resultRows = lines.flatMap((l) =>
    l.test.analytes.map((a) => ({ labId, orderId, orderItemId: itemByTest.get(l.testId)!, analyteId: a.id, status: 'pending' as const, unit: a.unit })),
  );
  if (resultRows.length) await db().insert(results).values(resultRows);
}

/**
 * A tube nobody needs any more: deleted while it is still waiting to be drawn,
 * otherwise marked disposed (it exists physically) with an event explaining why.
 */
async function retireTube(sampleId: string, note: string, opts: { deletePending: boolean }): Promise<void> {
  const tx = db();
  const { labId, userId } = ctx();
  const [tube] = await tx.select().from(samples).where(eq(samples.id, sampleId));
  if (!tube || (DEAD_TUBE as readonly string[]).includes(tube.status)) return;
  if (tube.status === 'pending' && opts.deletePending) {
    await tx.update(orderItems).set({ sampleId: null }).where(eq(orderItems.sampleId, sampleId));
    await tx.delete(samples).where(eq(samples.id, sampleId));
    return;
  }
  await tx.update(samples).set({ status: 'disposed', disposedAt: new Date(), disposedBy: userId }).where(eq(samples.id, sampleId));
  await tx.insert(sampleEvents).values({ labId, sampleId, type: 'disposed', userId, note });
}

function emptyCounts(): ResultCounts {
  return { total: 0, pending: 0, resulted: 0, verified: 0, validated: 0, released: 0, critical: 0 };
}

async function userNames(ids: Array<string | null>) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, { id: string; fullNameAr: string; fullNameEn: string }>();
  const rows = await db().select({ id: users.id, fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/* ------------------------------------------------------------------ form data & quote */

/** Everything the reception screen needs in one call. */
export async function formData(): Promise<OrderFormData> {
  const { labId, userId } = ctx();
  const lab = await getLab(labId);
  const tx = db();
  const testRows = await tx
    .select({ t: tests, c: containers, st: sampleTypes })
    .from(tests)
    .innerJoin(containers, eq(containers.id, tests.containerId))
    .innerJoin(sampleTypes, eq(sampleTypes.id, tests.sampleTypeId))
    .where(eq(tests.isActive, true))
    .orderBy(asc(tests.sortOrder), asc(tests.code));
  const analyteRows = await tx
    .select({ testId: testAnalytes.testId, code: analytes.code })
    .from(testAnalytes)
    .innerJoin(analytes, eq(analytes.id, testAnalytes.analyteId))
    .where(eq(analytes.isActive, true))
    .orderBy(asc(testAnalytes.sortOrder));
  const codesByTest = new Map<string, string[]>();
  for (const a of analyteRows) codesByTest.set(a.testId, [...(codesByTest.get(a.testId) ?? []), a.code]);
  const deptRows = await tx.select().from(departments).orderBy(asc(departments.sortOrder));
  const pkgRows = await tx.select().from(packages).where(eq(packages.isActive, true)).orderBy(asc(packages.code));
  const pkgTests = await tx.select().from(packageTests);
  const payerRows = await tx.select().from(payerGroups).where(eq(payerGroups.isActive, true)).orderBy(asc(payerGroups.createdAt), asc(payerGroups.code));
  const overrideRows = await tx.select({ payerGroupId: priceOverrides.payerGroupId, testId: priceOverrides.testId, price: priceOverrides.price }).from(priceOverrides);
  const doctorRows = await tx.select().from(doctors).where(eq(doctors.isActive, true)).orderBy(asc(doctors.nameAr));
  const methodRows = await tx.select().from(paymentMethods).where(eq(paymentMethods.isActive, true)).orderBy(asc(paymentMethods.sortOrder));
  const branchRows = await tx.select().from(branches).orderBy(desc(branches.isMain), asc(branches.code));
  const session = await currentCashSession(userId);
  const activeTestIds = new Set(testRows.map((r) => r.t.id));
  const publicPayer = payerRows.find((p) => p.kind === 'public' && p.code === 'PUBLIC') ?? payerRows.find((p) => p.kind === 'public') ?? payerRows[0];

  return {
    currency: lab.currency,
    tests: testRows.map(({ t, c, st }) => ({
      id: t.id,
      code: t.code,
      nameAr: t.nameAr,
      nameEn: t.nameEn,
      departmentId: t.departmentId,
      sampleTypeId: t.sampleTypeId,
      sampleTypeCode: st.code,
      sampleTypeNameAr: st.nameAr,
      sampleTypeNameEn: st.nameEn,
      containerId: c.id,
      containerCode: c.code,
      containerNameAr: c.nameAr,
      containerNameEn: c.nameEn,
      capColor: c.capColor,
      units: t.units,
      fixedPrice: t.fixedPrice,
      isFavorite: t.isFavorite,
      tatHours: t.tatHours,
      separateTube: t.separateTube,
      isExternal: t.isExternal,
      analyteCodes: codesByTest.get(t.id) ?? [],
    })),
    packages: pkgRows.map((p) => ({
      id: p.id,
      code: p.code,
      nameAr: p.nameAr,
      nameEn: p.nameEn,
      priceMode: p.priceMode,
      units: p.units,
      fixedPrice: p.fixedPrice,
      testIds: pkgTests.filter((pt) => pt.packageId === p.id && activeTestIds.has(pt.testId)).map((pt) => pt.testId),
    })),
    departments: deptRows.map((d) => ({ id: d.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn })),
    payerGroups: payerRows.map((p) => ({
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
    })),
    defaultPayerGroupId: publicPayer?.id ?? null,
    priceOverrides: overrideRows,
    doctors: doctorRows.map((d) => ({ id: d.id, nameAr: d.nameAr, nameEn: d.nameEn, specialtyAr: d.specialtyAr, specialtyEn: d.specialtyEn, clinic: d.clinic, phone: d.phone })),
    paymentMethods: methodRows.map((m) => ({ id: m.id, code: m.code, nameAr: m.nameAr, nameEn: m.nameEn, isCash: m.isCash })),
    branches: branchRows.map((b) => ({ id: b.id, code: b.code, nameAr: b.nameAr, nameEn: b.nameEn, isMain: b.isMain })),
    cashSession: session ? { id: session.id, openedAt: session.openedAt.toISOString() } : null,
  };
}

/** Price lines and totals without writing anything (live at reception, and for phone quotes). */
export async function quoteOrder(input: QuoteInput, opts: { canApproveDiscount: boolean }): Promise<OrderQuote> {
  const lab = await getLab(ctx().labId);
  const payer = await loadPayer(input.payerGroupId);
  const priced = await priceItems({
    payer,
    items: input.items,
    currency: lab.currency,
    manualDiscount: input.discount ?? null,
    applyManualDiscount: opts.canApproveDiscount,
  });
  return quoteResult({ payerGroupId: payer.id, currency: lab.currency, priced, canApproveDiscount: opts.canApproveDiscount });
}

/* ------------------------------------------------------------------ create */

async function createdSummary(orderId: string, extra: { warnings: QuoteWarning[]; approvalId: string | null; paymentId: string | null }): Promise<OrderCreated> {
  const tx = db();
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw notFound('order_not_found');
  const [inv] = await tx.select().from(invoices).where(eq(invoices.orderId, orderId));
  const [tubeCount] = await tx.select({ n: count() }).from(samples).where(eq(samples.orderId, orderId));
  const [pay] = extra.paymentId ? await tx.select({ id: payments.id, amount: payments.amount }).from(payments).where(eq(payments.id, extra.paymentId)) : [];
  return {
    id: order.id,
    accession: order.accession,
    dailyNo: order.dailyNo,
    portalCode: order.portalCode,
    status: order.status,
    tubes: tubeCount?.n ?? 0,
    invoice: inv
      ? { id: inv.id, number: inv.number, patientTotal: inv.patientTotal, insurerTotal: inv.insurerTotal, paidTotal: inv.paidTotal, balance: balanceOf(inv, inv.currency), status: inv.status }
      : { id: '', number: '', patientTotal: 0, insurerTotal: 0, paidTotal: 0, balance: 0, status: 'open' },
    approvalId: extra.approvalId,
    payment: pay ?? null,
    warnings: extra.warnings,
  };
}

/**
 * Register an order: price the lines (packages expanded), give it today's number, group the
 * lines into tubes, create pending results and the invoice, handle a requested discount
 * (applied for approvers, otherwise sent for approval) and an optional payment.
 */
export async function createOrder(input: CreateOrderInput, opts: { canApproveDiscount: boolean }): Promise<OrderCreated> {
  const { labId, userId } = ctx();
  const tx = db();
  const lab = await getLab(labId);

  // The same request sent twice (same payment key) returns the order the first one made.
  if (input.payment) {
    const [prior] = await tx
      .select({ orderId: invoices.orderId, paymentId: payments.id })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(eq(payments.idempotencyKey, input.payment.idempotencyKey));
    if (prior) return createdSummary(prior.orderId, { warnings: [], approvalId: null, paymentId: prior.paymentId });
  }

  const [patient] = await tx.select().from(patients).where(eq(patients.id, input.patientId));
  if (!patient || patient.deletedAt) throw notFound('patient_not_found');
  if (patient.mergedIntoId) throw conflict('patient_merged', 'This record was merged into another patient.');
  const payer = await loadPayer(input.payerGroupId);
  if (input.doctorId) {
    const [doctor] = await tx.select({ id: doctors.id, isActive: doctors.isActive }).from(doctors).where(eq(doctors.id, input.doctorId));
    if (!doctor || !doctor.isActive) throw badRequest('doctor_not_found', 'Unknown doctor.');
  }
  if (input.branchId) {
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
    if (!branch) throw badRequest('branch_not_found', 'Unknown branch.');
  }

  const priced = await priceItems({
    payer,
    items: input.items,
    currency: lab.currency,
    manualDiscount: input.discount ?? null,
    applyManualDiscount: opts.canApproveDiscount,
  });
  if (!priced.lines.length) throw badRequest('no_tests', 'Add at least one test.');
  const totals = totalsOf(priced.lines, lab.currency);

  // Check the payment before writing anything, so a closed cash box doesn't leave half an order.
  if (input.payment) {
    const amount = roundMoney(input.payment.amount, lab.currency);
    if (amount > totals.patientTotal) throw badRequest('amount_exceeds_balance', `The patient owes ${totals.patientTotal}.`);
    const [method] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, input.payment.methodId));
    if (!method || !method.isActive) throw badRequest('payment_method_invalid');
    if (method.isCash && !(await currentCashSession(userId))) throw conflict('no_cash_session', 'Open a cash session before taking cash.');
  }

  const now = new Date();
  const dailyNo = await nextCounter(`order:${dateKey(now, lab.timezone)}`);
  const accession = accessionFor(now, dailyNo, lab.timezone);
  const [order] = await tx
    .insert(orders)
    .values({
      labId,
      branchId: input.branchId ?? null,
      accession,
      dailyNo,
      patientId: patient.id,
      payerGroupId: payer.id,
      doctorId: input.doctorId ?? null,
      referralClinic: input.referralClinic ?? null,
      source: input.source,
      externalRef: input.externalRef ?? null,
      priority: input.priority,
      status: 'registered',
      clinicalInfo: input.clinicalInfo ?? null,
      notes: input.notes ?? null,
      fasting: input.fasting,
      pregnant: patient.sex === 'female' && input.pregnant,
      deliveryChannel: input.deliveryChannel,
      portalCode: newPortalCode(),
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const tubes = planTubes(priced.lines);
  const tubeByKey = await insertTubes(order!, tubes);
  await insertLines(order!.id, priced.lines, tubeByKey);
  const invoice = await recomputeInvoice(order!.id);

  let approvalId: string | null = null;
  if (input.discount && priced.requestedDiscount > 0) {
    if (opts.canApproveDiscount) {
      await audit({
        action: 'invoice.discount',
        entityType: 'invoice',
        entityId: invoice.id,
        summary: `${accession} · −${priced.requestedDiscount} ${lab.currency} · ${input.discount.reason}`,
        after: { discount: priced.requestedDiscount, reason: input.discount.reason },
      });
    } else {
      approvalId = await createDiscountApproval({
        orderId: order!.id,
        invoiceId: invoice.id,
        accession,
        amount: priced.requestedDiscount,
        percent: input.discount.percent ?? null,
        reason: input.discount.reason,
        currency: lab.currency,
      });
    }
  }

  await audit({
    action: 'order.create',
    entityType: 'order',
    entityId: order!.id,
    summary: `${accession} · ${patient.fullNameAr} · ${priced.lines.map((l) => l.code).join(', ')}`,
    after: {
      accession,
      patientId: patient.id,
      payer: payer.code,
      priority: input.priority,
      source: input.source,
      tests: priced.lines.map((l) => l.code),
      packages: priced.packages.map((p) => p.code),
      tubes: tubes.length,
      totals,
    },
  });
  publish({ type: 'orders.changed', data: { orderId: order!.id, status: 'registered' } });

  let paymentId: string | null = null;
  if (input.payment) {
    const paid = await takePayment({
      invoiceId: invoice.id,
      amount: input.payment.amount,
      methodId: input.payment.methodId,
      reference: input.payment.reference ?? null,
      idempotencyKey: input.payment.idempotencyKey,
    });
    paymentId = paid.payment.id;
  }

  const warnings = [...priced.warnings, ...analyteOverlaps(priced.lines.map((l) => l.test))];
  return createdSummary(order!.id, { warnings, approvalId, paymentId });
}

/* ------------------------------------------------------------------ list & detail */

export async function listOrders(query: OrderListQuery): Promise<{ items: OrderListItem[]; total: number }> {
  const tx = db();
  const conds: SQL[] = [];
  const q = query.q?.trim() ?? '';
  // Searching or looking at one patient spans all dates unless a range is given.
  if (query.from || query.to || (!q && !query.patientId)) {
    const { start, end } = await dayRange(query.from, query.to);
    conds.push(gte(orders.createdAt, start), lt(orders.createdAt, end));
  }
  if (query.status) conds.push(eq(orders.status, query.status));
  if (query.priority) conds.push(eq(orders.priority, query.priority));
  if (query.source) conds.push(eq(orders.source, query.source));
  if (query.payerGroupId) conds.push(eq(orders.payerGroupId, query.payerGroupId));
  if (query.doctorId) conds.push(eq(orders.doctorId, query.doctorId));
  if (query.patientId) conds.push(eq(orders.patientId, query.patientId));
  if (q) {
    const byPatient = patientSearchCondition(q);
    const options = [ilike(orders.accession, `${escapeLike(q)}%`), ilike(orders.externalRef, `${escapeLike(q)}%`)];
    if (byPatient) options.push(byPatient);
    conds.push(or(...options)!);
  }
  if (query.unpaid) conds.push(sql`${invoices.status} <> 'void' and ${invoices.patientTotal} > ${invoices.paidTotal}`);
  const where = conds.length ? and(...conds) : undefined;

  const rows = await tx
    .select({ o: orders, p: patients, pg: payerGroups, d: doctors, inv: invoices })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(payerGroups, eq(payerGroups.id, orders.payerGroupId))
    .leftJoin(doctors, eq(doctors.id, orders.doctorId))
    .leftJoin(invoices, eq(invoices.orderId, orders.id))
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [totalRow] = await tx
    .select({ n: count() })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .leftJoin(invoices, eq(invoices.orderId, orders.id))
    .where(where);
  return { items: await decorateOrders(rows), total: totalRow?.n ?? 0 };
}

type OrderRow = {
  o: Order;
  p: typeof patients.$inferSelect;
  pg: typeof payerGroups.$inferSelect;
  d: typeof doctors.$inferSelect | null;
  inv: typeof invoices.$inferSelect | null;
};

async function decorateOrders(rows: OrderRow[]): Promise<OrderListItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.o.id);
  const itemRows = await db()
    .select({ orderId: orderItems.orderId, code: tests.code, status: orderItems.status })
    .from(orderItems)
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .where(and(inArray(orderItems.orderId, ids), ne(orderItems.status, 'cancelled')))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const criticalRows = await db()
    .selectDistinct({ orderId: results.orderId })
    .from(results)
    .where(and(inArray(results.orderId, ids), eq(results.isCritical, true)));
  const critical = new Set(criticalRows.map((r) => r.orderId));
  const byOrder = new Map<string, { codes: string[]; released: number }>();
  for (const it of itemRows) {
    const entry = byOrder.get(it.orderId) ?? { codes: [], released: 0 };
    entry.codes.push(it.code);
    if (it.status === 'released') entry.released += 1;
    byOrder.set(it.orderId, entry);
  }
  return rows.map(({ o, p, pg, d, inv }) => {
    const entry = byOrder.get(o.id) ?? { codes: [], released: 0 };
    return {
      id: o.id,
      accession: o.accession,
      dailyNo: o.dailyNo,
      createdAt: o.createdAt.toISOString(),
      status: o.status,
      priority: o.priority,
      source: o.source,
      patient: toSummary(p),
      payer: { id: pg.id, code: pg.code, nameAr: pg.nameAr, nameEn: pg.nameEn, kind: pg.kind },
      doctor: d ? { id: d.id, nameAr: d.nameAr, nameEn: d.nameEn } : null,
      testCodes: entry.codes,
      testCount: entry.codes.length,
      releasedCount: entry.released,
      patientTotal: inv?.patientTotal ?? 0,
      paidTotal: inv?.paidTotal ?? 0,
      balance: inv ? balanceOf(inv, inv.currency) : 0,
      invoiceStatus: inv?.status ?? null,
      hasCritical: critical.has(o.id),
    };
  });
}

export async function getOrder(id: string): Promise<OrderDetail> {
  const tx = db();
  const [row] = await tx
    .select({ o: orders, p: patients, pg: payerGroups, d: doctors, b: branches })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(payerGroups, eq(payerGroups.id, orders.payerGroupId))
    .leftJoin(doctors, eq(doctors.id, orders.doctorId))
    .leftJoin(branches, eq(branches.id, orders.branchId))
    .where(eq(orders.id, id));
  if (!row) throw notFound('order_not_found');
  const { o, p, pg, d, b } = row;

  const itemRows = await tx
    .select({
      i: orderItems,
      code: tests.code,
      nameAr: tests.nameAr,
      nameEn: tests.nameEn,
      departmentId: tests.departmentId,
      tatHours: tests.tatHours,
      deptAr: departments.nameAr,
      deptEn: departments.nameEn,
      pkgCode: packages.code,
      pkgAr: packages.nameAr,
      pkgEn: packages.nameEn,
      barcode: samples.barcode,
      capColor: containers.capColor,
    })
    .from(orderItems)
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .leftJoin(departments, eq(departments.id, tests.departmentId))
    .leftJoin(packages, eq(packages.id, orderItems.packageId))
    .leftJoin(samples, eq(samples.id, orderItems.sampleId))
    .leftJoin(containers, eq(containers.id, samples.containerId))
    .where(eq(orderItems.orderId, id))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));

  const countRows = await tx
    .select({ itemId: results.orderItemId, status: results.status, critical: results.isCritical, n: count() })
    .from(results)
    .where(eq(results.orderId, id))
    .groupBy(results.orderItemId, results.status, results.isCritical);
  const perItem = new Map<string, ResultCounts>();
  const overall = emptyCounts();
  for (const c of countRows) {
    const entry = perItem.get(c.itemId) ?? emptyCounts();
    for (const target of [entry, overall]) {
      target.total += c.n;
      target[c.status] += c.n;
      if (c.critical) target.critical += c.n;
    }
    perItem.set(c.itemId, entry);
  }

  const items: OrderItemRow[] = itemRows.map((r) => ({
    id: r.i.id,
    testId: r.i.testId,
    code: r.code,
    nameAr: r.nameAr,
    nameEn: r.nameEn,
    departmentId: r.departmentId,
    departmentNameAr: r.deptAr ?? '',
    departmentNameEn: r.deptEn ?? '',
    packageId: r.i.packageId,
    packageCode: r.pkgCode ?? null,
    packageNameAr: r.pkgAr ?? null,
    packageNameEn: r.pkgEn ?? null,
    sampleId: r.i.sampleId,
    barcode: r.barcode ?? null,
    capColor: r.capColor ?? null,
    status: r.i.status,
    units: r.i.units,
    unitPrice: r.i.unitPrice,
    price: r.i.price,
    discount: r.i.discount,
    isExternal: r.i.isExternal,
    tatHours: r.tatHours,
    dueAt: new Date(o.createdAt.getTime() + r.tatHours * 3_600_000).toISOString(),
    cancelledAt: r.i.cancelledAt ? r.i.cancelledAt.toISOString() : null,
    resultCounts: perItem.get(r.i.id) ?? emptyCounts(),
  }));

  const tubeRows = await tx
    .select({ s: samples, c: containers, st: sampleTypes })
    .from(samples)
    .innerJoin(containers, eq(containers.id, samples.containerId))
    .innerJoin(sampleTypes, eq(sampleTypes.id, samples.sampleTypeId))
    .where(eq(samples.orderId, id))
    .orderBy(asc(samples.seq));
  const tubes: OrderTube[] = tubeRows.map(({ s, c, st }) => ({
    id: s.id,
    barcode: s.barcode,
    seq: s.seq,
    status: s.status,
    containerId: c.id,
    containerCode: c.code,
    containerNameAr: c.nameAr,
    containerNameEn: c.nameEn,
    capColor: c.capColor,
    sampleTypeCode: st.code,
    sampleTypeNameAr: st.nameAr,
    sampleTypeNameEn: st.nameEn,
    testCodes: items.filter((i) => i.sampleId === s.id && i.status !== 'cancelled').map((i) => i.code),
    collectedAt: s.collectedAt ? s.collectedAt.toISOString() : null,
    receivedAt: s.receivedAt ? s.receivedAt.toISOString() : null,
    labelPrintedAt: s.labelPrintedAt ? s.labelPrintedAt.toISOString() : null,
  }));

  const [inv] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.orderId, id));
  const [report] = await tx
    .select({ id: reports.id, version: reports.version, status: reports.status, releasedAt: reports.releasedAt, verifyCode: reports.verifyCode })
    .from(reports)
    .where(eq(reports.orderId, id))
    .orderBy(desc(reports.version))
    .limit(1);
  const names = await userNames([o.createdBy, o.cancelledBy]);

  return {
    id: o.id,
    accession: o.accession,
    dailyNo: o.dailyNo,
    status: o.status,
    priority: o.priority,
    source: o.source,
    externalRef: o.externalRef,
    referralClinic: o.referralClinic,
    clinicalInfo: o.clinicalInfo,
    notes: o.notes,
    fasting: o.fasting,
    pregnant: o.pregnant,
    deliveryChannel: o.deliveryChannel,
    portalCode: o.portalCode,
    version: o.version,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    completedAt: o.completedAt ? o.completedAt.toISOString() : null,
    deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
    cancelledAt: o.cancelledAt ? o.cancelledAt.toISOString() : null,
    cancelReason: o.cancelReason,
    patient: { ...toSummary(p), contactPref: p.contactPref, notes: p.notes },
    payer: { id: pg.id, code: pg.code, nameAr: pg.nameAr, nameEn: pg.nameEn, kind: pg.kind, patientSharePct: pg.patientSharePct, onAccount: pg.onAccount },
    doctor: d ? { id: d.id, nameAr: d.nameAr, nameEn: d.nameEn, clinic: d.clinic, phone: d.phone } : null,
    branch: b ? { id: b.id, nameAr: b.nameAr, nameEn: b.nameEn } : null,
    createdBy: o.createdBy ? names.get(o.createdBy) ?? null : null,
    cancelledBy: o.cancelledBy ? names.get(o.cancelledBy) ?? null : null,
    items,
    tubes,
    resultCounts: overall,
    invoice: inv ? await getInvoiceDetail(inv.id) : null,
    latestReport: report ? { ...report, releasedAt: report.releasedAt.toISOString() } : null,
    cancellable: o.status !== 'cancelled' && overall.validated + overall.released === 0,
  };
}

/* ------------------------------------------------------------------ edit */

const EDITABLE = ['doctorId', 'referralClinic', 'priority', 'clinicalInfo', 'notes', 'deliveryChannel', 'fasting', 'pregnant', 'externalRef'] as const;

/** Change the order header (doctor, priority, notes…). `version` guards against lost updates. */
export async function updateOrder(id: string, input: UpdateOrderInput): Promise<OrderDetail> {
  const tx = db();
  const order = await lockOrder(id);
  assertActive(order);
  if (order.version !== input.version) throw conflict('version_conflict', 'Someone else changed this order. Reload it and try again.');
  if (input.doctorId) {
    const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.id, input.doctorId));
    if (!doctor) throw badRequest('doctor_not_found', 'Unknown doctor.');
  }
  if (input.pregnant) {
    const [p] = await tx.select({ sex: patients.sex }).from(patients).where(eq(patients.id, order.patientId));
    if (p?.sex !== 'female') throw badRequest('pregnant_male', 'Only for female patients.');
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const patch: Partial<Record<(typeof EDITABLE)[number], unknown>> = {};
  for (const key of EDITABLE) {
    const value = input[key];
    if (value === undefined) continue;
    if ((order[key] ?? null) === (value ?? null)) continue;
    patch[key] = value ?? null;
    before[key] = order[key];
    after[key] = value ?? null;
  }
  if (!Object.keys(patch).length) return getOrder(id);
  const updated = await tx
    .update(orders)
    .set({ ...(patch as Partial<Order>), updatedAt: new Date(), version: sql`${orders.version} + 1` })
    .where(and(eq(orders.id, id), eq(orders.version, input.version)))
    .returning({ id: orders.id });
  if (!updated.length) throw conflict('version_conflict', 'Someone else changed this order. Reload it and try again.');
  await audit({ action: 'order.update', entityType: 'order', entityId: id, summary: `${order.accession} · ${Object.keys(patch).join(', ')}`, before, after });
  publish({ type: 'orders.changed', data: { orderId: id } });
  return getOrder(id);
}

/** Add tests to an order: same-specimen tubes are reused while usable, new tubes otherwise. */
export async function addItems(id: string, input: AddItemsInput): Promise<ItemsChanged> {
  const tx = db();
  const lab = await getLab(ctx().labId);
  const order = await lockOrder(id);
  assertActive(order);
  const [payer] = await tx.select().from(payerGroups).where(eq(payerGroups.id, order.payerGroupId));
  const current = await tx
    .select({ testId: orderItems.testId, sampleId: orderItems.sampleId, separateTube: tests.separateTube })
    .from(orderItems)
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .where(and(eq(orderItems.orderId, id), ne(orderItems.status, 'cancelled')));
  const priced = await priceItems({ payer: payer!, items: input.items, currency: lab.currency, existingTestIds: current.map((c) => c.testId) });
  if (!priced.lines.length) throw badRequest('no_new_tests', 'These tests are already in the order.');

  const tubes = await tx.select().from(samples).where(eq(samples.orderId, id)).orderBy(asc(samples.seq));
  const ownTube = new Set(current.filter((c) => c.separateTube && c.sampleId).map((c) => c.sampleId!));
  const tubeByKey = new Map<string, string>();
  const needTube: PricedLine[] = [];
  for (const line of priced.lines) {
    const tube = line.test.separateTube
      ? undefined
      : tubes.find(
          (t) => t.containerId === line.containerId && t.sampleTypeId === line.sampleTypeId && !ownTube.has(t.id) && !(DEAD_TUBE as readonly string[]).includes(t.status),
        );
    if (!tube) {
      needTube.push(line);
      continue;
    }
    tubeByKey.set(line.key, tube.id);
    if (tube.departmentId && tube.departmentId !== line.departmentId) {
      await tx.update(samples).set({ departmentId: null }).where(eq(samples.id, tube.id));
      tube.departmentId = null;
    }
  }
  const nextSeq = tubes.reduce((m, t) => Math.max(m, t.seq), 0) + 1;
  const plans = planTubes(needTube, nextSeq);
  for (const [k, v] of await insertTubes(order, plans)) tubeByKey.set(k, v);
  await insertLines(id, priced.lines, tubeByKey);
  const invoice = await recomputeInvoice(id);
  await refreshOrderStatus(id);
  await bumpVersion(id);

  const allTests = await loadTests([...current.map((c) => c.testId), ...priced.lines.map((l) => l.testId)]);
  const warnings = [...priced.warnings, ...analyteOverlaps([...allTests.values()])];
  await audit({
    action: 'order.add_items',
    entityType: 'order',
    entityId: id,
    summary: `${order.accession} + ${priced.lines.map((l) => l.code).join(', ')}`,
    after: { tests: priced.lines.map((l) => l.code), newTubes: plans.length, patientTotal: invoice.patientTotal },
  });
  publish({ type: 'orders.changed', data: { orderId: id } });
  return { orderId: id, added: priced.lines.length, newTubes: plans.length, warnings, invoice: invoiceSummary(invoice) };
}

function invoiceSummary(t: InvoiceTotals): ItemsChanged['invoice'] {
  return { patientTotal: t.patientTotal, paidTotal: t.paidTotal, balance: t.balance, status: t.status };
}

/** Remove a test that has no result yet. Its empty results go; a tube left with nothing is retired. */
export async function removeItem(orderId: string, itemId: string, reason: string): Promise<ItemsChanged> {
  const tx = db();
  const order = await lockOrder(orderId);
  assertActive(order);
  const [item] = await tx
    .select({ i: orderItems, code: tests.code })
    .from(orderItems)
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)));
  if (!item) throw notFound('item_not_found');
  if (item.i.status === 'cancelled') throw conflict('item_cancelled', 'This test was already removed.');
  const [withValue] = await tx
    .select({ n: count() })
    .from(results)
    .where(and(eq(results.orderItemId, itemId), or(ne(results.status, 'pending'), sql`${results.valueNum} is not null`, sql`coalesce(${results.valueText}, '') <> ''`)));
  if ((withValue?.n ?? 0) > 0) throw conflict('item_has_results', 'Results were already entered for this test.');
  const [active] = await tx
    .select({ n: count() })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), ne(orderItems.status, 'cancelled')));
  if ((active?.n ?? 0) <= 1) throw conflict('last_item', 'This is the only test; cancel the order instead.');

  await tx.update(orderItems).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(orderItems.id, itemId));
  await tx.delete(results).where(eq(results.orderItemId, itemId));
  if (item.i.sampleId) {
    const [others] = await tx
      .select({ n: count() })
      .from(orderItems)
      .where(and(eq(orderItems.sampleId, item.i.sampleId), ne(orderItems.status, 'cancelled')));
    if ((others?.n ?? 0) === 0) await retireTube(item.i.sampleId, `No tests left (${item.code} removed): ${reason}`, { deletePending: true });
  }
  const invoice = await recomputeInvoice(orderId);
  await refreshOrderStatus(orderId);
  await bumpVersion(orderId);
  await audit({
    action: 'order.remove_item',
    entityType: 'order',
    entityId: orderId,
    summary: `${order.accession} − ${item.code} · ${reason}`,
    before: { test: item.code, price: item.i.price, discount: item.i.discount },
    after: { reason, patientTotal: invoice.patientTotal },
  });
  publish({ type: 'orders.changed', data: { orderId } });
  return { orderId, added: 0, newTubes: 0, warnings: [], invoice: invoiceSummary(invoice) };
}

/**
 * Cancel an order while nothing in it is validated: lines are cancelled, tubes retired,
 * empty results removed, an unpaid invoice voided (a paid one is left showing the refund due).
 */
export async function cancelOrder(id: string, reason: string): Promise<CancelResult> {
  const tx = db();
  const { userId } = ctx();
  const order = await lockOrder(id);
  assertActive(order);
  const [locked] = await tx
    .select({ n: count() })
    .from(results)
    .where(and(eq(results.orderId, id), inArray(results.status, ['validated', 'released'])));
  if ((locked?.n ?? 0) > 0) throw conflict('order_has_validated_results', 'Results in this order are already validated.');

  const now = new Date();
  await tx
    .update(orderItems)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(eq(orderItems.orderId, id), ne(orderItems.status, 'cancelled')));
  await tx
    .delete(results)
    .where(and(eq(results.orderId, id), eq(results.status, 'pending'), sql`${results.valueNum} is null`, sql`coalesce(${results.valueText}, '') = ''`));
  const tubes = await tx.select({ id: samples.id }).from(samples).where(and(eq(samples.orderId, id), notInArray(samples.status, [...DEAD_TUBE])));
  for (const t of tubes) await retireTube(t.id, `Order cancelled: ${reason}`, { deletePending: false });
  await tx
    .update(orders)
    .set({ status: 'cancelled', cancelledAt: now, cancelledBy: userId, cancelReason: reason, updatedAt: now, version: sql`${orders.version} + 1` })
    .where(eq(orders.id, id));
  await tx
    .update(approvals)
    .set({ status: 'rejected', decidedBy: userId, decidedAt: now, decisionNote: 'Order cancelled' })
    .where(and(eq(approvals.orderId, id), eq(approvals.status, 'pending')));

  let invoiceVoided = false;
  let refundDue = 0;
  const [inv] = await tx.select().from(invoices).where(eq(invoices.orderId, id)).for('update');
  if (inv && inv.status !== 'void') {
    const totals = await refreshInvoiceTotals(inv.id);
    if (totals.paidTotal <= 0) {
      await tx
        .update(invoices)
        .set({ status: 'void', voidedAt: now, voidReason: reason, updatedAt: now, version: sql`${invoices.version} + 1` })
        .where(eq(invoices.id, inv.id));
      invoiceVoided = true;
    } else {
      const after = await recomputeInvoice(id);
      refundDue = roundMoney(Math.max(0, after.paidTotal - after.patientTotal), inv.currency);
    }
  }

  await audit({
    action: 'order.cancel',
    entityType: 'order',
    entityId: id,
    summary: `${order.accession} · ${reason}`,
    before: { status: order.status },
    after: { status: 'cancelled', reason, invoiceVoided, refundDue },
  });
  if (refundDue > 0 && inv) {
    await notifyPermission('finance.refund', {
      kind: 'approval',
      severity: 'warning',
      titleAr: 'طلب ملغى يحتاج إلى استرداد',
      titleEn: 'Cancelled order needs a refund',
      bodyAr: `الطلب ${order.accession} · ${refundDue} ${inv.currency}`,
      bodyEn: `Order ${order.accession} · ${refundDue} ${inv.currency}`,
      link: `/orders/${id}`,
      entityType: 'order',
      entityId: id,
    });
  }
  publish({ type: 'orders.changed', data: { orderId: id, status: 'cancelled' } });
  publish({ type: 'finance.changed', data: { orderId: id } });
  return { orderId: id, status: 'cancelled', invoiceVoided, refundDue };
}

/* ------------------------------------------------------------------ labels, receipt, activity */

function shortName(first: string | null | undefined, last: string | null | undefined): string | null {
  const s = [first, last].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  return s || null;
}

export async function orderLabels(id: string): Promise<OrderLabels> {
  const tx = db();
  const [row] = await tx.select({ o: orders, p: patients }).from(orders).innerJoin(patients, eq(patients.id, orders.patientId)).where(eq(orders.id, id));
  if (!row) throw notFound('order_not_found');
  const tubeRows = await tx
    .select({ s: samples, c: containers, st: sampleTypes })
    .from(samples)
    .innerJoin(containers, eq(containers.id, samples.containerId))
    .innerJoin(sampleTypes, eq(sampleTypes.id, samples.sampleTypeId))
    .where(and(eq(samples.orderId, id), notInArray(samples.status, [...DEAD_TUBE])))
    .orderBy(asc(samples.seq));
  const codes = await tx
    .select({ sampleId: orderItems.sampleId, code: tests.code })
    .from(orderItems)
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .where(and(eq(orderItems.orderId, id), ne(orderItems.status, 'cancelled')))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const { o, p } = row;
  return {
    order: { id: o.id, accession: o.accession, dailyNo: o.dailyNo, createdAt: o.createdAt.toISOString(), priority: o.priority, status: o.status },
    patient: {
      fullNameAr: p.fullNameAr,
      fullNameEn: p.fullNameEn,
      shortNameAr: shortName(p.firstNameAr, p.lastNameAr) ?? p.fullNameAr,
      shortNameEn: shortName(p.firstNameEn, p.lastNameEn),
      sex: p.sex,
      birthDate: p.birthDate,
    },
    labels: tubeRows.map(({ s, c, st }) => ({
      sampleId: s.id,
      barcode: s.barcode,
      seq: s.seq,
      status: s.status,
      containerCode: c.code,
      containerNameAr: c.nameAr,
      containerNameEn: c.nameEn,
      capColor: c.capColor,
      sampleTypeCode: st.code,
      testCodes: codes.filter((x) => x.sampleId === s.id).map((x) => x.code),
      labelPrintedAt: s.labelPrintedAt ? s.labelPrintedAt.toISOString() : null,
    })),
  };
}

export async function markLabelsPrinted(id: string, sampleIds?: string[]): Promise<{ printed: number }> {
  const tx = db();
  const { labId, userId } = ctx();
  const [order] = await tx.select({ id: orders.id, accession: orders.accession }).from(orders).where(eq(orders.id, id));
  if (!order) throw notFound('order_not_found');
  const conds = [eq(samples.orderId, id), notInArray(samples.status, [...DEAD_TUBE])];
  if (sampleIds?.length) conds.push(inArray(samples.id, sampleIds));
  const rows = await tx.update(samples).set({ labelPrintedAt: new Date() }).where(and(...conds)).returning({ id: samples.id, barcode: samples.barcode });
  if (rows.length) {
    await tx.insert(sampleEvents).values(rows.map((r) => ({ labId, sampleId: r.id, type: 'label_printed' as const, userId })));
    await audit({ action: 'order.labels_printed', entityType: 'order', entityId: id, summary: `${order.accession} · ${rows.map((r) => r.barcode).join(', ')}` });
    publish({ type: 'samples.changed', data: { orderId: id } });
  }
  return { printed: rows.length };
}

export async function orderReceipt(id: string): Promise<OrderReceipt> {
  const tx = db();
  const lab = await getLab(ctx().labId);
  const [row] = await tx
    .select({ o: orders, p: patients, d: doctors })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .leftJoin(doctors, eq(doctors.id, orders.doctorId))
    .where(eq(orders.id, id));
  if (!row) throw notFound('order_not_found');
  const [inv] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.orderId, id));
  const { o, p, d } = row;
  return {
    lab: { code: lab.code, nameAr: lab.nameAr, nameEn: lab.nameEn, phone: lab.phone, addressAr: lab.addressAr, addressEn: lab.addressEn, logoSvg: lab.logoSvg, currency: lab.currency },
    order: { id: o.id, accession: o.accession, dailyNo: o.dailyNo, createdAt: o.createdAt.toISOString(), portalCode: o.portalCode, status: o.status },
    patient: toSummary(p),
    doctor: d ? { nameAr: d.nameAr, nameEn: d.nameEn } : null,
    invoice: inv ? await getInvoiceDetail(inv.id) : null,
  };
}

/** Audit trail of the order and everything hanging off it (tubes, results, invoice, payments…). */
export async function orderActivity(id: string): Promise<ActivityEntry[]> {
  const tx = db();
  const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, id));
  if (!order) throw notFound('order_not_found');
  const [tubeIds, resultIds, itemIds, invoiceRows, approvalIds, reportIds, deliveryIds] = await Promise.all([
    tx.select({ id: samples.id }).from(samples).where(eq(samples.orderId, id)),
    tx.select({ id: results.id }).from(results).where(eq(results.orderId, id)),
    tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, id)),
    tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.orderId, id)),
    tx.select({ id: approvals.id }).from(approvals).where(eq(approvals.orderId, id)),
    tx.select({ id: reports.id }).from(reports).where(eq(reports.orderId, id)),
    tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.orderId, id)),
  ]);
  const paymentIds = invoiceRows.length
    ? await tx.select({ id: payments.id }).from(payments).where(inArray(payments.invoiceId, invoiceRows.map((r) => r.id)))
    : [];
  const groups: Array<[string[], string[]]> = [
    [['order'], [id]],
    [['sample'], tubeIds.map((r) => r.id)],
    [['result'], resultIds.map((r) => r.id)],
    [['order_item'], itemIds.map((r) => r.id)],
    [['invoice'], invoiceRows.map((r) => r.id)],
    [['payment'], paymentIds.map((r) => r.id)],
    [['approval'], approvalIds.map((r) => r.id)],
    [['report'], reportIds.map((r) => r.id)],
    [['delivery'], deliveryIds.map((r) => r.id)],
  ];
  const conds = groups.filter(([, ids]) => ids.length).map(([types, ids]) => and(inArray(auditLog.entityType, types), inArray(auditLog.entityId, ids))!);
  const rows = await tx
    .select()
    .from(auditLog)
    .where(or(...conds))
    .orderBy(desc(auditLog.seq))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    summary: r.summary,
    actorName: r.actorName,
    before: r.before ?? null,
    after: r.after ?? null,
  }));
}

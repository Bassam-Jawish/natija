/**
 * Desk money: invoices, payments and discounts. Every function runs inside the current lab
 * context (withLab), so row-level security keeps it to the caller's lab. Other modules import
 * takePayment, refreshInvoiceTotals, applyDiscount and recomputeInvoice from here.
 */
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  approvals,
  cashSessions,
  invoiceLines,
  invoices,
  orderItems,
  orders,
  packages,
  patients,
  payerGroups,
  paymentMethods,
  payments,
  tests,
  users,
} from '@natija/db';
import { dateKey, invoiceNumber, invoiceStatus, roundMoney } from '@natija/domain';
import type { ApprovalRow, DiscountResult, InvoiceDetail, InvoiceLineRow, InvoiceStatusValue, PaymentResult, PaymentRow } from '@natija/contracts';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { nextCounter } from '../../lib/counters';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { getLab } from '../../lib/lab';
import { notifyPermission } from '../../lib/notify';

export type InvoiceTotals = { id: string; patientTotal: number; paidTotal: number; balance: number; status: InvoiceStatusValue };

/* ------------------------------------------------------------------ helpers */

/** What the patient still owes (negative when they paid more than they owe: refund due). */
export function balanceOf(inv: { patientTotal: number; paidTotal: number; status: string }, currency = 'SYP'): number {
  if (inv.status === 'void') return roundMoney(-inv.paidTotal, currency);
  return roundMoney(inv.patientTotal - inv.paidTotal, currency);
}

/**
 * Split `total` over lines in proportion to `weights`, never giving a line more than its cap,
 * in whole currency units (SYP) or cents. The parts add up to exactly min(total, Σcaps).
 */
export function allocate(total: number, weights: number[], caps: number[], currency = 'SYP'): number[] {
  const scale = currency === 'SYP' ? 1 : 100;
  const capUnits = caps.map((c) => Math.max(0, Math.round(c * scale)));
  const capSum = capUnits.reduce((a, b) => a + b, 0);
  const want = Math.min(Math.max(0, Math.round(total * scale)), capSum);
  if (!weights.length || want === 0) return weights.map(() => 0);
  const wSum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  const exact = weights.map((w) => (wSum > 0 ? (Math.max(0, w) / wSum) * want : want / weights.length));
  const parts = exact.map((x, i) => Math.min(capUnits[i]!, Math.floor(x)));
  let left = want - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  while (left > 0) {
    let moved = false;
    for (const { i } of order) {
      if (left === 0) break;
      if (parts[i]! < capUnits[i]!) {
        parts[i]! += 1;
        left -= 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return parts.map((p) => p / scale);
}

/**
 * Patient and insurer shares of each line. The patient's total is exactly the payer's share of
 * the invoice net (20 % of 9 000 is 1 800, not the sum of ten rounded line shares); it is then
 * spread over the lines in proportion to their net.
 */
export function splitShares(lines: Array<{ price: number; discount: number }>, patientSharePct: number, currency = 'SYP') {
  const nets = lines.map((l) => Math.max(0, roundMoney(l.price - l.discount, currency)));
  const totalNet = roundMoney(nets.reduce((a, b) => a + b, 0), currency);
  const patientTotal = roundMoney((totalNet * patientSharePct) / 100, currency);
  const patient = allocate(patientTotal, nets, nets, currency);
  return nets.map((net, i) => ({ net, patientShare: patient[i]!, insurerShare: roundMoney(net - patient[i]!, currency) }));
}

/** The signed-in user's open cash session, if any (cash payments need one). */
export async function currentCashSession(userId: string | null = ctx().userId): Promise<{ id: string; openedAt: Date } | null> {
  if (!userId) return null;
  const [row] = await db()
    .select({ id: cashSessions.id, openedAt: cashSessions.openedAt })
    .from(cashSessions)
    .where(and(eq(cashSessions.openedBy, userId), eq(cashSessions.status, 'open')))
    .orderBy(desc(cashSessions.openedAt))
    .limit(1);
  return row ?? null;
}

async function paidSum(invoiceId: string): Promise<number> {
  const [row] = await db()
    .select({ paid: sql<string>`coalesce(sum(case when ${payments.kind} = 'refund' then -${payments.amount} else ${payments.amount} end), 0)` })
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId));
  return Number(row?.paid ?? 0);
}

/* ------------------------------------------------------------------ totals */

/** Recompute the paid total from payments (refunds subtract) and the invoice status. */
export async function refreshInvoiceTotals(invoiceId: string): Promise<InvoiceTotals> {
  const tx = db();
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw notFound('invoice_not_found');
  const paidTotal = roundMoney(await paidSum(invoiceId), inv.currency);
  const status = invoiceStatus(inv.patientTotal, paidTotal, inv.status === 'void');
  if (paidTotal !== inv.paidTotal || status !== inv.status) {
    await tx
      .update(invoices)
      .set({ paidTotal, status, updatedAt: new Date(), version: sql`${invoices.version} + 1` })
      .where(eq(invoices.id, invoiceId));
  }
  return { id: inv.id, patientTotal: inv.patientTotal, paidTotal, balance: balanceOf({ ...inv, paidTotal, status }, inv.currency), status };
}

/** Create the invoice of an order that has none yet (normally created with the order). */
async function createInvoiceRow(order: { id: string; payerGroupId: string; createdAt: Date }): Promise<typeof invoices.$inferSelect> {
  const { labId, userId } = ctx();
  const lab = await getLab(labId);
  const year = dateKey(order.createdAt, lab.timezone).slice(0, 4);
  const n = await nextCounter(`invoice:${year}`);
  const [row] = await db()
    .insert(invoices)
    .values({
      labId,
      orderId: order.id,
      number: invoiceNumber(Number(year), n),
      payerGroupId: order.payerGroupId,
      currency: lab.currency,
      createdBy: userId,
    })
    .returning();
  return row!;
}

/**
 * Bring an order's invoice in line with its active lines: add lines for new tests, drop lines of
 * cancelled tests, refresh prices, discounts and shares (with the payer's current patient share),
 * then the totals and status. A void invoice is left alone.
 */
export async function recomputeInvoice(orderId: string): Promise<InvoiceTotals> {
  const tx = db();
  const { labId } = ctx();
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw notFound('order_not_found');
  let [inv] = await tx.select().from(invoices).where(eq(invoices.orderId, orderId)).for('update');
  if (!inv) inv = await createInvoiceRow(order);
  if (inv.status === 'void') return refreshInvoiceTotals(inv.id);
  const [payer] = await tx.select().from(payerGroups).where(eq(payerGroups.id, inv.payerGroupId));
  const pct = payer?.patientSharePct ?? 100;

  const items = await tx
    .select({ item: orderItems, code: tests.code, nameEn: tests.nameEn })
    .from(orderItems)
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .where(and(eq(orderItems.orderId, orderId), ne(orderItems.status, 'cancelled')))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const active = new Map(items.map((r) => [r.item.id, r]));
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
  const byItem = new Map(lines.filter((l) => l.orderItemId).map((l) => [l.orderItemId!, l]));

  const stale = lines.filter((l) => l.orderItemId && !active.has(l.orderItemId)).map((l) => l.id);
  if (stale.length) await tx.delete(invoiceLines).where(inArray(invoiceLines.id, stale));

  const shares = splitShares(
    items.map((r) => r.item),
    pct,
    inv.currency,
  );
  for (const [idx, { item, code, nameEn }] of items.entries()) {
    const existing = byItem.get(item.id);
    const values = {
      units: item.units,
      unitPrice: item.unitPrice,
      price: item.price,
      discount: item.discount,
      patientShare: shares[idx]!.patientShare,
      insurerShare: shares[idx]!.insurerShare,
    };
    if (!existing) {
      await tx.insert(invoiceLines).values({ labId, invoiceId: inv.id, orderItemId: item.id, description: `${code} · ${nameEn}`, ...values });
    } else if ((Object.keys(values) as Array<keyof typeof values>).some((k) => existing[k] !== values[k])) {
      await tx.update(invoiceLines).set(values).where(eq(invoiceLines.id, existing.id));
    }
  }

  const [sum] = await tx
    .select({
      subtotal: sql<string>`coalesce(sum(${invoiceLines.price}), 0)`,
      discount: sql<string>`coalesce(sum(${invoiceLines.discount}), 0)`,
      patient: sql<string>`coalesce(sum(${invoiceLines.patientShare}), 0)`,
      insurer: sql<string>`coalesce(sum(${invoiceLines.insurerShare}), 0)`,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, inv.id));
  await tx
    .update(invoices)
    .set({
      subtotal: roundMoney(Number(sum?.subtotal ?? 0), inv.currency),
      discountTotal: roundMoney(Number(sum?.discount ?? 0), inv.currency),
      patientTotal: roundMoney(Number(sum?.patient ?? 0), inv.currency),
      insurerTotal: roundMoney(Number(sum?.insurer ?? 0), inv.currency),
      updatedAt: new Date(),
      version: sql`${invoices.version} + 1`,
    })
    .where(eq(invoices.id, inv.id));
  return refreshInvoiceTotals(inv.id);
}

/* ------------------------------------------------------------------ payments */

export type TakePaymentInput = {
  invoiceId: string;
  amount: number;
  methodId: string;
  reference?: string | null;
  idempotencyKey: string;
  note?: string | null;
};

/**
 * Take a payment against an invoice. The same idempotency key returns the original payment
 * without charging again. Cash needs the user's open cash session (409 no_cash_session).
 */
export async function takePayment(input: TakePaymentInput): Promise<PaymentResult> {
  const { labId, userId, tx } = ctx();
  // Two attempts with the same key wait for each other, so the second sees the first.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payment:${labId}:${input.idempotencyKey}`}))`);
  const [existing] = await tx.select().from(payments).where(eq(payments.idempotencyKey, input.idempotencyKey));
  if (existing) {
    if (existing.invoiceId !== input.invoiceId) throw conflict('idempotency_conflict', 'This payment key was used for another invoice.');
    return { payment: await paymentRow(existing.id), invoice: await refreshInvoiceTotals(existing.invoiceId), duplicate: true };
  }

  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for('update');
  if (!inv) throw notFound('invoice_not_found');
  if (inv.status === 'void') throw conflict('invoice_void', 'The invoice is void.');
  const amount = roundMoney(input.amount, inv.currency);
  if (!(amount > 0)) throw badRequest('amount_invalid');
  const balance = roundMoney(inv.patientTotal - (await paidSum(inv.id)), inv.currency);
  if (amount > balance) throw badRequest('amount_exceeds_balance', `The balance is ${balance}.`);

  const [method] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, input.methodId));
  if (!method || !method.isActive) throw badRequest('payment_method_invalid');
  let cashSessionId: string | null = null;
  if (method.isCash) {
    const session = await currentCashSession(userId);
    if (!session) throw conflict('no_cash_session', 'Open a cash session before taking cash.');
    cashSessionId = session.id;
  }

  const [row] = await tx
    .insert(payments)
    .values({
      labId,
      invoiceId: inv.id,
      cashSessionId,
      methodId: method.id,
      kind: 'payment',
      amount,
      currency: inv.currency,
      reference: input.reference ?? null,
      note: input.note ?? null,
      receivedBy: userId,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  const totals = await refreshInvoiceTotals(inv.id);
  await audit({
    action: 'payment.create',
    entityType: 'payment',
    entityId: row!.id,
    summary: `${inv.number} · ${amount} ${inv.currency} · ${method.code}`,
    after: { invoiceId: inv.id, amount, method: method.code, reference: input.reference ?? null, paidTotal: totals.paidTotal, status: totals.status },
  });
  publish({ type: 'finance.changed', data: { invoiceId: inv.id, orderId: inv.orderId, paymentId: row!.id } });
  return { payment: await paymentRow(row!.id), invoice: totals, duplicate: false };
}

/* ------------------------------------------------------------------ discounts */

/**
 * Give a manual discount on an invoice (directly by an approver, or when a discount approval is
 * granted). It is spread over the active lines in proportion to what is left on each, stored on
 * the order lines so later recomputations keep it, and capped at what is left to discount.
 */
export async function applyDiscount(invoiceId: string, amount: number, reason: string): Promise<InvoiceTotals & { applied: number }> {
  const tx = db();
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
  if (!inv) throw notFound('invoice_not_found');
  if (inv.status === 'void') throw conflict('invoice_void', 'The invoice is void.');
  const items = await tx
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.orderId, inv.orderId), ne(orderItems.status, 'cancelled')))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const nets = items.map((i) => roundMoney(i.price - i.discount, inv.currency));
  const parts = allocate(amount, nets, nets, inv.currency);
  const applied = roundMoney(parts.reduce((a, b) => a + b, 0), inv.currency);
  if (applied <= 0) throw badRequest('discount_invalid', 'Nothing left to discount.');
  for (const [i, item] of items.entries()) {
    if (!parts[i]) continue;
    await tx
      .update(orderItems)
      .set({ discount: roundMoney(item.discount + parts[i]!, inv.currency) })
      .where(eq(orderItems.id, item.id));
  }
  const before = { patientTotal: inv.patientTotal, discountTotal: inv.discountTotal };
  const totals = await recomputeInvoice(inv.orderId);
  await audit({
    action: 'invoice.discount',
    entityType: 'invoice',
    entityId: inv.id,
    summary: `${inv.number} · −${applied} ${inv.currency} · ${reason}`,
    before,
    after: { patientTotal: totals.patientTotal, discount: applied, reason },
  });
  publish({ type: 'finance.changed', data: { invoiceId: inv.id, orderId: inv.orderId } });
  return { ...totals, applied };
}

/** The amount a discount request stands for (a percentage is taken of what is left to pay before discounts). */
export function discountAmount(base: number, d: { amount?: number; percent?: number }, currency = 'SYP'): number {
  if (d.amount !== undefined) return roundMoney(Math.min(d.amount, base), currency);
  if (d.percent !== undefined) return roundMoney((base * d.percent) / 100, currency);
  return 0;
}

/** Record a discount request for an approver; notifies everyone who can approve discounts. */
export async function createDiscountApproval(params: {
  orderId: string;
  invoiceId: string;
  accession: string;
  amount: number;
  percent?: number | null;
  reason: string;
  currency: string;
}): Promise<string> {
  const { labId, userId } = ctx();
  const [row] = await db()
    .insert(approvals)
    .values({
      labId,
      kind: 'discount',
      orderId: params.orderId,
      invoiceId: params.invoiceId,
      amount: params.amount,
      percent: params.percent ?? null,
      reason: params.reason,
      status: 'pending',
      requestedBy: userId,
    })
    .returning({ id: approvals.id });
  await audit({
    action: 'approval.request',
    entityType: 'approval',
    entityId: row!.id,
    summary: `${params.accession} · −${params.amount} ${params.currency} · ${params.reason}`,
    after: { kind: 'discount', orderId: params.orderId, invoiceId: params.invoiceId, amount: params.amount, percent: params.percent ?? null },
  });
  await notifyPermission('finance.approve', {
    kind: 'approval',
    severity: 'warning',
    titleAr: 'طلب حسم بانتظار الموافقة',
    titleEn: 'Discount request awaiting approval',
    bodyAr: `الطلب ${params.accession} · ${params.amount} ${params.currency} · ${params.reason}`,
    bodyEn: `Order ${params.accession} · ${params.amount} ${params.currency} · ${params.reason}`,
    link: '/finance/approvals',
    entityType: 'approval',
    entityId: row!.id,
  });
  publish({ type: 'finance.changed', data: { invoiceId: params.invoiceId, orderId: params.orderId, approvalId: row!.id } });
  return row!.id;
}

/** Desk discount on an existing invoice: applied at once by approvers, otherwise sent for approval. */
export async function requestDiscount(
  invoiceId: string,
  input: { amount?: number; percent?: number; reason: string },
  opts: { canApprove: boolean },
): Promise<DiscountResult> {
  const tx = db();
  const [inv] = await tx
    .select({ inv: invoices, accession: orders.accession })
    .from(invoices)
    .innerJoin(orders, eq(orders.id, invoices.orderId))
    .where(eq(invoices.id, invoiceId));
  if (!inv) throw notFound('invoice_not_found');
  if (inv.inv.status === 'void') throw conflict('invoice_void', 'The invoice is void.');
  const base = roundMoney(inv.inv.subtotal - inv.inv.discountTotal, inv.inv.currency);
  const amount = discountAmount(base, input, inv.inv.currency);
  if (amount <= 0) throw badRequest('discount_invalid', 'Nothing left to discount.');
  if (opts.canApprove) {
    const totals = await applyDiscount(invoiceId, amount, input.reason);
    return { applied: true, approvalId: null, amount: totals.applied, invoice: { id: totals.id, patientTotal: totals.patientTotal, paidTotal: totals.paidTotal, balance: totals.balance, status: totals.status } };
  }
  const approvalId = await createDiscountApproval({
    orderId: inv.inv.orderId,
    invoiceId,
    accession: inv.accession,
    amount,
    percent: input.percent ?? null,
    reason: input.reason,
    currency: inv.inv.currency,
  });
  const totals = await refreshInvoiceTotals(invoiceId);
  return { applied: false, approvalId, amount, invoice: { id: totals.id, patientTotal: totals.patientTotal, paidTotal: totals.paidTotal, balance: totals.balance, status: totals.status } };
}

/* ------------------------------------------------------------------ reads */

async function namesOf(ids: Array<string | null>): Promise<Map<string, { fullNameAr: string; fullNameEn: string }>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db().select({ id: users.id, fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, { fullNameAr: r.fullNameAr, fullNameEn: r.fullNameEn }]));
}

async function paymentRows(where: ReturnType<typeof eq>): Promise<PaymentRow[]> {
  const rows = await db()
    .select({ p: payments, m: paymentMethods })
    .from(payments)
    .innerJoin(paymentMethods, eq(paymentMethods.id, payments.methodId))
    .where(where)
    .orderBy(asc(payments.receivedAt));
  const names = await namesOf(rows.map((r) => r.p.receivedBy));
  return rows.map(({ p, m }) => ({
    id: p.id,
    kind: p.kind,
    amount: p.amount,
    currency: p.currency,
    methodId: m.id,
    methodCode: m.code,
    methodNameAr: m.nameAr,
    methodNameEn: m.nameEn,
    isCash: m.isCash,
    reference: p.reference,
    receivedAt: p.receivedAt.toISOString(),
    receivedBy: p.receivedBy ? names.get(p.receivedBy) ?? null : null,
  }));
}

async function paymentRow(paymentId: string): Promise<PaymentRow> {
  const [row] = await paymentRows(eq(payments.id, paymentId));
  if (!row) throw notFound('payment_not_found');
  return row;
}

async function approvalRows(orderId: string, invoiceId: string): Promise<ApprovalRow[]> {
  const rows = await db()
    .select()
    .from(approvals)
    .where(or(eq(approvals.orderId, orderId), eq(approvals.invoiceId, invoiceId)))
    .orderBy(desc(approvals.requestedAt));
  const names = await namesOf(rows.map((r) => r.requestedBy));
  return rows.map((a) => ({
    id: a.id,
    kind: a.kind,
    amount: a.amount,
    percent: a.percent,
    reason: a.reason,
    status: a.status,
    requestedAt: a.requestedAt.toISOString(),
    requestedBy: a.requestedBy ? names.get(a.requestedBy) ?? null : null,
    decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
    decisionNote: a.decisionNote,
  }));
}

/** Invoice with lines (test names), payments (method, cashier) and discount approvals. */
export async function getInvoiceDetail(invoiceId: string): Promise<InvoiceDetail> {
  const tx = db();
  const [row] = await tx
    .select({ inv: invoices, accession: orders.accession, p: patients, pg: payerGroups })
    .from(invoices)
    .innerJoin(orders, eq(orders.id, invoices.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(payerGroups, eq(payerGroups.id, invoices.payerGroupId))
    .where(eq(invoices.id, invoiceId));
  if (!row) throw notFound('invoice_not_found');
  const { inv, p, pg } = row;
  const lineRows = await tx
    .select({
      l: invoiceLines,
      testId: orderItems.testId,
      code: tests.code,
      nameAr: tests.nameAr,
      nameEn: tests.nameEn,
      packageCode: packages.code,
      sort: orderItems.createdAt,
    })
    .from(invoiceLines)
    .leftJoin(orderItems, eq(orderItems.id, invoiceLines.orderItemId))
    .leftJoin(tests, eq(tests.id, orderItems.testId))
    .leftJoin(packages, eq(packages.id, orderItems.packageId))
    .where(eq(invoiceLines.invoiceId, inv.id))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id), asc(invoiceLines.id));
  const lines: InvoiceLineRow[] = lineRows.map((r) => ({
    id: r.l.id,
    orderItemId: r.l.orderItemId,
    testId: r.testId ?? null,
    code: r.code ?? null,
    nameAr: r.nameAr ?? null,
    nameEn: r.nameEn ?? null,
    packageCode: r.packageCode ?? null,
    description: r.l.description,
    units: r.l.units,
    unitPrice: r.l.unitPrice,
    price: r.l.price,
    discount: r.l.discount,
    insurerShare: r.l.insurerShare,
    patientShare: r.l.patientShare,
  }));
  return {
    id: inv.id,
    number: inv.number,
    orderId: inv.orderId,
    accession: row.accession,
    status: inv.status,
    currency: inv.currency,
    subtotal: inv.subtotal,
    discountTotal: inv.discountTotal,
    insurerTotal: inv.insurerTotal,
    patientTotal: inv.patientTotal,
    paidTotal: inv.paidTotal,
    balance: balanceOf(inv, inv.currency),
    createdAt: inv.createdAt.toISOString(),
    voidedAt: inv.voidedAt ? inv.voidedAt.toISOString() : null,
    voidReason: inv.voidReason,
    payer: { id: pg.id, code: pg.code, nameAr: pg.nameAr, nameEn: pg.nameEn, kind: pg.kind, patientSharePct: pg.patientSharePct, onAccount: pg.onAccount },
    patient: {
      id: p.id,
      mrn: p.mrn,
      fullNameAr: p.fullNameAr,
      fullNameEn: p.fullNameEn,
      sex: p.sex,
      birthDate: p.birthDate,
      birthDateEstimated: p.birthDateEstimated,
      phone: p.phone,
    },
    lines,
    payments: await paymentRows(eq(payments.invoiceId, inv.id)),
    approvals: await approvalRows(inv.orderId, inv.id),
  };
}

export async function invoiceIdForOrder(orderId: string): Promise<string | null> {
  const [row] = await db().select({ id: invoices.id }).from(invoices).where(eq(invoices.orderId, orderId));
  return row?.id ?? null;
}

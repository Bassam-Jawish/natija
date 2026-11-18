/**
 * Desk money: invoices, payments and discounts (port of apps/api/src/modules/billing). The front
 * desk and the back office both use these functions.
 */
import { discountInput, paymentInput } from '@natija/contracts';
import { dateKey, invoiceNumber, invoiceStatus, roundMoney } from '@natija/domain';
import type { ApprovalRow, DiscountResult, InvoiceDetail, InvoiceLineRow, InvoiceStatusValue, PaymentResult, PaymentRow } from '@natija/contracts';
import { badRequest, conflict, ctx, notFound, now } from '../../core/context';
import { by, find, get, insert, remove, rows, update, type Row } from '../../core/db';
import { audit, getLab, nextCounter, notifyPermission, parse, publish } from '../../core/lib';
import { route } from '../../core/router';

export type InvoiceTotals = { id: string; patientTotal: number; paidTotal: number; balance: number; status: InvoiceStatusValue };

/* ------------------------------------------------------------------ helpers */

/** What the patient still owes (negative when they paid more than they owe: refund due). */
export function balanceOf(inv: { patientTotal: number; paidTotal: number; status: string }, currency = 'SYP'): number {
  if (inv.status === 'void') return roundMoney(-inv.paidTotal, currency);
  return roundMoney(inv.patientTotal - inv.paidTotal, currency);
}

/** Split `total` over lines in proportion to `weights`, never above each cap, in whole units. */
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

/** Patient and insurer shares of each line (the patient total is exactly the payer's share of the net). */
export function splitShares(lines: Array<{ price: number; discount: number }>, patientSharePct: number, currency = 'SYP') {
  const nets = lines.map((l) => Math.max(0, roundMoney(l.price - l.discount, currency)));
  const totalNet = roundMoney(nets.reduce((a, b) => a + b, 0), currency);
  const patientTotal = roundMoney((totalNet * patientSharePct) / 100, currency);
  const patient = allocate(patientTotal, nets, nets, currency);
  return nets.map((net, i) => ({ net, patientShare: patient[i]!, insurerShare: roundMoney(net - patient[i]!, currency) }));
}

/** The signed-in user's open cash session, if any (cash payments need one). */
export function currentCashSession(userId: string | null = ctx().userId): { id: string; openedAt: Date } | null {
  if (!userId) return null;
  const open = by('cashSessions', 'openedBy', userId)
    .filter((s) => s.status === 'open')
    .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];
  return open ? { id: open.id, openedAt: open.openedAt } : null;
}

function paidSum(invoiceId: string): number {
  return by('payments', 'invoiceId', invoiceId).reduce((sum, p) => sum + (p.kind === 'refund' ? -p.amount : p.amount), 0);
}

/* ------------------------------------------------------------------ totals */

/** Recompute the paid total from payments (refunds subtract) and the invoice status. */
export function refreshInvoiceTotals(invoiceId: string): InvoiceTotals {
  const inv = get('invoices', invoiceId, 'invoice_not_found');
  const paidTotal = roundMoney(paidSum(invoiceId), inv.currency);
  const status = invoiceStatus(inv.patientTotal, paidTotal, inv.status === 'void');
  if (paidTotal !== inv.paidTotal || status !== inv.status) {
    update('invoices', inv, { paidTotal, status, updatedAt: now(), version: inv.version + 1 });
  }
  return { id: inv.id, patientTotal: inv.patientTotal, paidTotal, balance: balanceOf(inv, inv.currency), status };
}

function createInvoiceRow(order: Row<'orders'>): Row<'invoices'> {
  const { userId } = ctx();
  const lab = getLab();
  const year = dateKey(order.createdAt, lab.timezone).slice(0, 4);
  const n = nextCounter(`invoice:${year}`);
  return insert('invoices', {
    orderId: order.id,
    number: invoiceNumber(Number(year), n),
    payerGroupId: order.payerGroupId,
    currency: lab.currency,
    createdBy: userId,
  });
}

/** Bring an order's invoice in line with its active lines, then the totals and status. */
export function recomputeInvoice(orderId: string): InvoiceTotals {
  const order = get('orders', orderId, 'order_not_found');
  const inv = by('invoices', 'orderId', orderId)[0] ?? createInvoiceRow(order);
  if (inv.status === 'void') return refreshInvoiceTotals(inv.id);
  const pct = find('payerGroups', inv.payerGroupId)?.patientSharePct ?? 100;

  const items = by('orderItems', 'orderId', orderId)
    .filter((i) => i.status !== 'cancelled')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const active = new Set(items.map((i) => i.id));
  const lines = by('invoiceLines', 'invoiceId', inv.id);
  const byItem = new Map(lines.filter((l) => l.orderItemId).map((l) => [l.orderItemId!, l]));
  remove('invoiceLines', (l) => l.invoiceId === inv.id && !!l.orderItemId && !active.has(l.orderItemId));

  const shares = splitShares(items, pct, inv.currency);
  for (const [idx, item] of items.entries()) {
    const test = find('tests', item.testId);
    const values = {
      units: item.units,
      unitPrice: item.unitPrice,
      price: item.price,
      discount: item.discount,
      patientShare: shares[idx]!.patientShare,
      insurerShare: shares[idx]!.insurerShare,
    };
    const existing = byItem.get(item.id);
    if (!existing) insert('invoiceLines', { invoiceId: inv.id, orderItemId: item.id, description: `${test?.code ?? ''} · ${test?.nameEn ?? ''}`, ...values });
    else update('invoiceLines', existing, values);
  }

  const current = by('invoiceLines', 'invoiceId', inv.id);
  const sum = (k: 'price' | 'discount' | 'patientShare' | 'insurerShare') => roundMoney(current.reduce((s, l) => s + l[k], 0), inv.currency);
  update('invoices', inv, {
    subtotal: sum('price'),
    discountTotal: sum('discount'),
    patientTotal: sum('patientShare'),
    insurerTotal: sum('insurerShare'),
    updatedAt: now(),
    version: inv.version + 1,
  });
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

/** Take a payment. The same idempotency key returns the original payment without charging again. */
export function takePayment(input: TakePaymentInput): PaymentResult {
  const { userId } = ctx();
  const existing = input.idempotencyKey ? by('payments', 'idempotencyKey', input.idempotencyKey)[0] : undefined;
  if (existing) {
    if (existing.invoiceId !== input.invoiceId) throw conflict('idempotency_conflict', 'This payment key was used for another invoice.');
    return { payment: paymentRow(existing.id), invoice: refreshInvoiceTotals(existing.invoiceId), duplicate: true };
  }
  const inv = get('invoices', input.invoiceId, 'invoice_not_found');
  if (inv.status === 'void') throw conflict('invoice_void', 'The invoice is void.');
  const amount = roundMoney(Number(input.amount) || 0, inv.currency);
  if (!(amount > 0)) throw badRequest('amount_invalid');
  const balance = roundMoney(inv.patientTotal - paidSum(inv.id), inv.currency);
  if (amount > balance) throw badRequest('amount_exceeds_balance', `The balance is ${balance}.`);
  const method = find('paymentMethods', input.methodId) ?? rows('paymentMethods').find((m) => m.isActive);
  if (!method) throw badRequest('payment_method_invalid');
  let cashSessionId: string | null = null;
  if (method.isCash) {
    const session = currentCashSession(userId);
    if (!session) throw conflict('no_cash_session', 'Open a cash session before taking cash.');
    cashSessionId = session.id;
  }
  const row = insert('payments', {
    invoiceId: inv.id,
    cashSessionId,
    methodId: method.id,
    kind: 'payment',
    amount,
    currency: inv.currency,
    reference: input.reference ?? null,
    note: input.note ?? null,
    receivedBy: userId,
    receivedAt: now(),
    idempotencyKey: input.idempotencyKey || crypto.randomUUID(),
  });
  const totals = refreshInvoiceTotals(inv.id);
  audit({
    action: 'payment.create',
    entityType: 'payment',
    entityId: row.id,
    summary: `${inv.number} · ${amount} ${inv.currency} · ${method.code}`,
    after: { invoiceId: inv.id, amount, method: method.code, reference: input.reference ?? null, paidTotal: totals.paidTotal, status: totals.status },
  });
  publish({ type: 'finance.changed', data: { invoiceId: inv.id, orderId: inv.orderId, paymentId: row.id } });
  return { payment: paymentRow(row.id), invoice: totals, duplicate: false };
}

/* ------------------------------------------------------------------ discounts */

/** Give a manual discount on an invoice, spread over the active lines and kept on the order lines. */
export function applyDiscount(invoiceId: string, amount: number, reason: string): InvoiceTotals & { applied: number } {
  const inv = get('invoices', invoiceId, 'invoice_not_found');
  if (inv.status === 'void') throw conflict('invoice_void', 'The invoice is void.');
  const items = by('orderItems', 'orderId', inv.orderId)
    .filter((i) => i.status !== 'cancelled')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const nets = items.map((i) => roundMoney(i.price - i.discount, inv.currency));
  const parts = allocate(amount, nets, nets, inv.currency);
  const applied = roundMoney(parts.reduce((a, b) => a + b, 0), inv.currency);
  if (applied <= 0) throw badRequest('discount_invalid', 'Nothing left to discount.');
  for (const [i, item] of items.entries()) {
    if (parts[i]) update('orderItems', item, { discount: roundMoney(item.discount + parts[i]!, inv.currency) });
  }
  const before = { patientTotal: inv.patientTotal, discountTotal: inv.discountTotal };
  const totals = recomputeInvoice(inv.orderId);
  audit({
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

/** The amount a discount request stands for (a percentage is taken of what is left before discounts). */
export function discountAmount(base: number, d: { amount?: number; percent?: number }, currency = 'SYP'): number {
  if (d.amount !== undefined) return roundMoney(Math.min(d.amount, base), currency);
  if (d.percent !== undefined) return roundMoney((base * d.percent) / 100, currency);
  return 0;
}

/** Record a discount request for an approver; notifies everyone who can approve discounts. */
export function createDiscountApproval(params: {
  orderId: string;
  invoiceId: string;
  accession: string;
  amount: number;
  percent?: number | null;
  reason: string;
  currency: string;
}): string {
  const { userId } = ctx();
  const row = insert('approvals', {
    kind: 'discount',
    orderId: params.orderId,
    invoiceId: params.invoiceId,
    amount: params.amount,
    percent: params.percent ?? null,
    reason: params.reason,
    status: 'pending',
    requestedBy: userId,
    requestedAt: now(),
  });
  audit({
    action: 'approval.request',
    entityType: 'approval',
    entityId: row.id,
    summary: `${params.accession} · −${params.amount} ${params.currency} · ${params.reason}`,
    after: { kind: 'discount', orderId: params.orderId, invoiceId: params.invoiceId, amount: params.amount, percent: params.percent ?? null },
  });
  notifyPermission('finance.approve', {
    kind: 'approval',
    severity: 'warning',
    titleAr: 'طلب حسم بانتظار الموافقة',
    titleEn: 'Discount request awaiting approval',
    bodyAr: `الطلب ${params.accession} · ${params.amount} ${params.currency} · ${params.reason}`,
    bodyEn: `Order ${params.accession} · ${params.amount} ${params.currency} · ${params.reason}`,
    link: '/finance/approvals',
    entityType: 'approval',
    entityId: row.id,
  });
  publish({ type: 'finance.changed', data: { invoiceId: params.invoiceId, orderId: params.orderId, approvalId: row.id } });
  return row.id;
}

/** Desk discount on an existing invoice: applied at once by approvers, otherwise sent for approval. */
export function requestDiscount(invoiceId: string, input: { amount?: number; percent?: number; reason: string }, opts: { canApprove: boolean }): DiscountResult {
  const inv = get('invoices', invoiceId, 'invoice_not_found');
  const order = get('orders', inv.orderId, 'order_not_found');
  if (inv.status === 'void') throw conflict('invoice_void', 'The invoice is void.');
  const base = roundMoney(inv.subtotal - inv.discountTotal, inv.currency);
  const amount = discountAmount(base, input, inv.currency);
  if (amount <= 0) throw badRequest('discount_invalid', 'Nothing left to discount.');
  if (opts.canApprove) {
    const totals = applyDiscount(invoiceId, amount, input.reason);
    return { applied: true, approvalId: null, amount: totals.applied, invoice: { id: totals.id, patientTotal: totals.patientTotal, paidTotal: totals.paidTotal, balance: totals.balance, status: totals.status } };
  }
  const approvalId = createDiscountApproval({
    orderId: inv.orderId,
    invoiceId,
    accession: order.accession,
    amount,
    percent: input.percent ?? null,
    reason: input.reason,
    currency: inv.currency,
  });
  const totals = refreshInvoiceTotals(invoiceId);
  return { applied: false, approvalId, amount, invoice: { id: totals.id, patientTotal: totals.patientTotal, paidTotal: totals.paidTotal, balance: totals.balance, status: totals.status } };
}

/* ------------------------------------------------------------------ reads */

export function userName(id: string | null | undefined): { fullNameAr: string; fullNameEn: string } | null {
  const u = id ? find('users', id) : undefined;
  return u ? { fullNameAr: u.fullNameAr, fullNameEn: u.fullNameEn } : null;
}

export function paymentRowOf(p: Row<'payments'>): PaymentRow {
  const m = find('paymentMethods', p.methodId);
  return {
    id: p.id,
    kind: p.kind,
    amount: p.amount,
    currency: p.currency,
    methodId: p.methodId,
    methodCode: m?.code ?? '',
    methodNameAr: m?.nameAr ?? '',
    methodNameEn: m?.nameEn ?? '',
    isCash: m?.isCash ?? false,
    reference: p.reference,
    receivedAt: p.receivedAt.toISOString(),
    receivedBy: userName(p.receivedBy),
  };
}

function paymentRow(paymentId: string): PaymentRow {
  return paymentRowOf(get('payments', paymentId, 'payment_not_found'));
}

function approvalRows(orderId: string, invoiceId: string): ApprovalRow[] {
  return rows('approvals')
    .filter((a) => a.orderId === orderId || a.invoiceId === invoiceId)
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      amount: a.amount,
      percent: a.percent,
      reason: a.reason,
      status: a.status,
      requestedAt: a.requestedAt.toISOString(),
      requestedBy: userName(a.requestedBy),
      decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
      decisionNote: a.decisionNote,
    }));
}

/** Invoice with lines (test names), payments (method, cashier) and discount approvals. */
export function getInvoiceDetail(invoiceId: string): InvoiceDetail {
  const inv = get('invoices', invoiceId, 'invoice_not_found');
  const order = get('orders', inv.orderId, 'invoice_not_found');
  const p = get('patients', order.patientId, 'invoice_not_found');
  const pg = get('payerGroups', inv.payerGroupId, 'invoice_not_found');
  const lines: InvoiceLineRow[] = by('invoiceLines', 'invoiceId', inv.id)
    .map((l) => ({ l, item: l.orderItemId ? find('orderItems', l.orderItemId) : undefined }))
    .sort((a, b) => (a.item?.createdAt.getTime() ?? 0) - (b.item?.createdAt.getTime() ?? 0) || (a.item?.id ?? '').localeCompare(b.item?.id ?? '') || a.l.id.localeCompare(b.l.id))
    .map(({ l, item }) => {
      const test = item ? find('tests', item.testId) : undefined;
      const pkg = item?.packageId ? find('packages', item.packageId) : undefined;
      return {
        id: l.id,
        orderItemId: l.orderItemId,
        testId: item?.testId ?? null,
        code: test?.code ?? null,
        nameAr: test?.nameAr ?? null,
        nameEn: test?.nameEn ?? null,
        packageCode: pkg?.code ?? null,
        description: l.description,
        units: l.units,
        unitPrice: l.unitPrice,
        price: l.price,
        discount: l.discount,
        insurerShare: l.insurerShare,
        patientShare: l.patientShare,
      };
    });
  return {
    id: inv.id,
    number: inv.number,
    orderId: inv.orderId,
    accession: order.accession,
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
    payments: by('payments', 'invoiceId', inv.id)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .map(paymentRowOf),
    approvals: approvalRows(inv.orderId, inv.id),
  };
}

export function invoiceIdForOrder(orderId: string): string | null {
  return by('invoices', 'orderId', orderId)[0]?.id ?? null;
}

/* ------------------------------------------------------------------ routes */

export function registerBilling(): void {
  route('GET', '/billing/cash-session', { perm: ['finance.payment', 'finance.cash'] }, () => {
    const s = currentCashSession();
    return { cashSession: s ? { id: s.id, openedAt: s.openedAt.toISOString() } : null };
  });

  route('GET', '/billing/invoices/:id', { perm: ['finance.read', 'orders.read'] }, (req) => getInvoiceDetail(req.params.id!));

  route('POST', '/billing/payments', { perm: 'finance.payment' }, (req) => takePayment(parse(paymentInput, req.body) as TakePaymentInput));

  route('POST', '/billing/invoices/:id/discount', { perm: ['orders.create', 'orders.edit', 'finance.approve'] }, (req) =>
    requestDiscount(req.params.id!, parse(discountInput, req.body) as { amount?: number; percent?: number; reason: string }, {
      canApprove: req.auth!.permissions.has('finance.approve'),
    }),
  );
}

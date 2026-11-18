/**
 * Finance back office: port of apps/api/src/modules/finance/{service,routes}.ts. Cash sessions,
 * payments and invoices lists, insurer / client-lab statements (exported as CSV), refunds,
 * discount approvals, expenses and the money summary. Desk payments and discounts live in
 * ../shared/billing.ts; this module reuses its applyDiscount, currentCashSession and
 * refreshInvoiceTotals, as the server reuses the billing module.
 *
 * Mock mode takes any input: amounts and notes are never refused for their format. The money
 * rules stay: cash needs an open session, a refund cannot exceed what was paid, nobody decides
 * their own request, and a closed session cannot be closed again.
 */
import { z } from 'zod';
import {
  adminListQuery,
  adminRangeQuery,
  FinanceCloseSessionInput,
  FinanceDecideInput,
  FinanceExpenseCategoryInput,
  FinanceExpenseInput,
  FinanceOpenSessionInput,
  FinanceRefundInput,
  isoDate,
} from '@natija/contracts';
import type {
  FinanceApproval,
  FinanceCashSession,
  FinanceCashTotals,
  FinanceExpense,
  FinanceExpenseCategory,
  FinanceExpenseList,
  FinanceInvoice,
  FinanceMethodTotal,
  FinancePayment,
  FinanceStatement,
  FinanceSummary,
  PricingPayerGroup,
} from '@natija/contracts';
import { normalizeText, roundMoney } from '@natija/domain';
import { AppError, badRequest, conflict, ctx, forbidden, notFound, now } from '../../core/context';
import { by, find, insert, remove, rows, update, type Row } from '../../core/db';
import { dayRange, getLab, labToday, notifyPermission, notifyUsers, parse, publish, slice, zonedDayStart } from '../../core/lib';
import { route } from '../../core/router';
import { applyDiscount, balanceOf, currentCashSession, refreshInvoiceTotals, userName } from '../shared/billing';
import { amountOf, cents, fillDays, iso, labClock, record, textOf } from './util';
import { buildWorkbook, L } from './workbook';

type In<T extends z.ZodTypeAny> = z.output<T>;
type SessionRow = Row<'cashSessions'>;
type PaymentRow = Row<'payments'>;
type InvoiceRow = Row<'invoices'>;
type OrderRow = Row<'orders'>;
type PatientRow = Row<'patients'>;

const moneyChanged = (data: Record<string, unknown>) => publish({ type: 'finance.changed', data });
const currency = (): string => getLab().currency;
const optNote = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/* ================================================================== cash sessions */

/** Payments and refunds of a session: linked to it, or taken by its owner during it without a link (non-cash). */
function sessionPayments(s: SessionRow): PaymentRow[] {
  const opened = s.openedAt.getTime();
  const closed = s.closedAt ? s.closedAt.getTime() : null;
  const unlinked = by('payments', 'receivedBy', s.openedBy).filter((p) => {
    if (p.cashSessionId !== null) return false;
    const t = p.receivedAt.getTime();
    return t >= opened && (closed === null || t < closed);
  });
  return [...by('payments', 'cashSessionId', s.id), ...unlinked];
}

/** Payments, refunds and payment count per method, in the methods' order (only methods that were used). */
export function methodTotals(list: Iterable<PaymentRow>): FinanceMethodTotal[] {
  const acc = new Map<string, { payments: number; refunds: number; count: number }>();
  for (const p of list) {
    let a = acc.get(p.methodId);
    if (!a) acc.set(p.methodId, (a = { payments: 0, refunds: 0, count: 0 }));
    if (p.kind === 'payment') {
      a.payments += p.amount;
      a.count += 1;
    } else if (p.kind === 'refund') a.refunds += p.amount;
  }
  const out: Array<{ sort: number; row: FinanceMethodTotal }> = [];
  for (const [methodId, a] of acc) {
    const m = find('paymentMethods', methodId);
    if (!m) continue;
    const p = cents(a.payments);
    const rf = cents(a.refunds);
    out.push({
      sort: m.sortOrder,
      row: { methodId: m.id, code: m.code, nameAr: m.nameAr, nameEn: m.nameEn, isCash: m.isCash, payments: p, refunds: rf, count: a.count, net: p - rf },
    });
  }
  return out.sort((x, y) => x.sort - y.sort || x.row.code.localeCompare(y.row.code)).map((x) => x.row);
}

function sessionTotals(s: SessionRow): FinanceCashTotals {
  const cur = currency();
  const byMethod = methodTotals(sessionPayments(s));
  const cash = byMethod.filter((m) => m.isCash);
  const cashPayments = cash.reduce((a, m) => a + m.payments, 0);
  const cashRefunds = cash.reduce((a, m) => a + m.refunds, 0);
  const cashExpenses = cents(by('expenses', 'cashSessionId', s.id).reduce((a, e) => a + e.amount, 0));
  return {
    openingFloat: s.openingFloat,
    cashPayments: roundMoney(cashPayments, cur),
    cashRefunds: roundMoney(cashRefunds, cur),
    cashExpenses: roundMoney(cashExpenses, cur),
    expectedCash: roundMoney(s.openingFloat + cashPayments - cashRefunds - cashExpenses, cur),
    byMethod,
    paymentCount: byMethod.reduce((a, m) => a + m.count, 0),
  };
}

function sessionOut(s: SessionRow): FinanceCashSession {
  const o = userName(s.openedBy);
  const c = userName(s.closedBy);
  return {
    id: s.id,
    status: s.status,
    openedBy: s.openedBy,
    openedByNameAr: o?.fullNameAr ?? null,
    openedByNameEn: o?.fullNameEn ?? null,
    closedByNameAr: c?.fullNameAr ?? null,
    closedByNameEn: c?.fullNameEn ?? null,
    branchId: s.branchId,
    openedAt: s.openedAt.toISOString(),
    closedAt: iso(s.closedAt),
    openingFloat: s.openingFloat,
    countedCash: s.countedCash,
    expectedCash: s.expectedCash,
    difference: s.difference,
    note: s.note,
    totals: sessionTotals(s),
  };
}

export function currentSession(): { session: FinanceCashSession | null } {
  const open = currentCashSession(ctx().userId);
  if (!open) return { session: null };
  const s = find('cashSessions', open.id);
  return { session: s ? sessionOut(s) : null };
}

export function getSession(id: string, opts: { canReadAll: boolean }): FinanceCashSession {
  const s = find('cashSessions', id);
  if (!s) throw notFound();
  if (!opts.canReadAll && s.openedBy !== ctx().userId) throw notFound();
  return sessionOut(s);
}

export function openSession(input: In<typeof FinanceOpenSessionInput>): FinanceCashSession {
  const { userId } = ctx();
  if (!userId) throw forbidden();
  if (currentCashSession(userId)) throw conflict('session_already_open', 'You already have an open cash session');
  // Mock mode refuses no input: an unknown branch is left out (the server answers 400).
  const branchId = input.branchId && find('branches', input.branchId) ? input.branchId : null;
  const cur = currency();
  const row = insert('cashSessions', { openedBy: userId, branchId, openingFloat: roundMoney(amountOf(input.openingFloat), cur), status: 'open', openedAt: now() });
  record({
    action: 'finance.cash_session.opened',
    entityType: 'cash_session',
    entityId: row.id,
    summary: `float ${row.openingFloat} ${cur}`,
    after: { openingFloat: row.openingFloat, branchId: row.branchId },
  });
  moneyChanged({ cashSessionId: row.id });
  return sessionOut(row);
}

/**
 * Close a cash session: expected cash = opening float + cash payments − cash refunds − cash
 * expenses of the session; difference = counted − expected. Supervisors (finance.approve) may
 * close someone else's session.
 */
export function closeSession(id: string, input: In<typeof FinanceCloseSessionInput>, opts: { canSupervise: boolean }): FinanceCashSession {
  const s = find('cashSessions', id);
  if (!s) throw notFound();
  const { userId } = ctx();
  if (s.openedBy !== userId && !opts.canSupervise) throw forbidden('not_your_session', 'Only the cashier or a supervisor can close this session');
  if (s.status !== 'open') throw conflict('session_closed', 'The session is already closed');
  const cur = currency();
  const totals = sessionTotals(s);
  const countedCash = roundMoney(amountOf(input.countedCash), cur);
  const difference = roundMoney(countedCash - totals.expectedCash, cur);
  const note = input.note ?? null;
  update('cashSessions', s, { status: 'closed', closedBy: userId, closedAt: now(), countedCash, expectedCash: totals.expectedCash, difference, note });
  record({
    action: 'finance.cash_session.closed',
    entityType: 'cash_session',
    entityId: id,
    summary: `expected ${totals.expectedCash} · counted ${countedCash} · difference ${difference} ${cur}`,
    before: { status: 'open' },
    after: {
      status: 'closed',
      openingFloat: s.openingFloat,
      cashPayments: totals.cashPayments,
      cashRefunds: totals.cashRefunds,
      cashExpenses: totals.cashExpenses,
      expectedCash: totals.expectedCash,
      countedCash,
      difference,
      note,
    },
  });
  if (difference !== 0) {
    const who = userName(s.openedBy);
    notifyPermission('finance.approve', {
      kind: 'system',
      severity: 'warning',
      titleAr: 'فرق في الصندوق عند الإغلاق',
      titleEn: 'Cash difference at closing',
      bodyAr: `${who?.fullNameAr ?? ''}: الفرق ${difference} ${cur}`,
      bodyEn: `${who?.fullNameEn ?? ''}: difference ${difference} ${cur}`,
      link: '/finance',
      entityType: 'cash_session',
      entityId: id,
    });
  }
  moneyChanged({ cashSessionId: id });
  return sessionOut(s);
}

export function listSessions(f: { from?: string; to?: string; status?: 'open' | 'closed'; userId?: string; limit: number; offset: number }) {
  let list = rows('cashSessions').slice();
  if (f.from || f.to) {
    const { start, end } = dayRange(f.from, f.to);
    const s = start.getTime();
    const e = end.getTime();
    list = list.filter((x) => x.openedAt.getTime() >= s && x.openedAt.getTime() < e);
  }
  if (f.status) list = list.filter((x) => x.status === f.status);
  if (f.userId) list = list.filter((x) => x.openedBy === f.userId);
  list.sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
  return { items: slice(list, f).map(sessionOut), total: list.length };
}

/* ================================================================== payments */

type PaymentJoin = { p: PaymentRow; inv: InvoiceRow; o: OrderRow; pt: PatientRow };

/** The invoice, order and patient of a payment (the server's inner joins). */
function joinPayment(p: PaymentRow): PaymentJoin | null {
  const inv = find('invoices', p.invoiceId);
  const o = inv ? find('orders', inv.orderId) : undefined;
  const pt = o ? find('patients', o.patientId) : undefined;
  return inv && o && pt ? { p, inv, o, pt } : null;
}

function paymentOut(p: PaymentRow): FinancePayment {
  const m = find('paymentMethods', p.methodId);
  const j = joinPayment(p);
  const u = userName(p.receivedBy);
  return {
    id: p.id,
    kind: p.kind,
    amount: p.amount,
    currency: p.currency,
    methodId: p.methodId,
    methodNameAr: m?.nameAr ?? '',
    methodNameEn: m?.nameEn ?? '',
    isCash: m?.isCash ?? false,
    reference: p.reference,
    note: p.note,
    receivedAt: p.receivedAt.toISOString(),
    receivedByNameAr: u?.fullNameAr ?? null,
    receivedByNameEn: u?.fullNameEn ?? null,
    cashSessionId: p.cashSessionId,
    invoiceId: p.invoiceId,
    invoiceNumber: j?.inv.number ?? '',
    orderId: j?.o.id ?? '',
    accession: j?.o.accession ?? '',
    patientNameAr: j?.pt.fullNameAr ?? '',
    patientNameEn: j?.pt.fullNameEn ?? null,
  };
}

export function listPayments(f: {
  from?: string;
  to?: string;
  methodId?: string;
  kind?: 'payment' | 'refund';
  userId?: string;
  sessionId?: string;
  q?: string;
  limit: number;
  offset: number;
}) {
  const { start, end } = dayRange(f.from, f.to);
  const s = start.getTime();
  const e = end.getTime();
  const match = f.q ? invoiceSearch(f.q) : null;
  const scope: PaymentRow[] = [];
  const hits: PaymentRow[] = [];
  for (const p of rows('payments')) {
    const t = p.receivedAt.getTime();
    if (t < s || t >= e) continue;
    if (f.userId && p.receivedBy !== f.userId) continue;
    if (f.sessionId && p.cashSessionId !== f.sessionId) continue;
    scope.push(p);
    if (f.methodId && p.methodId !== f.methodId) continue;
    if (f.kind && p.kind !== f.kind) continue;
    const j = joinPayment(p);
    if (!j || (match && !match(j.inv, j.o, j.pt))) continue;
    hits.push(p);
  }
  hits.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  return { items: slice(hits, f).map(paymentOut), total: hits.length, byMethod: methodTotals(scope) };
}

/* ================================================================== invoices */

/** Invoice number, order number, file number or patient name (as the server's ilike search). */
function invoiceSearch(q: string): (inv: InvoiceRow, o: OrderRow, pt: PatientRow) => boolean {
  const raw = q.trim().replace(/[%_]/g, '').toLowerCase();
  const norm = normalizeText(q).replace(/[%_]/g, '');
  return (inv, o, pt) =>
    inv.number.toLowerCase().includes(raw) ||
    o.accession.toLowerCase().startsWith(raw) ||
    pt.mrn.toLowerCase().startsWith(raw) ||
    (!!norm && (pt.searchText ?? '').toLowerCase().includes(norm));
}

type InvoiceJoin = { inv: InvoiceRow; o: OrderRow; pt: PatientRow; pg: Row<'payerGroups'> };

function joinInvoice(inv: InvoiceRow): InvoiceJoin | null {
  const o = find('orders', inv.orderId);
  const pt = o ? find('patients', o.patientId) : undefined;
  const pg = find('payerGroups', inv.payerGroupId);
  return o && pt && pg ? { inv, o, pt, pg } : null;
}

function invoiceOut({ inv, o, pt, pg }: InvoiceJoin, cur: string): FinanceInvoice {
  return {
    id: inv.id,
    number: inv.number,
    orderId: inv.orderId,
    accession: o.accession,
    patientId: pt.id,
    patientNameAr: pt.fullNameAr,
    patientNameEn: pt.fullNameEn,
    mrn: pt.mrn,
    payerGroupId: inv.payerGroupId,
    payerNameAr: pg.nameAr,
    payerNameEn: pg.nameEn,
    payerKind: pg.kind,
    currency: inv.currency,
    subtotal: inv.subtotal,
    discountTotal: inv.discountTotal,
    insurerTotal: inv.insurerTotal,
    patientTotal: inv.patientTotal,
    paidTotal: inv.paidTotal,
    status: inv.status,
    createdAt: inv.createdAt.toISOString(),
    balance: balanceOf(inv, cur),
  };
}

export type InvoiceFilters = {
  from?: string;
  to?: string;
  status?: 'open' | 'partial' | 'paid' | 'void' | 'due';
  payerGroupId?: string;
  payerKind?: string;
  q?: string;
  limit: number;
  offset: number;
};

export function listInvoices(f: InvoiceFilters) {
  let window: [number, number] | null = null;
  if (f.from || f.to) {
    const { start, end } = dayRange(f.from, f.to);
    window = [start.getTime(), end.getTime()];
  }
  const match = f.q ? invoiceSearch(f.q) : null;
  const cur = currency();
  const hits: InvoiceJoin[] = [];
  let subtotal = 0;
  let patient = 0;
  let paid = 0;
  let due = 0;
  for (const inv of rows('invoices')) {
    if (window) {
      const t = inv.createdAt.getTime();
      if (t < window[0] || t >= window[1]) continue;
    }
    if (f.status === 'due') {
      if ((inv.status !== 'open' && inv.status !== 'partial') || !(inv.patientTotal > inv.paidTotal)) continue;
    } else if (f.status && inv.status !== f.status) continue;
    if (f.payerGroupId && inv.payerGroupId !== f.payerGroupId) continue;
    const j = joinInvoice(inv);
    if (!j) continue;
    if (f.payerKind && j.pg.kind !== f.payerKind) continue;
    if (match && !match(inv, j.o, j.pt)) continue;
    hits.push(j);
    if (inv.status !== 'void') {
      subtotal += inv.subtotal;
      patient += inv.patientTotal;
      due += Math.max(inv.patientTotal - inv.paidTotal, 0);
    }
    paid += inv.paidTotal;
  }
  hits.sort((a, b) => b.inv.createdAt.getTime() - a.inv.createdAt.getTime() || b.inv.number.localeCompare(a.inv.number));
  return {
    items: slice(hits, f).map((j) => invoiceOut(j, cur)),
    total: hits.length,
    sums: { subtotal: cents(subtotal), patientTotal: cents(patient), paidTotal: cents(paid), due: cents(due) },
  };
}

/* ================================================================== statements */

/** Payer groups with their use counts (local port of pricing/service.ts listPayerGroups). */
export function listPayerGroups(f: { active?: boolean } = {}): PricingPayerGroup[] {
  return rows('payerGroups')
    .filter((p) => !f.active || p.isActive)
    .map((p) => ({
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
      overrideCount: by('priceOverrides', 'payerGroupId', p.id).length,
      orderCount: by('orders', 'payerGroupId', p.id).length,
    }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** Insurer / client-lab statement: the payer group's invoices in the period with shares and totals. */
export function statement(payerGroupId: string, from?: string, to?: string): FinanceStatement {
  const payer = listPayerGroups().find((p) => p.id === payerGroupId);
  if (!payer) throw notFound();
  const { start, end } = dayRange(from, to);
  const s = start.getTime();
  const e = end.getTime();
  const cur = currency();
  const items = by('invoices', 'payerGroupId', payerGroupId)
    .filter((inv) => inv.status !== 'void' && inv.createdAt.getTime() >= s && inv.createdAt.getTime() < e)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.number.localeCompare(b.number))
    .map(joinInvoice)
    .filter((j): j is InvoiceJoin => !!j)
    .map((j) => invoiceOut(j, cur));
  const totals = items.reduce(
    (a, i) => ({
      count: a.count + 1,
      subtotal: a.subtotal + i.subtotal,
      discountTotal: a.discountTotal + i.discountTotal,
      insurerTotal: a.insurerTotal + i.insurerTotal,
      patientTotal: a.patientTotal + i.patientTotal,
      paidTotal: a.paidTotal + i.paidTotal,
      balance: a.balance + Math.max(0, i.balance),
    }),
    { count: 0, subtotal: 0, discountTotal: 0, insurerTotal: 0, patientTotal: 0, paidTotal: 0, balance: 0 },
  );
  const today = labToday();
  return { payer, from: from ?? to ?? today, to: to ?? from ?? today, invoices: items, totals };
}

/* ================================================================== refunds */

/** Refund money on an invoice: a refund payment row (cash comes out of the user's open session), then the totals. */
export function refund(input: In<typeof FinanceRefundInput>) {
  const { userId } = ctx();
  if (input.idempotencyKey) {
    const existing = by('payments', 'idempotencyKey', input.idempotencyKey)[0];
    if (existing) {
      if (existing.invoiceId !== input.invoiceId || existing.kind !== 'refund') throw conflict('idempotency_conflict', 'This key was used for another payment');
      return { refund: paymentOut(existing), invoice: refreshInvoiceTotals(existing.invoiceId), duplicate: true };
    }
  }
  const inv = find('invoices', input.invoiceId);
  if (!inv) throw notFound('invoice_not_found');
  const current = refreshInvoiceTotals(inv.id);
  const amount = roundMoney(amountOf(input.amount), inv.currency);
  if (!(amount > 0)) throw badRequest('amount_invalid');
  if (amount > current.paidTotal) throw new AppError(400, 'refund_exceeds_paid', `At most ${current.paidTotal} can be refunded`);
  // Like the desk's takePayment in mock mode: an unknown method falls back to the first active one.
  const method = find('paymentMethods', input.methodId) ?? rows('paymentMethods').find((m) => m.isActive);
  if (!method) throw badRequest('payment_method_invalid');
  let cashSessionId: string | null = null;
  if (method.isCash) {
    const session = currentCashSession(userId);
    if (!session) throw conflict('no_cash_session', 'Open a cash session before paying cash out');
    cashSessionId = session.id;
  }
  const reason = input.reason ?? '';
  const row = insert('payments', {
    invoiceId: inv.id,
    cashSessionId,
    methodId: method.id,
    kind: 'refund',
    amount,
    currency: inv.currency,
    note: reason,
    receivedBy: userId,
    receivedAt: now(),
    idempotencyKey: input.idempotencyKey ?? null,
  });
  const totals = refreshInvoiceTotals(inv.id);
  record({
    action: 'finance.refund',
    entityType: 'payment',
    entityId: row.id,
    summary: `${inv.number} · −${amount} ${inv.currency} · ${method.code} · ${reason}`,
    before: { paidTotal: current.paidTotal, status: current.status },
    after: { invoiceId: inv.id, amount, method: method.code, reason, paidTotal: totals.paidTotal, status: totals.status },
  });
  moneyChanged({ invoiceId: inv.id, orderId: inv.orderId, paymentId: row.id });
  return { refund: paymentOut(row), invoice: totals, duplicate: false };
}

/* ================================================================== approvals */

function approvalOut(a: Row<'approvals'>, cur: string): FinanceApproval {
  const requester = userName(a.requestedBy);
  const decider = userName(a.decidedBy);
  const o = a.orderId ? find('orders', a.orderId) : undefined;
  const inv = a.invoiceId ? find('invoices', a.invoiceId) : a.orderId ? by('invoices', 'orderId', a.orderId)[0] : undefined;
  const pt = o ? find('patients', o.patientId) : undefined;
  const net = inv ? cents(inv.subtotal - inv.discountTotal) : null;
  const amount = a.amount ?? null;
  const percent = a.percent ?? null;
  const effective = a.kind === 'free' ? net : (amount ?? (percent !== null && net !== null ? roundMoney((net * percent) / 100, cur) : null));
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    amount,
    percent,
    reason: a.reason,
    requestedAt: a.requestedAt.toISOString(),
    requestedBy: a.requestedBy ?? null,
    requestedByNameAr: requester?.fullNameAr ?? null,
    requestedByNameEn: requester?.fullNameEn ?? null,
    decidedAt: iso(a.decidedAt),
    decidedByNameAr: decider?.fullNameAr ?? null,
    decidedByNameEn: decider?.fullNameEn ?? null,
    decisionNote: a.decisionNote ?? null,
    orderId: a.orderId ?? null,
    accession: o?.accession ?? null,
    invoiceId: inv?.id ?? null,
    invoiceNumber: inv?.number ?? null,
    patientNameAr: pt?.fullNameAr ?? null,
    patientNameEn: pt?.fullNameEn ?? null,
    invoiceSubtotal: inv ? inv.subtotal : null,
    invoiceNet: net,
    effectiveAmount: effective,
  };
}

export function listApprovals(f: { status?: 'pending' | 'approved' | 'rejected'; kind?: string; limit: number; offset: number }) {
  const all = rows('approvals');
  const matched = all.filter((a) => (!f.status || a.status === f.status) && (!f.kind || a.kind === f.kind));
  matched.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.requestedAt.getTime() - a.requestedAt.getTime());
  const cur = currency();
  return {
    items: slice(matched, f).map((a) => approvalOut(a, cur)),
    total: matched.length,
    pending: all.reduce((n, a) => n + (a.status === 'pending' ? 1 : 0), 0),
  };
}

/**
 * Approve or reject a request. An approved discount (or free test) is applied to the invoice
 * with the billing module's applyDiscount; refund and cancel approvals only record the decision
 * (the requester then carries it out). With segregation of duties on, nobody approves their own request.
 */
export function decideApproval(id: string, input: In<typeof FinanceDecideInput>): { id: string; status: 'approved' | 'rejected'; applied: number | null } {
  const { userId } = ctx();
  const a = find('approvals', id);
  if (!a) throw notFound();
  if (a.status !== 'pending') throw conflict('already_decided', 'This request has already been decided');
  const lab = getLab();
  if (lab.settings?.segregationOfDuties !== false && a.requestedBy && a.requestedBy === userId) {
    throw forbidden('own_request', 'With segregation of duties, another person must decide your request');
  }
  const note = optNote(input.note);
  let applied: number | null = null;
  let invoiceId = a.invoiceId;
  if (!invoiceId && a.orderId) invoiceId = by('invoices', 'orderId', a.orderId)[0]?.id ?? null;
  if (input.approve && (a.kind === 'discount' || a.kind === 'free')) {
    if (!invoiceId) throw conflict('invoice_not_found', 'The order has no invoice');
    const inv = find('invoices', invoiceId);
    if (!inv) throw conflict('invoice_not_found', 'The order has no invoice');
    const net = roundMoney(inv.subtotal - inv.discountTotal, inv.currency);
    const amount =
      a.kind === 'free' ? net : a.amount !== null ? a.amount : a.percent !== null ? roundMoney((net * a.percent) / 100, inv.currency) : 0;
    if (amount > 0) applied = applyDiscount(invoiceId, amount, a.kind === 'free' ? `free · ${a.reason}` : a.reason).applied;
  }
  const status = input.approve ? 'approved' : 'rejected';
  const before = { status: a.status };
  update('approvals', a, { status, decidedBy: userId, decidedAt: now(), decisionNote: note });
  record({
    action: input.approve ? 'finance.approval.approved' : 'finance.approval.rejected',
    entityType: 'approval',
    entityId: id,
    summary: `${a.kind}${applied !== null ? ` · −${applied}` : ''}${note ? ` · ${note}` : ''}`,
    before,
    after: { status, note, applied, invoiceId },
  });
  if (a.requestedBy && a.requestedBy !== userId) {
    const accession = a.orderId ? find('orders', a.orderId)?.accession : undefined;
    const body = [accession, note].filter(Boolean).join(' · ') || null;
    notifyUsers([a.requestedBy], {
      kind: 'approval',
      severity: input.approve ? 'info' : 'warning',
      titleAr: input.approve ? 'تمت الموافقة على طلبك' : 'رُفض طلبك',
      titleEn: input.approve ? 'Your request was approved' : 'Your request was rejected',
      bodyAr: body,
      bodyEn: body,
      link: a.orderId ? `/orders/${a.orderId}` : '/finance/approvals',
      entityType: 'approval',
      entityId: id,
    });
  }
  moneyChanged({ approvalId: id, invoiceId, orderId: a.orderId });
  return { id, status, applied };
}

/* ================================================================== expenses */

export function listExpenseCategories(): FinanceExpenseCategory[] {
  return rows('expenseCategories')
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((c) => ({ id: c.id, nameAr: c.nameAr, nameEn: c.nameEn, useCount: by('expenses', 'categoryId', c.id).length }));
}

export function createExpenseCategory(input: In<typeof FinanceExpenseCategoryInput>) {
  const row = insert('expenseCategories', { nameAr: input.nameAr, nameEn: input.nameEn, createdAt: now() });
  record({ action: 'finance.expense_category.created', entityType: 'expense_category', entityId: row.id, summary: row.nameEn, after: input });
  moneyChanged({ kind: 'expense_category' });
  return row;
}

export function updateExpenseCategory(id: string, input: In<typeof FinanceExpenseCategoryInput>) {
  const row = find('expenseCategories', id);
  if (!row) throw notFound();
  const before = { nameAr: row.nameAr, nameEn: row.nameEn };
  update('expenseCategories', row, { nameAr: input.nameAr, nameEn: input.nameEn });
  record({ action: 'finance.expense_category.updated', entityType: 'expense_category', entityId: id, summary: input.nameEn, before, after: input });
  moneyChanged({ kind: 'expense_category' });
  return row;
}

export function deleteExpenseCategory(id: string) {
  const before = find('expenseCategories', id);
  if (!before) throw notFound();
  if (by('expenses', 'categoryId', id).length > 0) throw conflict('in_use', 'Expenses use this category');
  remove('expenseCategories', (c) => c.id === id);
  record({ action: 'finance.expense_category.deleted', entityType: 'expense_category', entityId: id, summary: before.nameEn, before });
  moneyChanged({ kind: 'expense_category' });
  return { ok: true };
}

function expenseOut(e: Row<'expenses'>, cat: Row<'expenseCategories'>): FinanceExpense {
  const by_ = userName(e.createdBy);
  const session = e.cashSessionId ? find('cashSessions', e.cashSessionId) : undefined;
  return {
    id: e.id,
    categoryId: e.categoryId,
    categoryNameAr: cat.nameAr,
    categoryNameEn: cat.nameEn,
    amount: e.amount,
    currency: e.currency,
    paidAt: e.paidAt.toISOString(),
    note: e.note,
    cashSessionId: e.cashSessionId,
    sessionClosed: session?.status === 'closed',
    createdByNameAr: by_?.fullNameAr ?? null,
    createdByNameEn: by_?.fullNameEn ?? null,
  };
}

export function listExpenses(f: { from?: string; to?: string; categoryId?: string; limit: number; offset: number }): FinanceExpenseList {
  const { start, end } = dayRange(f.from, f.to);
  const s = start.getTime();
  const e = end.getTime();
  const hits = rows('expenses').filter((x) => {
    const t = x.paidAt.getTime();
    return t >= s && t < e && (!f.categoryId || x.categoryId === f.categoryId);
  });
  const joined: Array<{ x: Row<'expenses'>; c: Row<'expenseCategories'> }> = [];
  const sums = new Map<string, { categoryId: string; nameAr: string; nameEn: string; amount: number }>();
  for (const x of hits) {
    const c = find('expenseCategories', x.categoryId);
    if (!c) continue;
    joined.push({ x, c });
    const sum = sums.get(c.id);
    if (sum) sum.amount += x.amount;
    else sums.set(c.id, { categoryId: c.id, nameAr: c.nameAr, nameEn: c.nameEn, amount: x.amount });
  }
  joined.sort((a, b) => b.x.paidAt.getTime() - a.x.paidAt.getTime());
  const byCategory = [...sums.values()].map((c) => ({ ...c, amount: cents(c.amount) })).sort((a, b) => b.amount - a.amount);
  return {
    items: slice(joined, f).map(({ x, c }) => expenseOut(x, c)),
    total: hits.length,
    sum: byCategory.reduce((a, c) => a + c.amount, 0),
    byCategory,
  };
}

export function createExpense(input: In<typeof FinanceExpenseInput>): FinanceExpense {
  const { userId } = ctx();
  const cat = find('expenseCategories', input.categoryId);
  if (!cat) throw badRequest('validation', 'Unknown category', { categoryId: ['not_found'] });
  const lab = getLab();
  let cashSessionId: string | null = null;
  if (input.fromDrawer) {
    const session = currentCashSession(userId);
    if (!session) throw conflict('no_cash_session', 'Open a cash session to pay from the drawer');
    cashSessionId = session.id;
  }
  // Any day is taken as typed, also one in the future (the server refuses those).
  const today = labToday(lab.timezone);
  const paidOn = typeof input.paidOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) ? input.paidOn : undefined;
  const paidAt = !paidOn || paidOn === today ? now() : new Date(zonedDayStart(paidOn, lab.timezone).getTime() + 12 * 3_600_000);
  const amount = roundMoney(amountOf(input.amount), lab.currency);
  const note = input.note ?? null;
  const row = insert('expenses', { categoryId: cat.id, amount, currency: lab.currency, paidAt, note, cashSessionId, createdBy: userId, createdAt: now() });
  record({
    action: 'finance.expense.created',
    entityType: 'expense',
    entityId: row.id,
    summary: `${cat.nameEn} · ${amount} ${lab.currency}${cashSessionId ? ' · drawer' : ''}`,
    after: { categoryId: cat.id, amount, paidAt, note, cashSessionId },
  });
  moneyChanged({ expenseId: row.id, cashSessionId });
  return expenseOut(row, cat);
}

export function deleteExpense(id: string) {
  const e = find('expenses', id);
  if (!e) throw notFound();
  if (e.cashSessionId && find('cashSessions', e.cashSessionId)?.status === 'closed') {
    throw conflict('session_closed', 'The expense belongs to a closed cash session');
  }
  remove('expenses', (x) => x.id === id);
  record({ action: 'finance.expense.deleted', entityType: 'expense', entityId: id, summary: `${e.amount} ${e.currency}`, before: e });
  moneyChanged({ expenseId: id });
  return { ok: true };
}

/* ================================================================== summary */

/** Billed, collected, outstanding, discounts, insurer receivables, expenses and net cash for a period. */
export function summary(from?: string, to?: string): FinanceSummary {
  const lab = getLab();
  const clock = labClock(lab.timezone);
  const { start, end } = dayRange(from, to);
  const s = start.getTime();
  const e = end.getTime();
  const inRange = (d: Date) => d.getTime() >= s && d.getTime() < e;
  const days = new Map<string, { net: number; collected: number; expenses: number }>();
  const day = (d: Date) => {
    const key = clock.day(d);
    let v = days.get(key);
    if (!v) days.set(key, (v = { net: 0, collected: 0, expenses: 0 }));
    return v;
  };

  let invoices = 0;
  let billed = 0;
  let discounts = 0;
  let outstanding = 0;
  let insurer = 0;
  for (const inv of rows('invoices')) {
    if (inv.status === 'void' || !inRange(inv.createdAt)) continue;
    day(inv.createdAt).net += inv.subtotal - inv.discountTotal;
    const pg = find('payerGroups', inv.payerGroupId);
    if (!pg) continue;
    invoices += 1;
    billed += inv.subtotal;
    discounts += inv.discountTotal;
    outstanding += Math.max(inv.patientTotal - inv.paidTotal, 0);
    if (pg.onAccount) insurer += inv.insurerTotal;
  }

  let paid = 0;
  let refunds = 0;
  const inPeriod: PaymentRow[] = [];
  for (const p of rows('payments')) {
    if (!inRange(p.receivedAt)) continue;
    inPeriod.push(p);
    if (p.kind === 'payment') paid += p.amount;
    else refunds += p.amount;
    day(p.receivedAt).collected += p.kind === 'payment' ? p.amount : -p.amount;
  }

  let spent = 0;
  for (const x of rows('expenses')) {
    if (!inRange(x.paidAt)) continue;
    spent += x.amount;
    day(x.paidAt).expenses += x.amount;
  }

  const collected = cents(paid) - cents(refunds);
  const expensesTotal = cents(spent);
  const today = labToday(lab.timezone);
  const f = from ?? to ?? today;
  const t = to ?? from ?? today;
  return {
    from: f,
    to: t,
    billed: cents(billed),
    discounts: cents(discounts),
    net: cents(billed) - cents(discounts),
    collected,
    refunds: cents(refunds),
    outstanding: cents(outstanding),
    insurerReceivables: cents(insurer),
    expenses: expensesTotal,
    netCash: collected - expensesTotal,
    invoices,
    byMethod: methodTotals(inPeriod),
    byDay: fillDays(
      f,
      t,
      [...days].map(([date, d]) => ({ date, net: cents(d.net), collected: cents(d.collected), expenses: cents(d.expenses) })),
      (date) => ({ date, net: 0, collected: 0, expenses: 0 }),
    ),
  };
}

/* ================================================================== routes */

const uuid = z.string().uuid();
const statementQuery = z.object({ payerGroupId: uuid, from: isoDate.optional(), to: isoDate.optional() });

/** Back office money: cash sessions, payments, invoices, statements, refunds, approvals, expenses, summary. */
export function registerFinanceRoutes(): void {
  const read = { perm: 'finance.read' };
  const cashier = { perm: ['finance.cash', 'finance.payment'] };
  const expensesPerm = { perm: 'finance.expenses' };
  const expenseRead = { perm: ['finance.expenses', 'finance.read'] };
  const body = (req: { body: unknown }) => (req.body ?? {}) as Record<string, unknown>;

  /* cash sessions */

  route('GET', '/finance/cash-sessions/current', cashier, () => currentSession());

  route('POST', '/finance/cash-sessions', cashier, (req) => {
    const input = parse(FinanceOpenSessionInput, req.body);
    return openSession({ ...input, openingFloat: amountOf(input.openingFloat, body(req).openingFloat), branchId: input.branchId ?? null });
  });

  route('POST', '/finance/cash-sessions/:id/close', cashier, (req) => {
    const input = parse(FinanceCloseSessionInput, req.body);
    return closeSession(
      req.params.id!,
      { countedCash: amountOf(input.countedCash, body(req).countedCash), note: optNote(input.note ?? body(req).note) },
      { canSupervise: req.auth!.permissions.has('finance.approve') },
    );
  });

  route('GET', '/finance/cash-sessions', read, (req) =>
    listSessions(parse(adminListQuery.extend({ status: z.enum(['open', 'closed']).optional(), userId: uuid.optional() }), req.query)),
  );

  route('GET', '/finance/cash-sessions/:id', { perm: ['finance.read', 'finance.cash', 'finance.payment'] }, (req) =>
    getSession(req.params.id!, { canReadAll: req.auth!.permissions.has('finance.read') }),
  );

  /* payments & invoices */

  route('GET', '/finance/payments', read, (req) => {
    const q = parse(
      adminListQuery.extend({
        methodId: uuid.optional(),
        kind: z.enum(['payment', 'refund']).optional(),
        userId: uuid.optional(),
        sessionId: uuid.optional(),
        mine: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    return listPayments({ ...q, userId: q.mine === 'true' ? req.auth!.userId : q.userId });
  });

  route('GET', '/finance/invoices', read, (req) =>
    listInvoices(
      parse(
        adminListQuery.extend({
          status: z.enum(['open', 'partial', 'paid', 'void', 'due']).optional(),
          payerGroupId: uuid.optional(),
          payerKind: z.enum(['public', 'insurer', 'client_lab', 'other']).optional(),
        }),
        req.query,
      ),
    ),
  );

  /* statements */

  route('GET', '/finance/statements', read, (req) => {
    const q = parse(statementQuery, req.query);
    return statement(q.payerGroupId, q.from, q.to);
  });

  route('GET', '/finance/statements/export', read, (req) => {
    const q = parse(statementQuery.extend({ lang: z.enum(['ar', 'en']).default('ar') }), req.query);
    const st = statement(q.payerGroupId, q.from, q.to);
    const lab = getLab();
    const lang = q.lang === 'en' ? 'en' : 'ar';
    const nm = (ar: string | null, en: string | null) => (lang === 'ar' ? ar || en : en || ar) ?? '';
    return buildWorkbook(
      [
        {
          name: L(lang, 'Statement', 'كشف حساب'),
          title: `${nm(lab.nameAr, lab.nameEn)} · ${L(lang, 'Statement of account', 'كشف حساب')} · ${nm(st.payer.nameAr, st.payer.nameEn)}`,
          subtitle: `${st.payer.organization ? `${st.payer.organization} · ` : ''}${st.from} → ${st.to}`,
          columns: [
            { header: L(lang, 'Date', 'التاريخ'), key: 'createdAt', format: 'date', width: 12 },
            { header: L(lang, 'Invoice', 'الفاتورة'), key: 'number', width: 18 },
            { header: L(lang, 'Order', 'الطلب'), key: 'accession', width: 14 },
            { header: L(lang, 'Patient', 'المريض'), key: 'patient', width: 30 },
            { header: L(lang, 'File no.', 'رقم الملف'), key: 'mrn', width: 12 },
            { header: L(lang, 'Gross', 'الإجمالي'), key: 'subtotal', format: 'money', width: 14 },
            { header: L(lang, 'Discount', 'الحسم'), key: 'discountTotal', format: 'money', width: 12 },
            { header: L(lang, 'Patient share', 'حصة المريض'), key: 'patientTotal', format: 'money', width: 14 },
            { header: L(lang, 'Payer share', 'حصة الجهة'), key: 'insurerTotal', format: 'money', width: 14 },
            { header: L(lang, 'Paid by patient', 'مدفوع من المريض'), key: 'paidTotal', format: 'money', width: 14 },
          ],
          rows: st.invoices.map((i) => ({ ...i, patient: nm(i.patientNameAr, i.patientNameEn) })),
          totals: { createdAt: null, number: L(lang, 'Total', 'المجموع'), ...st.totals, patient: `${st.totals.count}` },
        },
      ],
      `natija-statement-${st.payer.code}-${st.from}_${st.to}.xlsx`,
      { timeZone: lab.timezone },
    );
  });

  /* refunds & approvals */

  route('POST', '/finance/refunds', { perm: 'finance.refund' }, (req) => {
    const input = parse(FinanceRefundInput, req.body);
    return refund({
      ...input,
      amount: amountOf(input.amount, body(req).amount),
      reason: textOf(input.reason, body(req).reason),
      idempotencyKey: typeof input.idempotencyKey === 'string' && input.idempotencyKey ? input.idempotencyKey : undefined,
    });
  });

  route('GET', '/finance/approvals', { perm: ['finance.approve', 'finance.read'] }, (req) =>
    listApprovals(
      parse(
        adminListQuery.extend({
          status: z.enum(['pending', 'approved', 'rejected']).optional(),
          kind: z.enum(['discount', 'free', 'refund', 'cancel']).optional(),
        }),
        req.query,
      ),
    ),
  );

  route('POST', '/finance/approvals/:id/decide', { perm: 'finance.approve' }, (req) => {
    const input = parse(FinanceDecideInput, req.body);
    return decideApproval(req.params.id!, { approve: input.approve === true, note: optNote(input.note ?? body(req).note) });
  });

  /* expenses */

  const categoryInput = (req: { body: unknown }) => {
    const input = parse(FinanceExpenseCategoryInput, req.body);
    const nameAr = textOf(input.nameAr, body(req).nameAr);
    const nameEn = textOf(input.nameEn, body(req).nameEn);
    return { nameAr: nameAr || nameEn, nameEn: nameEn || nameAr };
  };

  route('GET', '/finance/expense-categories', expenseRead, () => listExpenseCategories());
  route('POST', '/finance/expense-categories', expensesPerm, (req) => createExpenseCategory(categoryInput(req)));
  route('PUT', '/finance/expense-categories/:id', expensesPerm, (req) => updateExpenseCategory(req.params.id!, categoryInput(req)));
  route('DELETE', '/finance/expense-categories/:id', expensesPerm, (req) => deleteExpenseCategory(req.params.id!));

  route('GET', '/finance/expenses', expenseRead, (req) => listExpenses(parse(adminListQuery.extend({ categoryId: uuid.optional() }), req.query)));
  route('POST', '/finance/expenses', expensesPerm, (req) => {
    const input = parse(FinanceExpenseInput, req.body);
    return createExpense({
      ...input,
      amount: amountOf(input.amount, body(req).amount),
      note: optNote(input.note ?? body(req).note),
      fromDrawer: input.fromDrawer === true,
    });
  });
  route('DELETE', '/finance/expenses/:id', expensesPerm, (req) => deleteExpense(req.params.id!));

  /* summary */

  route('GET', '/finance/summary', read, (req) => {
    const q = parse(adminRangeQuery, req.query);
    return summary(q.from, q.to);
  });
}

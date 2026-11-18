/**
 * Finance back office: cash sessions, payments and invoices lists, insurer / client-lab
 * statements, refunds, discount approvals, expenses and the money summary.
 * Desk payments and discounts themselves live in the billing module (front desk); this module
 * reuses its refreshInvoiceTotals, applyDiscount and currentCashSession.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  approvals,
  branches,
  cashSessions,
  expenseCategories,
  expenses,
  invoices,
  orders,
  patients,
  payerGroups,
  paymentMethods,
  payments,
  users,
} from '@natija/db';
import { normalizeText, roundMoney } from '@natija/domain';
import type {
  FinanceApproval,
  FinanceCashSession,
  FinanceCashTotals,
  FinanceCloseSessionInput,
  FinanceDecideInput,
  FinanceExpense,
  FinanceExpenseCategory,
  FinanceExpenseCategoryInput,
  FinanceExpenseInput,
  FinanceExpenseList,
  FinanceInvoice,
  FinanceMethodTotal,
  FinanceOpenSessionInput,
  FinancePayment,
  FinanceRefundInput,
  FinanceStatement,
  FinanceSummary,
} from '@natija/contracts';
import { ctx, db } from '../../db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange, zonedDayStart } from '../../lib/http';
import { getLab } from '../../lib/lab';
import { notifyPermission, notifyUsers } from '../../lib/notify';
import { applyDiscount, currentCashSession, refreshInvoiceTotals } from '../billing/service';
import { countRows, num, record, rowsOf, inSequence } from '../audit/kit';
import { listPayerGroups } from '../pricing/service';

type In<T extends z.ZodTypeAny> = z.output<T>;
const moneyChanged = (data: Record<string, unknown>) => publish({ type: 'finance.changed', data });
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function currency(): Promise<string> {
  return (await getLab(ctx().labId)).currency;
}

/* ================================================================== cash sessions */

type SessionRow = typeof cashSessions.$inferSelect;

/** Payments and refunds of a session: linked to it, or taken by its owner during it without a link (non-cash). */
function sessionPaymentsWhere(s: SessionRow): SQL {
  const window = and(
    isNull(payments.cashSessionId),
    eq(payments.receivedBy, s.openedBy),
    gte(payments.receivedAt, s.openedAt),
    s.closedAt ? lt(payments.receivedAt, s.closedAt) : undefined,
  );
  return or(eq(payments.cashSessionId, s.id), window)!;
}

async function methodTotals(where: SQL): Promise<FinanceMethodTotal[]> {
  const rows = await db()
    .select({
      methodId: paymentMethods.id,
      code: paymentMethods.code,
      nameAr: paymentMethods.nameAr,
      nameEn: paymentMethods.nameEn,
      isCash: paymentMethods.isCash,
      sort: paymentMethods.sortOrder,
      payments: sql<string>`coalesce(sum(${payments.amount}) filter (where ${payments.kind} = 'payment'), 0)`,
      refunds: sql<string>`coalesce(sum(${payments.amount}) filter (where ${payments.kind} = 'refund'), 0)`,
      count: sql<number>`(count(*) filter (where ${payments.kind} = 'payment'))::int`,
    })
    .from(payments)
    .innerJoin(paymentMethods, eq(paymentMethods.id, payments.methodId))
    .where(where)
    .groupBy(paymentMethods.id)
    .orderBy(asc(paymentMethods.sortOrder));
  return rows.map(({ sort, ...r }) => {
    void sort;
    const p = num(r.payments);
    const rf = num(r.refunds);
    return { ...r, payments: p, refunds: rf, net: p - rf };
  });
}

async function sessionTotals(s: SessionRow): Promise<FinanceCashTotals> {
  const cur = await currency();
  const byMethod = await methodTotals(sessionPaymentsWhere(s));
  const cash = byMethod.filter((m) => m.isCash);
  const cashPayments = cash.reduce((a, m) => a + m.payments, 0);
  const cashRefunds = cash.reduce((a, m) => a + m.refunds, 0);
  const [exp] = await db()
    .select({ total: sql<string>`coalesce(sum(${expenses.amount}), 0)` })
    .from(expenses)
    .where(eq(expenses.cashSessionId, s.id));
  const cashExpenses = num(exp?.total);
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

async function sessionOut(s: SessionRow): Promise<FinanceCashSession> {
  const names = await userNames([s.openedBy, s.closedBy]);
  const o = names.get(s.openedBy);
  const c = s.closedBy ? names.get(s.closedBy) : undefined;
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
    totals: await sessionTotals(s),
  };
}

async function userNames(ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, { fullNameAr: string; fullNameEn: string }>();
  const rows = await db().select({ id: users.id, fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function currentSession(): Promise<{ session: FinanceCashSession | null }> {
  const open = await currentCashSession(ctx().userId);
  if (!open) return { session: null };
  const [s] = await db().select().from(cashSessions).where(eq(cashSessions.id, open.id));
  return { session: s ? await sessionOut(s) : null };
}

export async function getSession(id: string, opts: { canReadAll: boolean }): Promise<FinanceCashSession> {
  const [s] = await db().select().from(cashSessions).where(eq(cashSessions.id, id));
  if (!s) throw notFound();
  if (!opts.canReadAll && s.openedBy !== ctx().userId) throw notFound();
  return sessionOut(s);
}

export async function openSession(input: In<typeof FinanceOpenSessionInput>): Promise<FinanceCashSession> {
  const { labId, userId, tx } = ctx();
  if (!userId) throw forbidden();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cash:${labId}:${userId}`}))`);
  if (await currentCashSession(userId)) throw conflict('session_already_open', 'You already have an open cash session');
  if (input.branchId) {
    const [b] = await db().select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
    if (!b) throw badRequest('validation', 'Unknown branch', { branchId: ['not_found'] });
  }
  const cur = await currency();
  const [row] = await db()
    .insert(cashSessions)
    .values({ labId, openedBy: userId, branchId: input.branchId, openingFloat: roundMoney(input.openingFloat, cur), status: 'open' })
    .returning();
  await record({
    action: 'finance.cash_session.opened',
    entityType: 'cash_session',
    entityId: row!.id,
    summary: `float ${row!.openingFloat} ${cur}`,
    after: { openingFloat: row!.openingFloat, branchId: row!.branchId },
  });
  moneyChanged({ cashSessionId: row!.id });
  return sessionOut(row!);
}

/**
 * Close a cash session: expected cash = opening float + cash payments − cash refunds − cash
 * expenses of the session; difference = counted − expected. Supervisors (finance.approve) may
 * close someone else's session.
 */
export async function closeSession(id: string, input: In<typeof FinanceCloseSessionInput>, opts: { canSupervise: boolean }): Promise<FinanceCashSession> {
  const [s] = await db().select().from(cashSessions).where(eq(cashSessions.id, id)).for('update');
  if (!s) throw notFound();
  if (s.openedBy !== ctx().userId && !opts.canSupervise) throw forbidden('not_your_session', 'Only the cashier or a supervisor can close this session');
  if (s.status !== 'open') throw conflict('session_closed', 'The session is already closed');
  const cur = await currency();
  const totals = await sessionTotals(s);
  const countedCash = roundMoney(input.countedCash, cur);
  const difference = roundMoney(countedCash - totals.expectedCash, cur);
  const [row] = await db()
    .update(cashSessions)
    .set({ status: 'closed', closedBy: ctx().userId, closedAt: new Date(), countedCash, expectedCash: totals.expectedCash, difference, note: input.note })
    .where(eq(cashSessions.id, id))
    .returning();
  await record({
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
      note: input.note,
    },
  });
  if (difference !== 0) {
    const names = await userNames([s.openedBy]);
    const who = names.get(s.openedBy);
    await notifyPermission('finance.approve', {
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
  return sessionOut(row!);
}

export async function listSessions(f: { from?: string; to?: string; status?: 'open' | 'closed'; userId?: string; limit: number; offset: number }) {
  const where: SQL[] = [];
  if (f.from || f.to) {
    const { start, end } = await dayRange(f.from, f.to);
    where.push(gte(cashSessions.openedAt, start), lt(cashSessions.openedAt, end));
  }
  if (f.status) where.push(eq(cashSessions.status, f.status));
  if (f.userId) where.push(eq(cashSessions.openedBy, f.userId));
  const cond = where.length ? and(...where) : undefined;
  const [rows, total] = await inSequence([
    () => db().select().from(cashSessions).where(cond).orderBy(desc(cashSessions.openedAt)).limit(f.limit).offset(f.offset),
    () => countRows(cashSessions, cond),
  ]);
  const items: FinanceCashSession[] = [];
  for (const s of rows) items.push(await sessionOut(s));
  return { items, total };
}

/* ================================================================== payments */

const paymentColumns = {
  id: payments.id,
  kind: payments.kind,
  amount: payments.amount,
  currency: payments.currency,
  methodId: payments.methodId,
  methodNameAr: paymentMethods.nameAr,
  methodNameEn: paymentMethods.nameEn,
  isCash: paymentMethods.isCash,
  reference: payments.reference,
  note: payments.note,
  receivedAt: payments.receivedAt,
  receivedByNameAr: users.fullNameAr,
  receivedByNameEn: users.fullNameEn,
  cashSessionId: payments.cashSessionId,
  invoiceId: payments.invoiceId,
  invoiceNumber: invoices.number,
  orderId: orders.id,
  accession: orders.accession,
  patientNameAr: patients.fullNameAr,
  patientNameEn: patients.fullNameEn,
};

function paymentsQuery(where: SQL | undefined) {
  return db()
    .select(paymentColumns)
    .from(payments)
    .innerJoin(paymentMethods, eq(paymentMethods.id, payments.methodId))
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .innerJoin(orders, eq(orders.id, invoices.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .leftJoin(users, eq(users.id, payments.receivedBy))
    .where(where);
}

const paymentOut = (r: Awaited<ReturnType<typeof paymentsQuery>>[number]): FinancePayment => ({ ...r, receivedAt: r.receivedAt.toISOString() });

export async function listPayments(f: {
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
  const { start, end } = await dayRange(f.from, f.to);
  const where: SQL[] = [gte(payments.receivedAt, start), lt(payments.receivedAt, end)];
  if (f.methodId) where.push(eq(payments.methodId, f.methodId));
  if (f.kind) where.push(eq(payments.kind, f.kind));
  if (f.userId) where.push(eq(payments.receivedBy, f.userId));
  if (f.sessionId) where.push(eq(payments.cashSessionId, f.sessionId));
  if (f.q) where.push(searchInvoices(f.q));
  const cond = and(...where);
  const [rows, [total], byMethod] = await inSequence([
    () => paymentsQuery(cond).orderBy(desc(payments.receivedAt)).limit(f.limit).offset(f.offset),
    () => db()
      .select({ n: count() })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(orders, eq(orders.id, invoices.orderId))
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .where(cond),
    () => methodTotals(
      and(
        gte(payments.receivedAt, start),
        lt(payments.receivedAt, end),
        f.userId ? eq(payments.receivedBy, f.userId) : undefined,
        f.sessionId ? eq(payments.cashSessionId, f.sessionId) : undefined,
      )!,
    ),
  ]);
  return { items: rows.map(paymentOut), total: total?.n ?? 0, byMethod };
}

/* ================================================================== invoices */

function searchInvoices(q: string): SQL {
  const raw = q.trim().replace(/[%_]/g, '');
  const norm = normalizeText(q).replace(/[%_]/g, '');
  return or(
    ilike(invoices.number, `%${raw}%`),
    ilike(orders.accession, `${raw}%`),
    ilike(patients.mrn, `${raw}%`),
    norm ? ilike(patients.searchText, `%${norm}%`) : undefined,
  )!;
}

const invoiceColumns = {
  id: invoices.id,
  number: invoices.number,
  orderId: invoices.orderId,
  accession: orders.accession,
  patientId: patients.id,
  patientNameAr: patients.fullNameAr,
  patientNameEn: patients.fullNameEn,
  mrn: patients.mrn,
  payerGroupId: invoices.payerGroupId,
  payerNameAr: payerGroups.nameAr,
  payerNameEn: payerGroups.nameEn,
  payerKind: payerGroups.kind,
  currency: invoices.currency,
  subtotal: invoices.subtotal,
  discountTotal: invoices.discountTotal,
  insurerTotal: invoices.insurerTotal,
  patientTotal: invoices.patientTotal,
  paidTotal: invoices.paidTotal,
  status: invoices.status,
  createdAt: invoices.createdAt,
};

function invoicesQuery(where: SQL | undefined) {
  return db()
    .select(invoiceColumns)
    .from(invoices)
    .innerJoin(orders, eq(orders.id, invoices.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(payerGroups, eq(payerGroups.id, invoices.payerGroupId))
    .where(where);
}

function invoiceOut(r: Awaited<ReturnType<typeof invoicesQuery>>[number], cur: string): FinanceInvoice {
  const balance = r.status === 'void' ? roundMoney(-r.paidTotal, cur) : roundMoney(r.patientTotal - r.paidTotal, cur);
  return { ...r, balance, createdAt: r.createdAt.toISOString() };
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

export async function listInvoices(f: InvoiceFilters) {
  const where: SQL[] = [];
  if (f.from || f.to) {
    const { start, end } = await dayRange(f.from, f.to);
    where.push(gte(invoices.createdAt, start), lt(invoices.createdAt, end));
  }
  if (f.status === 'due') where.push(inArray(invoices.status, ['open', 'partial']), sql`${invoices.patientTotal} > ${invoices.paidTotal}`);
  else if (f.status) where.push(eq(invoices.status, f.status));
  if (f.payerGroupId) where.push(eq(invoices.payerGroupId, f.payerGroupId));
  if (f.payerKind) where.push(eq(payerGroups.kind, f.payerKind as 'public'));
  if (f.q) where.push(searchInvoices(f.q));
  const cond = where.length ? and(...where) : undefined;
  const cur = await currency();
  const [rows, [agg]] = await inSequence([
    () => invoicesQuery(cond).orderBy(desc(invoices.createdAt)).limit(f.limit).offset(f.offset),
    () => db()
      .select({
        n: count(),
        subtotal: sql<string>`coalesce(sum(${invoices.subtotal}) filter (where ${invoices.status} <> 'void'), 0)`,
        patient: sql<string>`coalesce(sum(${invoices.patientTotal}) filter (where ${invoices.status} <> 'void'), 0)`,
        paid: sql<string>`coalesce(sum(${invoices.paidTotal}), 0)`,
        due: sql<string>`coalesce(sum(greatest(${invoices.patientTotal} - ${invoices.paidTotal}, 0)) filter (where ${invoices.status} <> 'void'), 0)`,
      })
      .from(invoices)
      .innerJoin(orders, eq(orders.id, invoices.orderId))
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .innerJoin(payerGroups, eq(payerGroups.id, invoices.payerGroupId))
      .where(cond),
  ]);
  return {
    items: rows.map((r) => invoiceOut(r, cur)),
    total: agg?.n ?? 0,
    sums: { subtotal: num(agg?.subtotal), patientTotal: num(agg?.patient), paidTotal: num(agg?.paid), due: num(agg?.due) },
  };
}

/* ================================================================== statements */

/** Insurer / client-lab statement: the payer group's invoices in the period with shares and totals. */
export async function statement(payerGroupId: string, from?: string, to?: string): Promise<FinanceStatement> {
  const payer = (await listPayerGroups()).find((p) => p.id === payerGroupId);
  if (!payer) throw notFound();
  const { start, end } = await dayRange(from, to);
  const cur = await currency();
  const rows = await invoicesQuery(
    and(eq(invoices.payerGroupId, payerGroupId), gte(invoices.createdAt, start), lt(invoices.createdAt, end), sql`${invoices.status} <> 'void'`),
  ).orderBy(asc(invoices.createdAt));
  const items = rows.map((r) => invoiceOut(r, cur));
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
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: (await getLab(ctx().labId)).timezone }).format(new Date());
  return { payer, from: from ?? to ?? today, to: to ?? from ?? today, invoices: items, totals };
}

/* ================================================================== refunds */

/** Refund money on an invoice: a refund payment row (cash comes out of the user's open session), then the totals. */
export async function refund(input: In<typeof FinanceRefundInput>) {
  const { labId, userId, tx } = ctx();
  if (input.idempotencyKey) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payment:${labId}:${input.idempotencyKey}`}))`);
    const [existing] = await db().select().from(payments).where(eq(payments.idempotencyKey, input.idempotencyKey));
    if (existing) {
      if (existing.invoiceId !== input.invoiceId || existing.kind !== 'refund') throw conflict('idempotency_conflict', 'This key was used for another payment');
      const [row] = await paymentsQuery(eq(payments.id, existing.id));
      return { refund: paymentOut(row!), invoice: await refreshInvoiceTotals(existing.invoiceId), duplicate: true };
    }
  }
  const [inv] = await db().select().from(invoices).where(eq(invoices.id, input.invoiceId)).for('update');
  if (!inv) throw notFound('invoice_not_found');
  const current = await refreshInvoiceTotals(inv.id);
  const amount = roundMoney(input.amount, inv.currency);
  if (!(amount > 0)) throw badRequest('amount_invalid');
  if (amount > current.paidTotal) throw new AppError(400, 'refund_exceeds_paid', `At most ${current.paidTotal} can be refunded`);
  const [method] = await db().select().from(paymentMethods).where(eq(paymentMethods.id, input.methodId));
  if (!method || !method.isActive) throw badRequest('payment_method_invalid');
  let cashSessionId: string | null = null;
  if (method.isCash) {
    const session = await currentCashSession(userId);
    if (!session) throw conflict('no_cash_session', 'Open a cash session before paying cash out');
    cashSessionId = session.id;
  }
  const [row] = await db()
    .insert(payments)
    .values({
      labId,
      invoiceId: inv.id,
      cashSessionId,
      methodId: method.id,
      kind: 'refund',
      amount,
      currency: inv.currency,
      note: input.reason,
      receivedBy: userId,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .returning();
  const totals = await refreshInvoiceTotals(inv.id);
  await record({
    action: 'finance.refund',
    entityType: 'payment',
    entityId: row!.id,
    summary: `${inv.number} · −${amount} ${inv.currency} · ${method.code} · ${input.reason}`,
    before: { paidTotal: current.paidTotal, status: current.status },
    after: { invoiceId: inv.id, amount, method: method.code, reason: input.reason, paidTotal: totals.paidTotal, status: totals.status },
  });
  moneyChanged({ invoiceId: inv.id, orderId: inv.orderId, paymentId: row!.id });
  const [out] = await paymentsQuery(eq(payments.id, row!.id));
  return { refund: paymentOut(out!), invoice: totals, duplicate: false };
}

/* ================================================================== approvals */

export async function listApprovals(f: { status?: 'pending' | 'approved' | 'rejected'; kind?: string; limit: number; offset: number }) {
  const where: SQL[] = [];
  if (f.status) where.push(eq(approvals.status, f.status));
  if (f.kind) where.push(eq(approvals.kind, f.kind as 'discount'));
  const cond = where.length ? and(...where) : undefined;
  const raw: SQL[] = [sql`true`];
  if (f.status) raw.push(sql`a.status = ${f.status}`);
  if (f.kind) raw.push(sql`a.kind = ${f.kind}`);
  const rows = await rowsOf<Record<string, unknown>>(sql`
    select a.id, a.kind, a.status, a.amount, a.percent, a.reason, a.requested_at, a.requested_by, a.decided_at, a.decision_note,
      a.order_id, a.invoice_id,
      ru.full_name_ar as req_ar, ru.full_name_en as req_en, du.full_name_ar as dec_ar, du.full_name_en as dec_en,
      o.accession, coalesce(i.number, i2.number) as invoice_number, coalesce(i.id, i2.id) as resolved_invoice_id,
      p.full_name_ar as patient_ar, p.full_name_en as patient_en,
      coalesce(i.subtotal, i2.subtotal) as subtotal, coalesce(i.subtotal - i.discount_total, i2.subtotal - i2.discount_total) as net
    from approvals a
    left join users ru on ru.id = a.requested_by
    left join users du on du.id = a.decided_by
    left join orders o on o.id = a.order_id
    left join invoices i on i.id = a.invoice_id
    left join invoices i2 on a.invoice_id is null and i2.order_id = a.order_id
    left join patients p on p.id = o.patient_id
    where ${sql.join(raw, sql` and `)}
    order by (a.status = 'pending') desc, a.requested_at desc
    limit ${f.limit} offset ${f.offset}`);
  const total = await countRows(approvals, cond);
  const cur = await currency();
  const pending = await countRows(approvals, eq(approvals.status, 'pending'));
  const items: FinanceApproval[] = rows.map((r) => {
    const net = r.net === null || r.net === undefined ? null : num(r.net);
    const amount = r.amount === null || r.amount === undefined ? null : num(r.amount);
    const percent = r.percent === null || r.percent === undefined ? null : num(r.percent);
    const effective = r.kind === 'free' ? net : amount ?? (percent !== null && net !== null ? roundMoney((net * percent) / 100, cur) : null);
    return {
      id: r.id as string,
      kind: r.kind as FinanceApproval['kind'],
      status: r.status as FinanceApproval['status'],
      amount,
      percent,
      reason: r.reason as string,
      requestedAt: new Date(r.requested_at as string).toISOString(),
      requestedBy: (r.requested_by as string | null) ?? null,
      requestedByNameAr: (r.req_ar as string | null) ?? null,
      requestedByNameEn: (r.req_en as string | null) ?? null,
      decidedAt: r.decided_at ? new Date(r.decided_at as string).toISOString() : null,
      decidedByNameAr: (r.dec_ar as string | null) ?? null,
      decidedByNameEn: (r.dec_en as string | null) ?? null,
      decisionNote: (r.decision_note as string | null) ?? null,
      orderId: (r.order_id as string | null) ?? null,
      accession: (r.accession as string | null) ?? null,
      invoiceId: (r.resolved_invoice_id as string | null) ?? null,
      invoiceNumber: (r.invoice_number as string | null) ?? null,
      patientNameAr: (r.patient_ar as string | null) ?? null,
      patientNameEn: (r.patient_en as string | null) ?? null,
      invoiceSubtotal: r.subtotal === null || r.subtotal === undefined ? null : num(r.subtotal),
      invoiceNet: net,
      effectiveAmount: effective,
    };
  });
  return { items, total, pending };
}

/**
 * Approve or reject a request. An approved discount (or free test) is applied to the invoice
 * with the billing module's applyDiscount; refund and cancel approvals only record the decision
 * (the requester then carries it out). With segregation of duties on, nobody approves their own request.
 */
export async function decideApproval(id: string, input: In<typeof FinanceDecideInput>) {
  const { userId } = ctx();
  const [a] = await db().select().from(approvals).where(eq(approvals.id, id)).for('update');
  if (!a) throw notFound();
  if (a.status !== 'pending') throw conflict('already_decided', 'This request has already been decided');
  const lab = await getLab(ctx().labId);
  if (lab.settings?.segregationOfDuties !== false && a.requestedBy && a.requestedBy === userId) {
    throw forbidden('own_request', 'With segregation of duties, another person must decide your request');
  }
  let applied: number | null = null;
  let invoiceId = a.invoiceId;
  if (!invoiceId && a.orderId) {
    const [inv] = await db().select({ id: invoices.id }).from(invoices).where(eq(invoices.orderId, a.orderId));
    invoiceId = inv?.id ?? null;
  }
  if (input.approve && (a.kind === 'discount' || a.kind === 'free')) {
    if (!invoiceId) throw conflict('invoice_not_found', 'The order has no invoice');
    const [inv] = await db().select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!inv) throw conflict('invoice_not_found', 'The order has no invoice');
    const net = roundMoney(inv.subtotal - inv.discountTotal, inv.currency);
    const amount =
      a.kind === 'free' ? net : a.amount !== null ? a.amount : a.percent !== null ? roundMoney((net * a.percent) / 100, inv.currency) : 0;
    if (amount > 0) applied = (await applyDiscount(invoiceId, amount, a.kind === 'free' ? `free · ${a.reason}` : a.reason)).applied;
  }
  const status = input.approve ? 'approved' : 'rejected';
  await db().update(approvals).set({ status, decidedBy: userId, decidedAt: new Date(), decisionNote: input.note }).where(eq(approvals.id, id));
  await record({
    action: input.approve ? 'finance.approval.approved' : 'finance.approval.rejected',
    entityType: 'approval',
    entityId: id,
    summary: `${a.kind}${applied !== null ? ` · −${applied}` : ''}${input.note ? ` · ${input.note}` : ''}`,
    before: { status: a.status },
    after: { status, note: input.note, applied, invoiceId },
  });
  if (a.requestedBy && a.requestedBy !== userId) {
    const [o] = a.orderId ? await db().select({ accession: orders.accession }).from(orders).where(eq(orders.id, a.orderId)) : [];
    await notifyUsers([a.requestedBy], {
      kind: 'approval',
      severity: input.approve ? 'info' : 'warning',
      titleAr: input.approve ? 'تمت الموافقة على طلبك' : 'رُفض طلبك',
      titleEn: input.approve ? 'Your request was approved' : 'Your request was rejected',
      bodyAr: [o?.accession, input.note].filter(Boolean).join(' · ') || null,
      bodyEn: [o?.accession, input.note].filter(Boolean).join(' · ') || null,
      link: a.orderId ? `/orders/${a.orderId}` : '/finance/approvals',
      entityType: 'approval',
      entityId: id,
    });
  }
  moneyChanged({ approvalId: id, invoiceId, orderId: a.orderId });
  return { id, status, applied };
}

/* ================================================================== expenses */

export async function listExpenseCategories(): Promise<FinanceExpenseCategory[]> {
  return db()
    .select({
      id: expenseCategories.id,
      nameAr: expenseCategories.nameAr,
      nameEn: expenseCategories.nameEn,
      useCount: sql<number>`(select count(*)::int from expenses e where e.category_id = "expense_categories"."id")`,
    })
    .from(expenseCategories)
    .orderBy(asc(expenseCategories.createdAt));
}

export async function createExpenseCategory(input: In<typeof FinanceExpenseCategoryInput>) {
  const [row] = await db()
    .insert(expenseCategories)
    .values({ labId: ctx().labId, ...input })
    .returning();
  await record({ action: 'finance.expense_category.created', entityType: 'expense_category', entityId: row!.id, summary: row!.nameEn, after: input });
  moneyChanged({ kind: 'expense_category' });
  return row!;
}

export async function updateExpenseCategory(id: string, input: In<typeof FinanceExpenseCategoryInput>) {
  const [before] = await db().select().from(expenseCategories).where(eq(expenseCategories.id, id));
  if (!before) throw notFound();
  const [row] = await db().update(expenseCategories).set(input).where(eq(expenseCategories.id, id)).returning();
  await record({ action: 'finance.expense_category.updated', entityType: 'expense_category', entityId: id, summary: input.nameEn, before: { nameAr: before.nameAr, nameEn: before.nameEn }, after: input });
  moneyChanged({ kind: 'expense_category' });
  return row!;
}

export async function deleteExpenseCategory(id: string) {
  const [before] = await db().select().from(expenseCategories).where(eq(expenseCategories.id, id));
  if (!before) throw notFound();
  if ((await countRows(expenses, eq(expenses.categoryId, id))) > 0) throw conflict('in_use', 'Expenses use this category');
  await db().delete(expenseCategories).where(eq(expenseCategories.id, id));
  await record({ action: 'finance.expense_category.deleted', entityType: 'expense_category', entityId: id, summary: before.nameEn, before });
  moneyChanged({ kind: 'expense_category' });
  return { ok: true };
}

export async function listExpenses(f: { from?: string; to?: string; categoryId?: string; limit: number; offset: number }): Promise<FinanceExpenseList> {
  const { start, end } = await dayRange(f.from, f.to);
  const where = and(gte(expenses.paidAt, start), lt(expenses.paidAt, end), f.categoryId ? eq(expenses.categoryId, f.categoryId) : undefined);
  const [rows, total, sums] = await inSequence([
    () => db()
      .select({
        e: expenses,
        categoryNameAr: expenseCategories.nameAr,
        categoryNameEn: expenseCategories.nameEn,
        createdByNameAr: users.fullNameAr,
        createdByNameEn: users.fullNameEn,
        sessionStatus: cashSessions.status,
      })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .leftJoin(users, eq(users.id, expenses.createdBy))
      .leftJoin(cashSessions, eq(cashSessions.id, expenses.cashSessionId))
      .where(where)
      .orderBy(desc(expenses.paidAt))
      .limit(f.limit)
      .offset(f.offset),
    () => countRows(expenses, where),
    () => db()
      .select({ categoryId: expenseCategories.id, nameAr: expenseCategories.nameAr, nameEn: expenseCategories.nameEn, amount: sql<string>`sum(${expenses.amount})` })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(where)
      .groupBy(expenseCategories.id)
      .orderBy(sql`sum(${expenses.amount}) desc`),
  ]);
  const byCategory = sums.map((s) => ({ ...s, amount: num(s.amount) }));
  return {
    items: rows.map((r) => ({
      id: r.e.id,
      categoryId: r.e.categoryId,
      categoryNameAr: r.categoryNameAr,
      categoryNameEn: r.categoryNameEn,
      amount: r.e.amount,
      currency: r.e.currency,
      paidAt: r.e.paidAt.toISOString(),
      note: r.e.note,
      cashSessionId: r.e.cashSessionId,
      sessionClosed: r.sessionStatus === 'closed',
      createdByNameAr: r.createdByNameAr,
      createdByNameEn: r.createdByNameEn,
    })),
    total,
    sum: byCategory.reduce((a, c) => a + c.amount, 0),
    byCategory,
  };
}

export async function createExpense(input: In<typeof FinanceExpenseInput>): Promise<FinanceExpense> {
  const { labId, userId } = ctx();
  const [cat] = await db().select().from(expenseCategories).where(eq(expenseCategories.id, input.categoryId));
  if (!cat) throw badRequest('validation', 'Unknown category', { categoryId: ['not_found'] });
  const lab = await getLab(labId);
  let cashSessionId: string | null = null;
  if (input.fromDrawer) {
    const session = await currentCashSession(userId);
    if (!session) throw conflict('no_cash_session', 'Open a cash session to pay from the drawer');
    cashSessionId = session.id;
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: lab.timezone }).format(new Date());
  if (input.paidOn && input.paidOn > today) throw badRequest('validation', 'The date is in the future', { paidOn: ['future_date'] });
  const paidAt = !input.paidOn || input.paidOn === today ? new Date() : new Date(zonedDayStart(input.paidOn, lab.timezone).getTime() + 12 * 3_600_000);
  const amount = roundMoney(input.amount, lab.currency);
  const [row] = await db()
    .insert(expenses)
    .values({ labId, categoryId: input.categoryId, amount, currency: lab.currency, paidAt, note: input.note, cashSessionId, createdBy: userId })
    .returning();
  await record({
    action: 'finance.expense.created',
    entityType: 'expense',
    entityId: row!.id,
    summary: `${cat.nameEn} · ${amount} ${lab.currency}${cashSessionId ? ' · drawer' : ''}`,
    after: { categoryId: input.categoryId, amount, paidAt, note: input.note, cashSessionId },
  });
  moneyChanged({ expenseId: row!.id, cashSessionId });
  const names = await userNames([userId]);
  return {
    id: row!.id,
    categoryId: row!.categoryId,
    categoryNameAr: cat.nameAr,
    categoryNameEn: cat.nameEn,
    amount: row!.amount,
    currency: row!.currency,
    paidAt: row!.paidAt.toISOString(),
    note: row!.note,
    cashSessionId,
    sessionClosed: false,
    createdByNameAr: userId ? names.get(userId)?.fullNameAr ?? null : null,
    createdByNameEn: userId ? names.get(userId)?.fullNameEn ?? null : null,
  };
}

export async function deleteExpense(id: string) {
  const [e] = await db().select().from(expenses).where(eq(expenses.id, id));
  if (!e) throw notFound();
  if (e.cashSessionId) {
    const [s] = await db().select({ status: cashSessions.status }).from(cashSessions).where(eq(cashSessions.id, e.cashSessionId));
    if (s?.status === 'closed') throw conflict('session_closed', 'The expense belongs to a closed cash session');
  }
  await db().delete(expenses).where(eq(expenses.id, id));
  await record({ action: 'finance.expense.deleted', entityType: 'expense', entityId: id, summary: `${e.amount} ${e.currency}`, before: e });
  moneyChanged({ expenseId: id });
  return { ok: true };
}

/* ================================================================== summary */

/** Billed, collected, outstanding, discounts, insurer receivables, expenses and net cash for a period. */
export async function summary(from?: string, to?: string): Promise<FinanceSummary> {
  const lab = await getLab(ctx().labId);
  const tz = lab.timezone;
  const { start, end } = await dayRange(from, to);
  const s = start.toISOString();
  const e = end.toISOString();
  const [inv] = await rowsOf<Record<string, string>>(sql`
    select count(*) as n, coalesce(sum(subtotal), 0) as billed, coalesce(sum(discount_total), 0) as discounts,
      coalesce(sum(greatest(patient_total - paid_total, 0)), 0) as outstanding,
      coalesce(sum(i.insurer_total) filter (where pg.on_account), 0) as insurer
    from invoices i join payer_groups pg on pg.id = i.payer_group_id
    where i.status <> 'void' and i.created_at >= ${s}::timestamptz and i.created_at < ${e}::timestamptz`);
  const [pay] = await rowsOf<Record<string, string>>(sql`
    select coalesce(sum(amount) filter (where kind = 'payment'), 0) as collected, coalesce(sum(amount) filter (where kind = 'refund'), 0) as refunds
    from payments where received_at >= ${s}::timestamptz and received_at < ${e}::timestamptz`);
  const [exp] = await rowsOf<Record<string, string>>(sql`
    select coalesce(sum(amount), 0) as total from expenses where paid_at >= ${s}::timestamptz and paid_at < ${e}::timestamptz`);
  const byMethod = await methodTotals(and(gte(payments.receivedAt, start), lt(payments.receivedAt, end))!);
  const days = await rowsOf<{ day: string; net: string; collected: string; expenses: string }>(sql`
    with d as (
      select to_char((created_at at time zone ${tz})::date, 'YYYY-MM-DD') as day, sum(subtotal - discount_total) as net, 0::numeric as collected, 0::numeric as expenses
      from invoices where status <> 'void' and created_at >= ${s}::timestamptz and created_at < ${e}::timestamptz group by 1
      union all
      select to_char((received_at at time zone ${tz})::date, 'YYYY-MM-DD'), 0, sum(case when kind = 'payment' then amount else -amount end), 0
      from payments where received_at >= ${s}::timestamptz and received_at < ${e}::timestamptz group by 1
      union all
      select to_char((paid_at at time zone ${tz})::date, 'YYYY-MM-DD'), 0, 0, sum(amount)
      from expenses where paid_at >= ${s}::timestamptz and paid_at < ${e}::timestamptz group by 1
    )
    select day, sum(net) as net, sum(collected) as collected, sum(expenses) as expenses from d group by day order by day`);
  const collected = num(pay?.collected) - num(pay?.refunds);
  const expensesTotal = num(exp?.total);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  return {
    from: from ?? to ?? today,
    to: to ?? from ?? today,
    billed: num(inv?.billed),
    discounts: num(inv?.discounts),
    net: num(inv?.billed) - num(inv?.discounts),
    collected,
    refunds: num(pay?.refunds),
    outstanding: num(inv?.outstanding),
    insurerReceivables: num(inv?.insurer),
    expenses: expensesTotal,
    netCash: collected - expensesTotal,
    invoices: num(inv?.n),
    byMethod,
    byDay: fillDays(
      from ?? to ?? today,
      to ?? from ?? today,
      days.map((d) => ({ date: d.day, net: num(d.net), collected: num(d.collected), expenses: num(d.expenses) })),
      (date) => ({ date, net: 0, collected: 0, expenses: 0 }),
    ),
  };
}

/** Every calendar day of the range (YYYY-MM-DD, inclusive), missing days filled by `empty`. */
export function fillDays<T extends { date: string }>(from: string, to: string, rows: T[], empty: (date: string) => T): T[] {
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: T[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= last && i < 800; i++) {
    const key = d.toISOString().slice(0, 10);
    out.push(map.get(key) ?? empty(key));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

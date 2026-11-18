/**
 * Orders at the front desk (port of apps/api/src/modules/orders/service.ts): the reception form
 * data, quotes, creating an order (lines, tubes, results, invoice, optional payment), editing,
 * adding and removing tests, cancelling, labels, the receipt and the activity trail. Every
 * function runs in the signed-in lab.
 *
 * Mock mode has no transaction to roll back, so each function makes all its checks before its
 * first write (the server's createOrder already checks the payment first for the same reason).
 */
import type { z } from 'zod';
import {
  DELIVERY_CHANNELS,
  ORDER_SOURCES,
  PRIORITIES,
  type ActivityEntry,
  type CancelResult,
  type ItemsChanged,
  type OrderCreated,
  type OrderDetail,
  type OrderFormData,
  type OrderItemRow,
  type OrderLabels,
  type OrderListItem,
  type OrderQuote,
  type OrderReceipt,
  type OrderTube,
  type QuoteWarning,
  type ResultCounts,
  type addItemsInput,
  type orderCreateInput,
  type orderListQuery,
  type orderQuoteInput,
  type orderUpdateInput,
} from '@natija/contracts';
import { accessionFor, dateKey, portalCode, roundMoney, tubeBarcode } from '@natija/domain';
import { badRequest, conflict, ctx, notFound, now } from '../../../core/context';
import { by, find, get, insert, remove, rows, update, type Row } from '../../../core/db';
import { audit, dayRange, getLab, nextCounter, notifyPermission, publish, slice } from '../../../core/lib';
import {
  balanceOf,
  createDiscountApproval,
  currentCashSession,
  getInvoiceDetail,
  recomputeInvoice,
  refreshInvoiceTotals,
  takePayment,
  type InvoiceTotals,
} from '../../shared/billing';
import { refreshOrderStatus } from '../../shared/order-status';
import { oneOf, optText, reqText } from '../lenient';
import { patientSearchCondition, toSummary } from '../patients/search';
import { analyteOverlaps, loadPayer, loadTests, planTubes, priceItems, quoteResult, totalsOf, type PricedLine } from './pricing';

export type CreateOrderInput = z.output<typeof orderCreateInput>;
export type QuoteInput = z.output<typeof orderQuoteInput>;
export type OrderListQuery = z.output<typeof orderListQuery>;
export type UpdateOrderInput = z.output<typeof orderUpdateInput>;
export type AddItemsInput = z.output<typeof addItemsInput>;

type Order = Row<'orders'>;

const DEAD_TUBE = ['rejected', 'disposed'] as const;
const isDead = (status: string) => (DEAD_TUBE as readonly string[]).includes(status);

/* ------------------------------------------------------------------ helpers */

let lastMs = 0;
let tick = 0;

/**
 * Time-ordered ids, like the database's uuidv7(): lines made in the same instant are listed by
 * (createdAt, id) and so keep the order they were made in (random ids would shuffle them).
 */
function orderedId(): string {
  let ms = now().getTime();
  if (ms <= lastMs) {
    ms = lastMs;
    tick += 1;
  } else {
    lastMs = ms;
    tick = 0;
  }
  const time = ms.toString(16).padStart(12, '0').slice(-12);
  const count = tick.toString(16).padStart(6, '0').slice(-6);
  const rand = crypto.randomUUID().replace(/-/g, '');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${count.slice(0, 3)}-8${count.slice(3)}-${rand.slice(0, 12)}`;
}

/** Oldest first, then by id: the server's `order by created_at, id`. */
function byCreation<T extends { createdAt: Date; id: string }>(list: T[]): T[] {
  return list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Newest first; rows made in the same instant keep "last made first". */
function newestFirst<T extends { createdAt: Date }>(list: readonly T[]): T[] {
  return [...list].reverse().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function lockOrder(id: string): Order {
  return get('orders', id, 'order_not_found');
}

function assertActive(order: Order) {
  if (order.status === 'cancelled') throw conflict('order_cancelled', 'The order is cancelled.');
}

function bumpVersion(orderId: string) {
  const o = find('orders', orderId);
  if (o) update('orders', o, { updatedAt: now(), version: o.version + 1 });
}

/** Insert planned tubes ("pending", with a "created" event). Returns line key → tube id. */
function insertTubes(order: Pick<Order, 'id' | 'accession'>, plans: ReturnType<typeof planTubes>): Map<string, string> {
  const { userId } = ctx();
  const out = new Map<string, string>();
  for (const p of plans) {
    const tube = insert('samples', {
      id: orderedId(),
      orderId: order.id,
      barcode: tubeBarcode(order.accession, p.seq),
      seq: p.seq,
      containerId: p.containerId,
      sampleTypeId: p.sampleTypeId,
      departmentId: p.departmentId,
      status: 'pending',
    });
    insert('sampleEvents', { sampleId: tube.id, type: 'created', userId });
    for (const key of p.lineKeys) out.set(key, tube.id);
  }
  return out;
}

/** Insert order lines with their price snapshot, and one pending result per analyte. */
function insertLines(orderId: string, lines: PricedLine[], tubeByKey: Map<string, string>): void {
  for (const l of lines) {
    const item = insert('orderItems', {
      id: orderedId(),
      orderId,
      testId: l.testId,
      packageId: l.packageId,
      sampleId: tubeByKey.get(l.key) ?? null,
      status: 'ordered',
      units: l.units,
      unitPrice: l.unitPrice,
      price: l.price,
      discount: l.discount,
      isExternal: l.isExternal,
    });
    for (const a of l.test.analytes) insert('results', { id: orderedId(), orderId, orderItemId: item.id, analyteId: a.id, status: 'pending', unit: a.unit });
  }
}

/** Delete results with what hangs off them (attempts, versions, critical calls), as the database cascade does. */
function removeResults(list: Row<'results'>[]): void {
  if (!list.length) return;
  const ids = new Set(list.map((r) => r.id));
  remove('results', (r) => ids.has(r.id));
  remove('resultAttempts', (a) => ids.has(a.resultId));
  remove('resultVersions', (v) => ids.has(v.resultId));
  remove('criticalCalls', (c) => ids.has(c.resultId));
}

/**
 * A tube nobody needs any more: deleted while it is still waiting to be drawn,
 * otherwise marked disposed (it exists physically) with an event explaining why.
 */
function retireTube(sampleId: string, note: string, opts: { deletePending: boolean }): void {
  const { userId } = ctx();
  const tube = find('samples', sampleId);
  if (!tube || isDead(tube.status)) return;
  if (tube.status === 'pending' && opts.deletePending) {
    for (const item of by('orderItems', 'sampleId', sampleId)) update('orderItems', item, { sampleId: null });
    remove('sampleEvents', (e) => e.sampleId === sampleId);
    remove('samples', (s) => s.id === sampleId);
    return;
  }
  update('samples', tube, { status: 'disposed', disposedAt: now(), disposedBy: userId });
  insert('sampleEvents', { sampleId, type: 'disposed', userId, note });
}

function emptyCounts(): ResultCounts {
  return { total: 0, pending: 0, resulted: 0, verified: 0, validated: 0, released: 0, critical: 0 };
}

function userRef(id: string | null): { id: string; fullNameAr: string; fullNameEn: string } | null {
  const u = id ? find('users', id) : undefined;
  return u ? { id: u.id, fullNameAr: u.fullNameAr, fullNameEn: u.fullNameEn } : null;
}

/* ------------------------------------------------------------------ form data & quote */

/** Everything the reception screen needs in one call. */
export function formData(): OrderFormData {
  const { userId } = ctx();
  const lab = getLab();
  const testRows = rows('tests')
    .filter((t) => t.isActive)
    .map((t) => ({ t, c: find('containers', t.containerId), st: find('sampleTypes', t.sampleTypeId) }))
    .filter((r): r is { t: Row<'tests'>; c: Row<'containers'>; st: Row<'sampleTypes'> } => !!r.c && !!r.st)
    .sort((a, b) => a.t.sortOrder - b.t.sortOrder || a.t.code.localeCompare(b.t.code));
  const codesByTest = new Map<string, string[]>();
  const links = rows('testAnalytes')
    .map((ta) => ({ ta, a: find('analytes', ta.analyteId) }))
    .filter((x): x is { ta: Row<'testAnalytes'>; a: Row<'analytes'> } => !!x.a && x.a.isActive)
    .sort((x, y) => x.ta.sortOrder - y.ta.sortOrder || x.a.sortOrder - y.a.sortOrder);
  for (const { ta, a } of links) codesByTest.set(ta.testId, [...(codesByTest.get(ta.testId) ?? []), a.code]);
  const deptRows = [...rows('departments')].sort((a, b) => a.sortOrder - b.sortOrder);
  const pkgRows = rows('packages')
    .filter((p) => p.isActive)
    .sort((a, b) => a.code.localeCompare(b.code));
  const pkgTests = rows('packageTests');
  const payerRows = rows('payerGroups')
    .filter((p) => p.isActive)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.code.localeCompare(b.code));
  const doctorRows = rows('doctors')
    .filter((d) => d.isActive)
    .sort((a, b) => a.nameAr.localeCompare(b.nameAr, 'ar'));
  const methodRows = rows('paymentMethods')
    .filter((m) => m.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const branchRows = [...rows('branches')].sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.code.localeCompare(b.code));
  const session = currentCashSession(userId);
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
    priceOverrides: rows('priceOverrides').map((o) => ({ payerGroupId: o.payerGroupId, testId: o.testId, price: o.price })),
    doctors: doctorRows.map((d) => ({ id: d.id, nameAr: d.nameAr, nameEn: d.nameEn, specialtyAr: d.specialtyAr, specialtyEn: d.specialtyEn, clinic: d.clinic, phone: d.phone })),
    paymentMethods: methodRows.map((m) => ({ id: m.id, code: m.code, nameAr: m.nameAr, nameEn: m.nameEn, isCash: m.isCash })),
    branches: branchRows.map((b) => ({ id: b.id, code: b.code, nameAr: b.nameAr, nameEn: b.nameEn, isMain: b.isMain })),
    cashSession: session ? { id: session.id, openedAt: session.openedAt.toISOString() } : null,
  };
}

/** Price lines and totals without writing anything (live at reception, and for phone quotes). */
export function quoteOrder(input: QuoteInput, opts: { canApproveDiscount: boolean }): OrderQuote {
  const lab = getLab();
  const payer = loadPayer(input.payerGroupId);
  const priced = priceItems({
    payer,
    items: input.items ?? [],
    currency: lab.currency,
    manualDiscount: input.discount ?? null,
    applyManualDiscount: opts.canApproveDiscount,
  });
  return quoteResult({ payerGroupId: payer.id, currency: lab.currency, priced, canApproveDiscount: opts.canApproveDiscount });
}

/* ------------------------------------------------------------------ create */

function createdSummary(orderId: string, extra: { warnings: QuoteWarning[]; approvalId: string | null; paymentId: string | null }): OrderCreated {
  const order = get('orders', orderId, 'order_not_found');
  const inv = by('invoices', 'orderId', orderId)[0];
  const pay = extra.paymentId ? find('payments', extra.paymentId) : undefined;
  return {
    id: order.id,
    accession: order.accession,
    dailyNo: order.dailyNo,
    portalCode: order.portalCode,
    status: order.status,
    tubes: by('samples', 'orderId', orderId).length,
    invoice: inv
      ? { id: inv.id, number: inv.number, patientTotal: inv.patientTotal, insurerTotal: inv.insurerTotal, paidTotal: inv.paidTotal, balance: balanceOf(inv, inv.currency), status: inv.status }
      : { id: '', number: '', patientTotal: 0, insurerTotal: 0, paidTotal: 0, balance: 0, status: 'open' },
    approvalId: extra.approvalId,
    payment: pay ? { id: pay.id, amount: pay.amount } : null,
    warnings: extra.warnings,
  };
}

/**
 * Register an order: price the lines (packages expanded), give it today's number, group the
 * lines into tubes, create pending results and the invoice, handle a requested discount
 * (applied for approvers, otherwise sent for approval) and an optional payment.
 */
export function createOrder(input: CreateOrderInput, opts: { canApproveDiscount: boolean }): OrderCreated {
  const { labId, userId } = ctx();
  const lab = getLab(labId);

  // The same request sent twice (same payment key) returns the order the first one made.
  const payKey = input.payment?.idempotencyKey;
  if (payKey) {
    const prior = by('payments', 'idempotencyKey', payKey)[0];
    const priorInvoice = prior ? find('invoices', prior.invoiceId) : undefined;
    if (prior && priorInvoice) return createdSummary(priorInvoice.orderId, { warnings: [], approvalId: null, paymentId: prior.id });
  }

  const patient = find('patients', input.patientId);
  if (!patient || patient.deletedAt) throw notFound('patient_not_found');
  if (patient.mergedIntoId) throw conflict('patient_merged', 'This record was merged into another patient.');
  const payer = loadPayer(input.payerGroupId);
  if (input.doctorId) {
    const doctor = find('doctors', input.doctorId);
    if (!doctor || !doctor.isActive) throw badRequest('doctor_not_found', 'Unknown doctor.');
  }
  if (input.branchId && !find('branches', input.branchId)) throw badRequest('branch_not_found', 'Unknown branch.');

  const priced = priceItems({
    payer,
    items: input.items ?? [],
    currency: lab.currency,
    manualDiscount: input.discount ?? null,
    applyManualDiscount: opts.canApproveDiscount,
  });
  if (!priced.lines.length) throw badRequest('no_tests', 'Add at least one test.');
  const totals = totalsOf(priced.lines, lab.currency);

  // Check the payment before writing anything, so a closed cash box doesn't leave half an order.
  // A payment of nothing (the server refuses it as invalid input) is simply no payment here.
  const payAmount = input.payment ? roundMoney(Number(input.payment.amount) || 0, lab.currency) : 0;
  const payment = input.payment && payAmount > 0 ? input.payment : null;
  if (payment) {
    if (payAmount > totals.patientTotal) throw badRequest('amount_exceeds_balance', `The patient owes ${totals.patientTotal}.`);
    const method = find('paymentMethods', payment.methodId);
    if (!method || !method.isActive) throw badRequest('payment_method_invalid');
    if (method.isCash && !currentCashSession(userId)) throw conflict('no_cash_session', 'Open a cash session before taking cash.');
  }

  const at = now();
  const dailyNo = nextCounter(`order:${dateKey(at, lab.timezone)}`);
  const accession = accessionFor(at, dailyNo, lab.timezone);
  const priority = oneOf(input.priority, PRIORITIES, 'routine');
  const source = oneOf(input.source, ORDER_SOURCES, 'walk_in');
  const order = insert('orders', {
    id: orderedId(),
    branchId: input.branchId ?? null,
    accession,
    dailyNo,
    patientId: patient.id,
    payerGroupId: payer.id,
    doctorId: input.doctorId ?? null,
    referralClinic: optText(input.referralClinic),
    source,
    externalRef: optText(input.externalRef),
    priority,
    status: 'registered',
    clinicalInfo: optText(input.clinicalInfo),
    notes: optText(input.notes),
    fasting: input.fasting === true,
    pregnant: patient.sex === 'female' && input.pregnant === true,
    deliveryChannel: oneOf(input.deliveryChannel, DELIVERY_CHANNELS, 'print'),
    portalCode: portalCode(),
    createdBy: userId,
    createdAt: at,
    updatedAt: at,
  });

  const tubes = planTubes(priced.lines);
  const tubeByKey = insertTubes(order, tubes);
  insertLines(order.id, priced.lines, tubeByKey);
  const invoice = recomputeInvoice(order.id);

  let approvalId: string | null = null;
  if (input.discount && priced.requestedDiscount > 0) {
    const reason = reqText(input.discount.reason);
    if (opts.canApproveDiscount) {
      audit({
        action: 'invoice.discount',
        entityType: 'invoice',
        entityId: invoice.id,
        summary: `${accession} · −${priced.requestedDiscount} ${lab.currency} · ${reason}`,
        after: { discount: priced.requestedDiscount, reason },
      });
    } else {
      approvalId = createDiscountApproval({
        orderId: order.id,
        invoiceId: invoice.id,
        accession,
        amount: priced.requestedDiscount,
        percent: input.discount.percent ?? null,
        reason,
        currency: lab.currency,
      });
    }
  }

  audit({
    action: 'order.create',
    entityType: 'order',
    entityId: order.id,
    summary: `${accession} · ${patient.fullNameAr} · ${priced.lines.map((l) => l.code).join(', ')}`,
    after: {
      accession,
      patientId: patient.id,
      payer: payer.code,
      priority,
      source,
      tests: priced.lines.map((l) => l.code),
      packages: priced.packages.map((p) => p.code),
      tubes: tubes.length,
      totals,
    },
  });
  publish({ type: 'orders.changed', data: { orderId: order.id, status: 'registered' } });

  let paymentId: string | null = null;
  if (payment) {
    const paid = takePayment({
      invoiceId: invoice.id,
      amount: payAmount,
      methodId: payment.methodId,
      reference: optText(payment.reference),
      idempotencyKey: payment.idempotencyKey ?? '',
    });
    paymentId = paid.payment.id;
  }

  const warnings = [...priced.warnings, ...analyteOverlaps(priced.lines.map((l) => l.test))];
  return createdSummary(order.id, { warnings, approvalId, paymentId });
}

/* ------------------------------------------------------------------ list & detail */

export function listOrders(query: OrderListQuery): { items: OrderListItem[]; total: number } {
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  let list: Order[] = query.patientId ? by('orders', 'patientId', query.patientId) : [...rows('orders')];
  // Searching or looking at one patient spans all dates unless a range is given.
  if (query.from || query.to || (!q && !query.patientId)) {
    const { start, end } = dayRange(query.from, query.to);
    list = list.filter((o) => o.createdAt >= start && o.createdAt < end);
  }
  if (query.status) list = list.filter((o) => o.status === query.status);
  if (query.priority) list = list.filter((o) => o.priority === query.priority);
  if (query.source) list = list.filter((o) => o.source === query.source);
  if (query.payerGroupId) list = list.filter((o) => o.payerGroupId === query.payerGroupId);
  if (query.doctorId) list = list.filter((o) => o.doctorId === query.doctorId);
  if (q) {
    const byPatient = patientSearchCondition(q);
    const prefix = q.toLowerCase();
    list = list.filter((o) => {
      if (o.accession.toLowerCase().startsWith(prefix) || (o.externalRef ?? '').toLowerCase().startsWith(prefix)) return true;
      const p = byPatient ? find('patients', o.patientId) : undefined;
      return !!p && byPatient!(p);
    });
  }
  if (query.unpaid) {
    list = list.filter((o) => {
      const inv = by('invoices', 'orderId', o.id)[0];
      return !!inv && inv.status !== 'void' && inv.patientTotal > inv.paidTotal;
    });
  }
  list = list.filter((o) => !!find('patients', o.patientId) && !!find('payerGroups', o.payerGroupId));
  return { items: slice(newestFirst(list), query).map(decorateOrder), total: list.length };
}

function decorateOrder(o: Order): OrderListItem {
  const p = find('patients', o.patientId)!;
  const pg = find('payerGroups', o.payerGroupId)!;
  const d = o.doctorId ? find('doctors', o.doctorId) : undefined;
  const inv = by('invoices', 'orderId', o.id)[0];
  const codes: string[] = [];
  let released = 0;
  for (const it of byCreation(by('orderItems', 'orderId', o.id).filter((i) => i.status !== 'cancelled'))) {
    const test = find('tests', it.testId);
    if (!test) continue;
    codes.push(test.code);
    if (it.status === 'released') released += 1;
  }
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
    testCodes: codes,
    testCount: codes.length,
    releasedCount: released,
    patientTotal: inv?.patientTotal ?? 0,
    paidTotal: inv?.paidTotal ?? 0,
    balance: inv ? balanceOf(inv, inv.currency) : 0,
    invoiceStatus: inv?.status ?? null,
    hasCritical: by('results', 'orderId', o.id).some((r) => r.isCritical),
  };
}

export function getOrder(id: string): OrderDetail {
  const o = find('orders', id);
  const p = o ? find('patients', o.patientId) : undefined;
  const pg = o ? find('payerGroups', o.payerGroupId) : undefined;
  if (!o || !p || !pg) throw notFound('order_not_found');
  const d = o.doctorId ? find('doctors', o.doctorId) : undefined;
  const b = o.branchId ? find('branches', o.branchId) : undefined;

  const perItem = new Map<string, ResultCounts>();
  const overall = emptyCounts();
  for (const r of by('results', 'orderId', id)) {
    const entry = perItem.get(r.orderItemId) ?? emptyCounts();
    for (const target of [entry, overall]) {
      target.total += 1;
      target[r.status] += 1;
      if (r.isCritical) target.critical += 1;
    }
    perItem.set(r.orderItemId, entry);
  }

  const items: OrderItemRow[] = [];
  for (const i of byCreation(by('orderItems', 'orderId', id))) {
    const t = find('tests', i.testId);
    if (!t) continue;
    const dept = find('departments', t.departmentId);
    const pkg = i.packageId ? find('packages', i.packageId) : undefined;
    const sample = i.sampleId ? find('samples', i.sampleId) : undefined;
    const container = sample ? find('containers', sample.containerId) : undefined;
    items.push({
      id: i.id,
      testId: i.testId,
      code: t.code,
      nameAr: t.nameAr,
      nameEn: t.nameEn,
      departmentId: t.departmentId,
      departmentNameAr: dept?.nameAr ?? '',
      departmentNameEn: dept?.nameEn ?? '',
      packageId: i.packageId,
      packageCode: pkg?.code ?? null,
      packageNameAr: pkg?.nameAr ?? null,
      packageNameEn: pkg?.nameEn ?? null,
      sampleId: i.sampleId,
      barcode: sample?.barcode ?? null,
      capColor: container?.capColor ?? null,
      status: i.status,
      units: i.units,
      unitPrice: i.unitPrice,
      price: i.price,
      discount: i.discount,
      isExternal: i.isExternal,
      tatHours: t.tatHours,
      dueAt: new Date(o.createdAt.getTime() + t.tatHours * 3_600_000).toISOString(),
      cancelledAt: i.cancelledAt ? i.cancelledAt.toISOString() : null,
      resultCounts: perItem.get(i.id) ?? emptyCounts(),
    });
  }

  const tubes: OrderTube[] = [];
  for (const s of by('samples', 'orderId', id).sort((a, b) => a.seq - b.seq)) {
    const c = find('containers', s.containerId);
    const st = find('sampleTypes', s.sampleTypeId);
    if (!c || !st) continue;
    tubes.push({
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
    });
  }

  const inv = by('invoices', 'orderId', id)[0];
  const report = by('reports', 'orderId', id).sort((a, b) => b.version - a.version)[0];

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
    createdBy: userRef(o.createdBy),
    cancelledBy: userRef(o.cancelledBy),
    items,
    tubes,
    resultCounts: overall,
    invoice: inv ? getInvoiceDetail(inv.id) : null,
    latestReport: report
      ? { id: report.id, version: report.version, status: report.status, releasedAt: report.releasedAt.toISOString(), verifyCode: report.verifyCode }
      : null,
    cancellable: o.status !== 'cancelled' && overall.validated + overall.released === 0,
  };
}

/* ------------------------------------------------------------------ edit */

const EDITABLE = ['doctorId', 'referralClinic', 'priority', 'clinicalInfo', 'notes', 'deliveryChannel', 'fasting', 'pregnant', 'externalRef'] as const;

/** A sent header field as stored; undefined when it can't be stored (an unknown priority…). */
function editValue(key: (typeof EDITABLE)[number], value: unknown): unknown {
  switch (key) {
    case 'priority':
      return (PRIORITIES as readonly unknown[]).includes(value) ? value : undefined;
    case 'deliveryChannel':
      return (DELIVERY_CHANNELS as readonly unknown[]).includes(value) ? value : undefined;
    case 'fasting':
    case 'pregnant':
      return typeof value === 'boolean' ? value : undefined;
    case 'doctorId':
      return value ?? null;
    default:
      return optText(value);
  }
}

/**
 * Change the order header (doctor, priority, notes…). `version` guards against lost updates.
 * Mock mode: a request without a version skips that check, and "pregnant" for a patient who is
 * not female is stored as false (the server refuses both).
 */
export function updateOrder(id: string, input: UpdateOrderInput): OrderDetail {
  const order = lockOrder(id);
  assertActive(order);
  if (input.version !== undefined && order.version !== input.version) throw conflict('version_conflict', 'Someone else changed this order. Reload it and try again.');
  if (input.doctorId && !find('doctors', input.doctorId)) throw badRequest('doctor_not_found', 'Unknown doctor.');
  const female = find('patients', order.patientId)?.sex === 'female';
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const patch: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (input[key] === undefined) continue;
    let value = editValue(key, input[key]);
    if (value === undefined) continue;
    if (key === 'pregnant' && value === true && !female) value = false;
    if ((order[key] ?? null) === (value ?? null)) continue;
    patch[key] = value ?? null;
    before[key] = order[key];
    after[key] = value ?? null;
  }
  if (!Object.keys(patch).length) return getOrder(id);
  update('orders', order, { ...(patch as Partial<Order>), updatedAt: now(), version: order.version + 1 });
  audit({ action: 'order.update', entityType: 'order', entityId: id, summary: `${order.accession} · ${Object.keys(patch).join(', ')}`, before, after });
  publish({ type: 'orders.changed', data: { orderId: id } });
  return getOrder(id);
}

/** Add tests to an order: same-specimen tubes are reused while usable, new tubes otherwise. */
export function addItems(id: string, input: AddItemsInput): ItemsChanged {
  const lab = getLab();
  const order = lockOrder(id);
  assertActive(order);
  const payer = get('payerGroups', order.payerGroupId, 'payer_not_found');
  const current = by('orderItems', 'orderId', id)
    .filter((i) => i.status !== 'cancelled')
    .flatMap((i) => {
      const t = find('tests', i.testId);
      return t ? [{ testId: i.testId, sampleId: i.sampleId, separateTube: t.separateTube }] : [];
    });
  const priced = priceItems({ payer, items: input.items ?? [], currency: lab.currency, existingTestIds: current.map((c) => c.testId) });
  if (!priced.lines.length) throw badRequest('no_new_tests', 'These tests are already in the order.');

  const tubes = by('samples', 'orderId', id).sort((a, b) => a.seq - b.seq);
  const ownTube = new Set(current.filter((c) => c.separateTube && c.sampleId).map((c) => c.sampleId!));
  const tubeByKey = new Map<string, string>();
  const needTube: PricedLine[] = [];
  for (const line of priced.lines) {
    const tube = line.test.separateTube
      ? undefined
      : tubes.find((t) => t.containerId === line.containerId && t.sampleTypeId === line.sampleTypeId && !ownTube.has(t.id) && !isDead(t.status));
    if (!tube) {
      needTube.push(line);
      continue;
    }
    tubeByKey.set(line.key, tube.id);
    if (tube.departmentId && tube.departmentId !== line.departmentId) update('samples', tube, { departmentId: null });
  }
  const nextSeq = tubes.reduce((m, t) => Math.max(m, t.seq), 0) + 1;
  const plans = planTubes(needTube, nextSeq);
  for (const [k, v] of insertTubes(order, plans)) tubeByKey.set(k, v);
  insertLines(id, priced.lines, tubeByKey);
  const invoice = recomputeInvoice(id);
  refreshOrderStatus(id);
  bumpVersion(id);

  const allTests = loadTests([...current.map((c) => c.testId), ...priced.lines.map((l) => l.testId)]);
  const warnings = [...priced.warnings, ...analyteOverlaps([...allTests.values()])];
  audit({
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
export function removeItem(orderId: string, itemId: string, reason: string): ItemsChanged {
  const order = lockOrder(orderId);
  assertActive(order);
  const item = find('orderItems', itemId);
  const test = item ? find('tests', item.testId) : undefined;
  if (!item || item.orderId !== orderId || !test) throw notFound('item_not_found');
  if (item.status === 'cancelled') throw conflict('item_cancelled', 'This test was already removed.');
  const itemResults = by('results', 'orderItemId', itemId);
  if (itemResults.some((r) => r.status !== 'pending' || r.valueNum !== null || (r.valueText ?? '') !== '')) {
    throw conflict('item_has_results', 'Results were already entered for this test.');
  }
  const active = by('orderItems', 'orderId', orderId).filter((i) => i.status !== 'cancelled').length;
  if (active <= 1) throw conflict('last_item', 'This is the only test; cancel the order instead.');
  const before = { test: test.code, price: item.price, discount: item.discount };

  update('orderItems', item, { status: 'cancelled', cancelledAt: now() });
  removeResults(itemResults);
  if (item.sampleId) {
    const others = by('orderItems', 'sampleId', item.sampleId).filter((i) => i.status !== 'cancelled').length;
    if (others === 0) retireTube(item.sampleId, `No tests left (${test.code} removed): ${reason}`, { deletePending: true });
  }
  const invoice = recomputeInvoice(orderId);
  refreshOrderStatus(orderId);
  bumpVersion(orderId);
  audit({
    action: 'order.remove_item',
    entityType: 'order',
    entityId: orderId,
    summary: `${order.accession} − ${test.code} · ${reason}`,
    before,
    after: { reason, patientTotal: invoice.patientTotal },
  });
  publish({ type: 'orders.changed', data: { orderId } });
  return { orderId, added: 0, newTubes: 0, warnings: [], invoice: invoiceSummary(invoice) };
}

/**
 * Cancel an order while nothing in it is validated: lines are cancelled, tubes retired,
 * empty results removed, an unpaid invoice voided (a paid one is left showing the refund due).
 */
export function cancelOrder(id: string, reason: string): CancelResult {
  const { userId } = ctx();
  const order = lockOrder(id);
  assertActive(order);
  const orderResults = by('results', 'orderId', id);
  if (orderResults.some((r) => r.status === 'validated' || r.status === 'released')) {
    throw conflict('order_has_validated_results', 'Results in this order are already validated.');
  }
  const previous = order.status;
  const at = now();
  for (const item of by('orderItems', 'orderId', id)) if (item.status !== 'cancelled') update('orderItems', item, { status: 'cancelled', cancelledAt: at });
  removeResults(orderResults.filter((r) => r.status === 'pending' && r.valueNum === null && (r.valueText ?? '') === ''));
  for (const tube of by('samples', 'orderId', id)) if (!isDead(tube.status)) retireTube(tube.id, `Order cancelled: ${reason}`, { deletePending: false });
  update('orders', order, { status: 'cancelled', cancelledAt: at, cancelledBy: userId, cancelReason: reason, updatedAt: at, version: order.version + 1 });
  for (const a of by('approvals', 'orderId', id)) {
    if (a.status === 'pending') update('approvals', a, { status: 'rejected', decidedBy: userId, decidedAt: at, decisionNote: 'Order cancelled' });
  }

  let invoiceVoided = false;
  let refundDue = 0;
  const inv = by('invoices', 'orderId', id)[0];
  if (inv && inv.status !== 'void') {
    const totals = refreshInvoiceTotals(inv.id);
    if (totals.paidTotal <= 0) {
      update('invoices', inv, { status: 'void', voidedAt: at, voidReason: reason, updatedAt: at, version: inv.version + 1 });
      invoiceVoided = true;
    } else {
      const after = recomputeInvoice(id);
      refundDue = roundMoney(Math.max(0, after.paidTotal - after.patientTotal), inv.currency);
    }
  }

  audit({
    action: 'order.cancel',
    entityType: 'order',
    entityId: id,
    summary: `${order.accession} · ${reason}`,
    before: { status: previous },
    after: { status: 'cancelled', reason, invoiceVoided, refundDue },
  });
  if (refundDue > 0 && inv) {
    notifyPermission('finance.refund', {
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
  const s = [first, last]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return s || null;
}

export function orderLabels(id: string): OrderLabels {
  const o = find('orders', id);
  const p = o ? find('patients', o.patientId) : undefined;
  if (!o || !p) throw notFound('order_not_found');
  const lines = byCreation(by('orderItems', 'orderId', id).filter((i) => i.status !== 'cancelled'));
  const labels: OrderLabels['labels'] = [];
  for (const s of by('samples', 'orderId', id).sort((a, b) => a.seq - b.seq)) {
    if (isDead(s.status)) continue;
    const c = find('containers', s.containerId);
    const st = find('sampleTypes', s.sampleTypeId);
    if (!c || !st) continue;
    labels.push({
      sampleId: s.id,
      barcode: s.barcode,
      seq: s.seq,
      status: s.status,
      containerCode: c.code,
      containerNameAr: c.nameAr,
      containerNameEn: c.nameEn,
      capColor: c.capColor,
      sampleTypeCode: st.code,
      testCodes: lines.filter((i) => i.sampleId === s.id).flatMap((i) => find('tests', i.testId)?.code ?? []),
      labelPrintedAt: s.labelPrintedAt ? s.labelPrintedAt.toISOString() : null,
    });
  }
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
    labels,
  };
}

export function markLabelsPrinted(id: string, sampleIds?: string[]): { printed: number } {
  const { userId } = ctx();
  const order = get('orders', id, 'order_not_found');
  const wanted = sampleIds?.length ? new Set(sampleIds) : null;
  const tubes = by('samples', 'orderId', id)
    .filter((s) => !isDead(s.status) && (!wanted || wanted.has(s.id)))
    .sort((a, b) => a.seq - b.seq);
  const at = now();
  for (const s of tubes) {
    update('samples', s, { labelPrintedAt: at });
    insert('sampleEvents', { sampleId: s.id, type: 'label_printed', userId });
  }
  if (tubes.length) {
    audit({ action: 'order.labels_printed', entityType: 'order', entityId: id, summary: `${order.accession} · ${tubes.map((s) => s.barcode).join(', ')}` });
    publish({ type: 'samples.changed', data: { orderId: id } });
  }
  return { printed: tubes.length };
}

export function orderReceipt(id: string): OrderReceipt {
  const lab = getLab();
  const o = find('orders', id);
  const p = o ? find('patients', o.patientId) : undefined;
  if (!o || !p) throw notFound('order_not_found');
  const d = o.doctorId ? find('doctors', o.doctorId) : undefined;
  const inv = by('invoices', 'orderId', id)[0];
  return {
    lab: { code: lab.code, nameAr: lab.nameAr, nameEn: lab.nameEn, phone: lab.phone, addressAr: lab.addressAr, addressEn: lab.addressEn, logoSvg: lab.logoSvg, currency: lab.currency },
    order: { id: o.id, accession: o.accession, dailyNo: o.dailyNo, createdAt: o.createdAt.toISOString(), portalCode: o.portalCode, status: o.status },
    patient: toSummary(p),
    doctor: d ? { nameAr: d.nameAr, nameEn: d.nameEn } : null,
    invoice: inv ? getInvoiceDetail(inv.id) : null,
  };
}

/** Audit trail of the order and everything hanging off it (tubes, results, invoice, payments…). */
export function orderActivity(id: string): ActivityEntry[] {
  get('orders', id, 'order_not_found');
  const invoiceIds = by('invoices', 'orderId', id).map((r) => r.id);
  const groups: Array<[string, string[]]> = [
    ['order', [id]],
    ['sample', by('samples', 'orderId', id).map((r) => r.id)],
    ['result', by('results', 'orderId', id).map((r) => r.id)],
    ['order_item', by('orderItems', 'orderId', id).map((r) => r.id)],
    ['invoice', invoiceIds],
    ['payment', invoiceIds.flatMap((invoiceId) => by('payments', 'invoiceId', invoiceId).map((r) => r.id))],
    ['approval', by('approvals', 'orderId', id).map((r) => r.id)],
    ['report', by('reports', 'orderId', id).map((r) => r.id)],
    ['delivery', by('deliveries', 'orderId', id).map((r) => r.id)],
  ];
  const seen = new Set<string>();
  const entries: Row<'auditLog'>[] = [];
  for (const [entityType, ids] of groups) {
    for (const entityId of ids) {
      for (const r of by('auditLog', 'entityId', entityId)) {
        if (r.entityType !== entityType || seen.has(r.id)) continue;
        seen.add(r.id);
        entries.push(r);
      }
    }
  }
  return entries
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 500)
    .map((r) => ({
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

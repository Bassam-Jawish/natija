/** Order routes (port of apps/api/src/modules/orders/routes.ts): the same paths and permissions. */
import { addItemsInput, labelsPrintedInput, orderCreateInput, orderListQuery, orderQuoteInput, orderUpdateInput, reasonInput } from '@natija/contracts';
import { page, parse } from '../../../core/lib';
import { route } from '../../../core/router';
import { keepTyped, reqText } from '../lenient';
import {
  addItems,
  cancelOrder,
  createOrder,
  formData,
  getOrder,
  listOrders,
  markLabelsPrinted,
  orderActivity,
  orderLabels,
  orderReceipt,
  quoteOrder,
  removeItem,
  updateOrder,
} from './service';

/** Typed fields kept as typed even when the server's schema would refuse them (see ../lenient.ts). */
const HEADER_TYPED = ['referralClinic', 'externalRef', 'clinicalInfo', 'notes'] as const;
const CREATE_TYPED = [...HEADER_TYPED, 'discount.reason', 'payment.reference', 'payment.idempotencyKey'] as const;

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** The reason of a removal or cancellation, as typed. */
function reasonOf(value: unknown): string {
  const raw = { reason: first(value) };
  return reqText(keepTyped(parse(reasonInput, raw), raw, ['reason']).reason);
}

export function registerOrders(): void {
  /** Tests, packages, payers, doctors, payment methods and branches for the reception screen. */
  route('GET', '/orders/form-data', { perm: ['orders.create', 'orders.edit', 'orders.read'] }, () => formData());

  /** Price lines and totals without saving (live at reception, phone quotes). */
  route('POST', '/orders/quote', { perm: ['orders.create', 'orders.read'] }, (req) =>
    quoteOrder(parse(orderQuoteInput, req.body), { canApproveDiscount: req.auth!.permissions.has('finance.approve') }),
  );

  route('POST', '/orders', { perm: 'orders.create' }, (req) =>
    createOrder(keepTyped(parse(orderCreateInput, req.body), req.body, CREATE_TYPED), { canApproveDiscount: req.auth!.permissions.has('finance.approve') }),
  );

  route('GET', '/orders', { perm: 'orders.read' }, (req) => {
    const { items, total } = listOrders(keepTyped(parse(orderListQuery, req.query), req.query, ['q']));
    return page(items, total);
  });

  route('GET', '/orders/:id', { perm: 'orders.read' }, (req) => getOrder(req.params.id!));

  route('PUT', '/orders/:id', { perm: 'orders.edit' }, (req) => updateOrder(req.params.id!, keepTyped(parse(orderUpdateInput, req.body), req.body, HEADER_TYPED)));

  route('POST', '/orders/:id/items', { perm: 'orders.edit' }, (req) => addItems(req.params.id!, parse(addItemsInput, req.body)));

  /** Remove one test before any result exists. The reason comes as ?reason= (or in the body). */
  route('DELETE', '/orders/:id/items/:itemId', { perm: 'orders.edit' }, (req) => {
    const body = (req.body ?? {}) as { reason?: unknown };
    return removeItem(req.params.id!, req.params.itemId!, reasonOf(req.query.reason ?? body.reason));
  });

  route('POST', '/orders/:id/cancel', { perm: 'orders.cancel' }, (req) => cancelOrder(req.params.id!, reasonOf((req.body ?? {}).reason)));

  route('GET', '/orders/:id/labels', { perm: ['samples.collect', 'orders.read'] }, (req) => orderLabels(req.params.id!));

  route('POST', '/orders/:id/labels/printed', { perm: ['samples.collect', 'orders.create', 'orders.edit'] }, (req) =>
    markLabelsPrinted(req.params.id!, parse(labelsPrintedInput, req.body).sampleIds),
  );

  route('GET', '/orders/:id/receipt', { perm: ['orders.read', 'finance.read'] }, (req) => orderReceipt(req.params.id!));

  route('GET', '/orders/:id/activity', { perm: 'orders.read' }, (req) => ({ items: orderActivity(req.params.id!) }));
}

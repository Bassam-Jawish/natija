import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addItemsInput, labelsPrintedInput, orderCreateInput, orderListQuery, orderQuoteInput, orderUpdateInput, reasonInput, uuid } from '@natija/contracts';
import { page, parse } from '../../lib/http';
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

const idParams = z.object({ id: uuid });
const itemParams = z.object({ id: uuid, itemId: uuid });

export default async function orderRoutes(app: FastifyInstance) {
  /** Tests, packages, payers, doctors, payment methods and branches for the reception screen. */
  app.get('/form-data', { config: { perm: ['orders.create', 'orders.edit', 'orders.read'] } }, async () => formData());

  /** Price lines and totals without saving (live at reception, phone quotes). */
  app.post('/quote', { config: { perm: ['orders.create', 'orders.read'] } }, async (req) =>
    quoteOrder(parse(orderQuoteInput, req.body), { canApproveDiscount: req.auth!.permissions.has('finance.approve') }),
  );

  app.post('/', { config: { perm: 'orders.create' } }, async (req, reply) => {
    const created = await createOrder(parse(orderCreateInput, req.body), { canApproveDiscount: req.auth!.permissions.has('finance.approve') });
    return reply.status(201).send(created);
  });

  app.get('/', { config: { perm: 'orders.read' } }, async (req) => {
    const { items, total } = await listOrders(parse(orderListQuery, req.query));
    return page(items, total);
  });

  app.get('/:id', { config: { perm: 'orders.read' } }, async (req) => getOrder(parse(idParams, req.params).id));

  app.put('/:id', { config: { perm: 'orders.edit' } }, async (req) => updateOrder(parse(idParams, req.params).id, parse(orderUpdateInput, req.body)));

  app.post('/:id/items', { config: { perm: 'orders.edit' } }, async (req) => addItems(parse(idParams, req.params).id, parse(addItemsInput, req.body)));

  /** Remove one test before any result exists. The reason comes as ?reason= (or in the body). */
  app.delete('/:id/items/:itemId', { config: { perm: 'orders.edit' } }, async (req) => {
    const { id, itemId } = parse(itemParams, req.params);
    const q = (req.query ?? {}) as Record<string, unknown>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { reason } = parse(reasonInput, { reason: q.reason ?? b.reason });
    return removeItem(id, itemId, reason);
  });

  app.post('/:id/cancel', { config: { perm: 'orders.cancel' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    return cancelOrder(id, parse(reasonInput, req.body).reason);
  });

  app.get('/:id/labels', { config: { perm: ['samples.collect', 'orders.read'] } }, async (req) => orderLabels(parse(idParams, req.params).id));

  app.post('/:id/labels/printed', { config: { perm: ['samples.collect', 'orders.create', 'orders.edit'] } }, async (req) =>
    markLabelsPrinted(parse(idParams, req.params).id, parse(labelsPrintedInput, req.body).sampleIds),
  );

  app.get('/:id/receipt', { config: { perm: ['orders.read', 'finance.read'] } }, async (req) => orderReceipt(parse(idParams, req.params).id));

  app.get('/:id/activity', { config: { perm: 'orders.read' } }, async (req) => ({ items: await orderActivity(parse(idParams, req.params).id) }));
}

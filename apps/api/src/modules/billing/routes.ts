import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { discountInput, paymentInput, uuid } from '@natija/contracts';
import { parse } from '../../lib/http';
import { currentCashSession, getInvoiceDetail, requestDiscount, takePayment } from './service';

const idParams = z.object({ id: uuid });

export default async function billingRoutes(app: FastifyInstance) {
  /** The signed-in user's open cash session, if any (cash payments need one). */
  app.get('/cash-session', { config: { perm: ['finance.payment', 'finance.cash'] } }, async () => {
    const s = await currentCashSession();
    return { cashSession: s ? { id: s.id, openedAt: s.openedAt.toISOString() } : null };
  });

  app.get('/invoices/:id', { config: { perm: ['finance.read', 'orders.read'] } }, async (req) => getInvoiceDetail(parse(idParams, req.params).id));

  /** Take a payment. A repeated idempotency key returns the first payment instead of charging twice. */
  app.post('/payments', { config: { perm: 'finance.payment' } }, async (req, reply) => {
    const result = await takePayment(parse(paymentInput, req.body));
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  /** Desk discount on an invoice: applied at once by approvers, otherwise sent for approval. */
  app.post('/invoices/:id/discount', { config: { perm: ['orders.create', 'orders.edit', 'finance.approve'] } }, async (req) =>
    requestDiscount(parse(idParams, req.params).id, parse(discountInput, req.body), { canApprove: req.auth!.permissions.has('finance.approve') }),
  );
}

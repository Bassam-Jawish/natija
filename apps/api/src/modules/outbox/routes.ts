import type { FastifyInstance } from 'fastify';
import { adminIdParam, adminOutboxQuery } from '@natija/contracts';
import { parse } from '../../lib/http';
import { listOutbox, retryMessage } from './service';

/** Outgoing messages (simulated until an SMS / email provider is connected). */
export default async function outboxRoutes(app: FastifyInstance) {
  app.get('/', { config: { perm: ['settings.manage', 'reports.deliver'] } }, async (req) => listOutbox(parse(adminOutboxQuery, req.query)));
  app.post('/:id/retry', { config: { perm: 'settings.manage' } }, async (req) => retryMessage(parse(adminIdParam, req.params).id));
}

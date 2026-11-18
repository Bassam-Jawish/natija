import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { benchDeliverInput, benchDeliveriesQuery, benchReleaseInput } from '@natija/contracts';
import { forbidden } from '../../lib/errors';
import { parse } from '../../lib/http';
import { createReportLink, deliverReport, getOrderReports, getReport, listDeliveries, releaseReport } from './service';

const orderParam = z.object({ orderId: z.string().uuid() });
const READ = ['reports.print', 'reports.deliver', 'results.read'] as const;

export default async function reportRoutes(app: FastifyInstance) {
  app.get('/deliveries', { config: { perm: 'reports.deliver' } }, async (req) => listDeliveries(parse(benchDeliveriesQuery, req.query)));

  app.get('/orders/:orderId', { config: { perm: [...READ] } }, async (req) => {
    const { orderId } = parse(orderParam, req.params);
    const { version } = parse(z.object({ version: z.coerce.number().int().min(1).optional() }), req.query);
    return getOrderReports(orderId, version);
  });

  /** Release validated results as a new report version (blocked while a critical call is missing). */
  app.post('/orders/:orderId/release', { config: { perm: 'results.validate' } }, async (req) => {
    const { orderId } = parse(orderParam, req.params);
    return releaseReport(orderId, parse(benchReleaseInput, req.body));
  });

  app.post('/orders/:orderId/link', { config: { perm: 'reports.deliver' } }, async (req) => {
    const { orderId } = parse(orderParam, req.params);
    return createReportLink(orderId);
  });

  app.post('/orders/:orderId/deliver', { config: { perm: ['reports.deliver', 'reports.print'] } }, async (req) => {
    const { orderId } = parse(orderParam, req.params);
    const body = parse(benchDeliverInput, req.body);
    if (body.channel !== 'print' && !req.auth!.permissions.has('reports.deliver')) throw forbidden('permission', 'Needs reports.deliver');
    return deliverReport(orderId, body);
  });

  app.get('/:id', { config: { perm: [...READ] } }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return getReport(id);
  });
}

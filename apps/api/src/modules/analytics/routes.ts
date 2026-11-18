import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { adminRangeQuery, ANALYTICS_REPORTS } from '@natija/contracts';
import { forbidden } from '../../lib/errors';
import { parse } from '../../lib/http';
import { referrals } from '../doctors/service';
import { sendWorkbook } from './excel';
import { exportReport } from './export';
import * as svc from './service';

/** Dashboard, management reports and their Excel exports. Money figures need finance.read too. */
export default async function analyticsRoutes(app: FastifyInstance) {
  const perm = { config: { perm: 'analytics.read' as const } };
  const range = async (req: FastifyRequest) => {
    const q = parse(adminRangeQuery, req.query);
    return svc.resolveRange(q.from, q.to);
  };
  const showMoney = (req: FastifyRequest) => req.auth!.permissions.has('finance.read');

  app.get('/dashboard', perm, async (req) => svc.dashboard(await range(req), showMoney(req)));
  app.get('/tat', perm, async (req) => svc.tatReport(await range(req)));
  app.get('/volume', perm, async (req) => svc.volumeReport(await range(req)));
  app.get('/revenue', perm, async (req) => {
    if (!showMoney(req)) throw forbidden('permission', 'Needs finance.read');
    return svc.revenueReport(await range(req));
  });
  app.get('/productivity', perm, async (req) => svc.productivityReport(await range(req)));
  app.get('/rejections', perm, async (req) => svc.rejectionsReport(await range(req)));
  app.get('/instruments', perm, async (req) => svc.instrumentsReport(await range(req)));
  app.get('/doctors', perm, async (req) => {
    const r = await range(req);
    return referrals(r.from, r.to, showMoney(req));
  });

  app.get('/export/:report', perm, async (req, reply) => {
    const { report } = parse(z.object({ report: z.enum(ANALYTICS_REPORTS) }), req.params);
    if (report === 'revenue' && !showMoney(req)) throw forbidden('permission', 'Needs finance.read');
    const q = parse(adminRangeQuery.extend({ lang: z.enum(['ar', 'en']).default('ar') }), req.query);
    const r = await svc.resolveRange(q.from, q.to);
    const { buffer, filename } = await exportReport(report, r, q.lang, showMoney(req));
    return sendWorkbook(reply, buffer, filename);
  });
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { publicReportInfoInput, publicReportLookupInput, publicReportOpenInput } from '@natija/contracts';
import { parse } from '../../lib/http';
import { labBranding, lookupReport, openReportByToken, reportInfo, verifyReport } from './service';

/** No staff session, no lab transaction (it is opened once the lab is known), rate-limited per address. */
const open = (max: number) => ({ public: true, tenant: false, rateLimit: { max, timeWindow: '1 minute' } });
const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? null });

export default async function publicRoutes(app: FastifyInstance) {
  app.post('/report/info', { config: open(30) }, async (req) => reportInfo(parse(publicReportInfoInput, req.body).token));

  app.post('/report/open', { config: open(20) }, async (req) => {
    const body = parse(publicReportOpenInput, req.body);
    return openReportByToken(body.token, body.code, meta(req));
  });

  app.post('/report/lookup', { config: open(10) }, async (req) => {
    const body = parse(publicReportLookupInput, req.body);
    return lookupReport(body.labCode, body.accession, body.code, meta(req));
  });

  app.get('/labs/:code', { config: open(30) }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(40) }), req.params);
    return labBranding(code);
  });

  app.get('/verify/:code', { config: open(30) }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(40) }), req.params);
    return verifyReport(code);
  });
}

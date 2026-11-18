import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminIdParam, adminRangeQuery, DoctorUpsertInput } from '@natija/contracts';
import { parse } from '../../lib/http';
import * as svc from './service';

/** Referring doctors: directory (readable by any signed-in user for order entry) and referral statistics. */
export default async function doctorRoutes(app: FastifyInstance) {
  const manage = { config: { perm: 'doctors.manage' as const } };
  const id = (req: { params: unknown }) => parse(adminIdParam, req.params).id;

  app.get('/', async (req) =>
    svc.listDoctors(parse(z.object({ q: z.string().trim().max(80).optional(), active: z.enum(['true', 'false', 'all']).default('all') }), req.query)),
  );
  app.post('/', manage, async (req) => svc.createDoctor(parse(DoctorUpsertInput, req.body)));
  app.put('/:id', manage, async (req) => svc.updateDoctor(id(req), parse(DoctorUpsertInput, req.body)));
  app.delete('/:id', manage, async (req) => svc.deleteDoctor(id(req)));

  app.get('/referrals', { config: { perm: ['doctors.manage', 'analytics.read'] } }, async (req) => {
    const q = parse(adminRangeQuery, req.query);
    return svc.referrals(q.from, q.to, req.auth!.permissions.has('finance.read'));
  });
}

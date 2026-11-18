import type { FastifyInstance } from 'fastify';
import { adminAuditQuery } from '@natija/contracts';
import { parse } from '../../lib/http';
import { auditCount, auditFacets, listAudit, verifyChain } from './service';

/** The lab's append-only audit log: browse, filter, and check the hash chain. */
export default async function auditRoutes(app: FastifyInstance) {
  const perm = { config: { perm: 'audit.read' as const } };

  app.get('/', perm, async (req) => listAudit(parse(adminAuditQuery, req.query)));

  app.get('/facets', perm, async () => ({ ...(await auditFacets()), count: await auditCount() }));

  app.get('/verify', perm, async () => verifyChain());
}

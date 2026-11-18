import type { FastifyInstance } from 'fastify';
import { worklistQuery } from '@natija/contracts';
import { parse } from '../../lib/http';
import { getWorklist } from './service';

export default async function worklistRoutes(app: FastifyInstance) {
  /** Results to enter or verify, grouped by tube. Restricted users only see their departments. */
  app.get('/', { config: { perm: ['results.enter', 'results.verify'] } }, async (req) => {
    const q = parse(worklistQuery, req.query);
    return getWorklist(q, { departmentIds: req.auth!.user.departmentIds });
  });
}

import type { FastifyInstance } from 'fastify';
import { adminIdParam, StaffRoleInput, StaffRoleUpdateInput, StaffUserCreateInput, StaffUserInput } from '@natija/contracts';
import { parse } from '../../lib/http';
import * as svc from './service';

/** Staff accounts, roles and the permission registry. Everything here needs users.manage. */
export default async function staffRoutes(app: FastifyInstance) {
  const perm = { config: { perm: 'users.manage' as const } };
  const sensitive = { config: { perm: 'users.manage' as const, rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const id = (req: { params: unknown }) => parse(adminIdParam, req.params).id;

  app.get('/users', perm, async () => svc.listUsers());
  /** The response carries a temporary password once; it is never shown again. */
  app.post('/users', sensitive, async (req) => svc.createUser(parse(StaffUserCreateInput, req.body)));
  app.put('/users/:id', perm, async (req) => svc.updateUser(id(req), parse(StaffUserInput, req.body)));
  app.post('/users/:id/disable', perm, async (req) => svc.setUserStatus(id(req), 'disabled'));
  app.post('/users/:id/enable', perm, async (req) => svc.setUserStatus(id(req), 'active'));
  app.post('/users/:id/reset-password', sensitive, async (req) => svc.resetPassword(id(req)));
  app.post('/users/:id/unlock', perm, async (req) => svc.unlockUser(id(req)));

  app.get('/roles', perm, async () => svc.listRoles());
  app.post('/roles', perm, async (req) => svc.createRole(parse(StaffRoleInput, req.body)));
  app.put('/roles/:id', perm, async (req) => svc.updateRole(id(req), parse(StaffRoleUpdateInput, req.body)));
  app.delete('/roles/:id', perm, async (req) => svc.deleteRole(id(req)));

  app.get('/permissions', perm, async () => svc.permissionGroups());
}

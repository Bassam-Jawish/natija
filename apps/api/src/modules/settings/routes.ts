import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adminIdParam,
  SettingsBranchInput,
  SettingsLabInput,
  SettingsLabProfileInput,
  SettingsLogoInput,
  SettingsPaymentMethodInput,
} from '@natija/contracts';
import { parse } from '../../lib/http';
import * as svc from './service';

/**
 * Lab profile and branding, workflow and report settings, payment methods and branches.
 * Payment methods and branches are readable by any signed-in user (desk dropdowns).
 */
export default async function settingsRoutes(app: FastifyInstance) {
  const manage = { config: { perm: 'settings.manage' as const } };
  const id = (req: { params: unknown }) => parse(adminIdParam, req.params).id;

  app.get('/lab', manage, async () => svc.getProfile());
  app.put('/lab', manage, async (req) => svc.updateProfile(parse(SettingsLabProfileInput, req.body)));
  app.put('/lab/settings', manage, async (req) => svc.updateSettings(parse(SettingsLabInput, req.body)));

  /** Sanitise without saving, for the live preview. */
  app.post('/lab/logo/preview', manage, async (req) => svc.previewLogo(parse(SettingsLogoInput, req.body).svg));
  app.put('/lab/logo', manage, async (req) => svc.saveLogo(parse(SettingsLogoInput, req.body).svg));
  app.delete('/lab/logo', manage, async () => svc.removeLogo());

  app.get('/payment-methods', async (req) => svc.listPaymentMethods({ active: parse(z.object({ active: z.enum(['true', 'false']).optional() }), req.query).active === 'true' }));
  app.post('/payment-methods', manage, async (req) => svc.createPaymentMethod(parse(SettingsPaymentMethodInput, req.body)));
  app.put('/payment-methods/:id', manage, async (req) => svc.updatePaymentMethod(id(req), parse(SettingsPaymentMethodInput, req.body)));
  app.delete('/payment-methods/:id', manage, async (req) => svc.deletePaymentMethod(id(req)));

  app.get('/branches', async () => svc.listBranches());
  app.post('/branches', manage, async (req) => svc.createBranch(parse(SettingsBranchInput, req.body)));
  app.put('/branches/:id', manage, async (req) => svc.updateBranch(id(req), parse(SettingsBranchInput, req.body)));
  app.delete('/branches/:id', manage, async (req) => svc.deleteBranch(id(req)));
}

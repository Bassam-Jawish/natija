import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminIdParam, PricingBulkUnitPriceInput, PricingOverrideInput, PricingPayerGroupInput } from '@natija/contracts';
import { asc } from 'drizzle-orm';
import { departments } from '@natija/db';
import { db } from '../../db';
import type { Permission } from '@natija/domain';
import { parse } from '../../lib/http';
import { getLab } from '../../lib/lab';
import { buildWorkbook, L, sendWorkbook } from '../analytics/excel';
import * as svc from './service';

const priceListQuery = z.object({
  payerGroupId: z.string().uuid().optional(),
  q: z.string().trim().max(80).optional(),
  departmentId: z.string().uuid().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

/**
 * Payer groups (public, insurer plans, client labs), per-test price overrides, the price list
 * and bulk unit-price changes. Payer groups are readable by any signed-in user (order entry).
 */
export default async function pricingRoutes(app: FastifyInstance) {
  const manage = { config: { perm: 'pricing.manage' as const } };
  const readList = { config: { perm: ['pricing.manage', 'finance.read', 'orders.create'] as Permission[] } };
  const id = (req: { params: unknown }) => parse(adminIdParam, req.params).id;

  app.get('/payer-groups', async (req) => svc.listPayerGroups({ active: parse(z.object({ active: z.enum(['true', 'false']).optional() }), req.query).active === 'true' }));
  app.post('/payer-groups', manage, async (req) => svc.createPayerGroup(parse(PricingPayerGroupInput, req.body)));
  app.put('/payer-groups/:id', manage, async (req) => svc.updatePayerGroup(id(req), parse(PricingPayerGroupInput, req.body)));
  app.delete('/payer-groups/:id', manage, async (req) => svc.deletePayerGroup(id(req)));

  app.get('/overrides', manage, async (req) => svc.listOverrides(parse(z.object({ payerGroupId: z.string().uuid().optional() }), req.query).payerGroupId));
  app.put('/overrides', manage, async (req) => svc.upsertOverride(parse(PricingOverrideInput, req.body)));
  app.delete('/overrides/:id', manage, async (req) => svc.deleteOverride(id(req)));

  app.get('/price-list', readList, async (req) => {
    const q = parse(priceListQuery, req.query);
    return svc.priceList({ ...q, includeInactive: q.includeInactive === 'true' });
  });

  app.get('/price-list/export', readList, async (req, reply) => {
    const q = parse(priceListQuery.extend({ lang: z.enum(['ar', 'en']).default('ar') }), req.query);
    const lab = await getLab(req.auth!.labId);
    const list = await svc.priceList({ ...q, includeInactive: q.includeInactive === 'true' });
    const deps = new Map((await db().select().from(departments).orderBy(asc(departments.sortOrder))).map((d) => [d.id, d]));
    const lang = q.lang;
    const nm = (r: { nameAr: string; nameEn: string }) => (lang === 'ar' ? r.nameAr : r.nameEn);
    const buffer = await buildWorkbook(
      [
        {
          name: L(lang, 'Price list', 'لائحة الأسعار'),
          title: `${lang === 'ar' ? lab.nameAr : lab.nameEn} · ${L(lang, 'Price list', 'لائحة الأسعار')}`,
          subtitle: new Date().toISOString().slice(0, 10),
          columns: [
            { header: L(lang, 'Code', 'الرمز'), key: 'code', width: 12 },
            { header: L(lang, 'Test', 'التحليل'), key: 'name', width: 36 },
            { header: L(lang, 'Department', 'القسم'), key: 'department', width: 22 },
            { header: L(lang, 'Units', 'الوحدات'), key: 'units', format: 'decimal', width: 10 },
            ...list.payers.map((p) => ({ header: nm(p), key: p.id, format: 'money' as const, width: 18 })),
          ],
          rows: list.rows.map((r) => ({
            code: r.code,
            name: nm(r),
            department: deps.get(r.departmentId) ? nm(deps.get(r.departmentId)!) : '',
            units: r.units,
            ...Object.fromEntries(list.payers.map((p) => [p.id, r.prices[p.id]?.price ?? null])),
          })),
        },
      ],
      { lang, currency: lab.currency },
    );
    return sendWorkbook(reply, buffer, `natija-price-list-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });

  app.post('/bulk-unit-price', manage, async (req) => svc.bulkUnitPrice(parse(PricingBulkUnitPriceInput, req.body)));
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adminIdParam,
  CatalogAnalyteInput,
  CatalogContainerInput,
  CatalogDepartmentInput,
  CatalogFormulaCheckInput,
  CatalogPackageInput,
  CatalogRangesInput,
  CatalogRejectionReasonInput,
  CatalogSampleTypeInput,
  CatalogTestInput,
} from '@natija/contracts';
import { parse } from '../../lib/http';
import * as svc from './service';

/**
 * Test catalog: departments, specimens, tubes, rejection reasons, tests, analytes,
 * reference ranges and packages. Any signed-in user can read; changes need catalog.manage.
 */
export default async function catalogRoutes(app: FastifyInstance) {
  const manage = { config: { perm: 'catalog.manage' as const } };
  const id = (req: { params: unknown }) => parse(adminIdParam, req.params).id;

  app.get('/lookups', async () => svc.lookups());

  const simple = [
    { path: 'departments', kind: 'department', schema: CatalogDepartmentInput },
    { path: 'sample-types', kind: 'sample_type', schema: CatalogSampleTypeInput },
    { path: 'containers', kind: 'container', schema: CatalogContainerInput },
    { path: 'rejection-reasons', kind: 'rejection_reason', schema: CatalogRejectionReasonInput },
  ] as const;
  for (const s of simple) {
    app.get(`/${s.path}`, async () => {
      const all = await svc.lookups();
      return {
        department: all.departments,
        sample_type: all.sampleTypes,
        container: all.containers,
        rejection_reason: all.rejectionReasons,
      }[s.kind];
    });
    app.post(`/${s.path}`, manage, async (req) => svc.createSimple(s.kind, parse(s.schema, req.body) as never));
    app.put(`/${s.path}/:id`, manage, async (req) => svc.updateSimple(s.kind, id(req), parse(s.schema, req.body) as never));
    app.delete(`/${s.path}/:id`, manage, async (req) => svc.deleteSimple(s.kind, id(req)));
  }

  app.get('/tests', async (req) =>
    svc.listTests(
      parse(
        z.object({ q: z.string().trim().max(80).optional(), departmentId: z.string().uuid().optional(), active: z.enum(['true', 'false', 'all']).default('all') }),
        req.query,
      ),
    ),
  );
  app.get('/tests/:id', async (req) => svc.getTest(id(req)));
  app.post('/tests', manage, async (req) => svc.createTest(parse(CatalogTestInput, req.body)));
  app.put('/tests/:id', manage, async (req) => svc.updateTest(id(req), parse(CatalogTestInput, req.body)));
  app.delete('/tests/:id', manage, async (req) => svc.deleteTest(id(req)));

  app.get('/analytes', async (req) =>
    svc.listAnalytes(
      parse(
        z.object({ q: z.string().trim().max(80).optional(), type: z.enum(['numeric', 'text', 'option', 'calculated']).optional(), testId: z.string().uuid().optional() }),
        req.query,
      ),
    ),
  );
  app.get('/analytes/:id', async (req) => svc.getAnalyte(id(req)));
  app.post('/analytes', manage, async (req) => svc.createAnalyte(parse(CatalogAnalyteInput, req.body)));
  app.put('/analytes/:id', manage, async (req) => svc.updateAnalyte(id(req), parse(CatalogAnalyteInput, req.body)));
  app.delete('/analytes/:id', manage, async (req) => svc.deleteAnalyte(id(req)));

  app.put('/analytes/:id/ranges', manage, async (req) => svc.replaceRanges(id(req), parse(CatalogRangesInput, req.body).rows));
  /** Dry run for the editor: overlap errors, warnings and age gaps without saving. */
  app.post('/analytes/:id/ranges/check', manage, async (req) => svc.previewRanges(id(req), parse(CatalogRangesInput, req.body).rows));

  app.post('/formula/check', manage, async (req) => svc.checkFormula(parse(CatalogFormulaCheckInput, req.body)));

  app.get('/packages', async () => svc.listPackages());
  app.post('/packages', manage, async (req) => svc.createPackage(parse(CatalogPackageInput, req.body)));
  app.put('/packages/:id', manage, async (req) => svc.updatePackage(id(req), parse(CatalogPackageInput, req.body)));
  app.delete('/packages/:id', manage, async (req) => svc.deletePackage(id(req)));
}

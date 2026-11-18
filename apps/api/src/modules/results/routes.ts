import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  benchAmendInput,
  benchCriticalCallInput,
  benchEnterResultInput,
  benchResultBatchInput,
  benchResultIdsInput,
  benchRerunInput,
  benchValidateInput,
  validationQueueQuery,
} from '@natija/contracts';
import { parse } from '../../lib/http';
import {
  amendResult,
  checkSignature,
  enterResult,
  enterResults,
  getOrderResults,
  getResultHistory,
  getValidationQueue,
  recordCriticalCall,
  rerunResult,
  validateResults,
  verifyResults,
} from './service';

const idParam = z.object({ id: z.string().uuid() });
const BENCH = ['results.enter', 'results.verify', 'results.validate'] as const;

export default async function resultRoutes(app: FastifyInstance) {
  const scope = (req: { auth: { user: { departmentIds: string[] } } | null }) => ({ departmentIds: req.auth!.user.departmentIds });

  app.get('/validation-queue', { config: { perm: 'results.validate' } }, async (req) => ({
    items: await getValidationQueue(parse(validationQueueQuery, req.query), scope(req)),
  }));

  app.get('/orders/:orderId', { config: { perm: 'results.read' } }, async (req) => {
    const { orderId } = parse(z.object({ orderId: z.string().uuid() }), req.params);
    return getOrderResults(orderId);
  });

  app.put('/:id', { config: { perm: 'results.enter' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return enterResult(id, parse(benchEnterResultInput, req.body), scope(req));
  });

  app.post('/batch', { config: { perm: 'results.enter' } }, async (req) => ({
    items: await enterResults(parse(benchResultBatchInput, req.body).entries, scope(req)),
  }));

  app.post('/verify', { config: { perm: 'results.verify' } }, async (req) => verifyResults(parse(benchResultIdsInput, req.body).resultIds, scope(req)));

  /** Medical validation, e-signed with the user's password. */
  app.post('/validate', { config: { perm: 'results.validate', rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(benchValidateInput, req.body);
    await checkSignature(body.password);
    return validateResults(body.resultIds, scope(req));
  });

  app.post('/:id/rerun', { config: { perm: [...BENCH] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return rerunResult(id, parse(benchRerunInput, req.body).reason, scope(req));
  });

  app.post('/:id/critical-call', { config: { perm: [...BENCH] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return recordCriticalCall(id, parse(benchCriticalCallInput, req.body));
  });

  /** Amendment of a released result, e-signed; re-releases the report as a new version. */
  app.post('/:id/amend', { config: { perm: 'results.amend', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(benchAmendInput, req.body);
    await checkSignature(body.password);
    return amendResult(id, { value: body.value, reason: body.reason });
  });

  app.get('/:id/history', { config: { perm: 'results.read' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getResultHistory(id);
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  benchCollectInput,
  benchDisposeInput,
  benchReceiveInput,
  benchRejectInput,
  benchSampleListQuery,
  benchStoreInput,
  benchTransferInput,
} from '@natija/contracts';
import { parse } from '../../lib/http';
import {
  collectSamples,
  collectionQueue,
  disposeSample,
  getBenchMeta,
  getSampleByBarcode,
  getSampleEvents,
  listSamples,
  receiveSamples,
  rejectSample,
  storeSample,
  transferSample,
} from './service';

const READ = ['samples.collect', 'samples.receive', 'samples.reject', 'samples.store', 'orders.read', 'results.read'] as const;
const idParam = z.object({ id: z.string().uuid() });

export default async function sampleRoutes(app: FastifyInstance) {
  app.get('/meta', { config: { perm: [...READ, 'results.enter'] } }, async (req) => getBenchMeta(req.auth!.user.departmentIds));

  app.get('/', { config: { perm: [...READ] } }, async (req) => {
    const q = parse(benchSampleListQuery, req.query);
    if (q.view === 'collection') return collectionQueue({ departmentId: q.departmentId, from: q.from, to: q.to, q: q.q, limit: q.limit });
    return listSamples(q);
  });

  app.get('/by-barcode/:barcode', { config: { perm: [...READ] } }, async (req) => {
    const { barcode } = parse(z.object({ barcode: z.string().trim().min(1).max(40) }), req.params);
    return getSampleByBarcode(barcode);
  });

  app.get('/:id/events', { config: { perm: [...READ] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { items: await getSampleEvents(id) };
  });

  app.post('/collect', { config: { perm: 'samples.collect' } }, async (req) => collectSamples(parse(benchCollectInput, req.body)));

  app.post('/receive', { config: { perm: 'samples.receive' } }, async (req) => receiveSamples(parse(benchReceiveInput, req.body).barcodes));

  app.post('/:id/reject', { config: { perm: 'samples.reject' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return rejectSample(id, parse(benchRejectInput, req.body));
  });

  app.post('/:id/transfer', { config: { perm: ['samples.store', 'samples.collect', 'samples.receive'] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return transferSample(id, parse(benchTransferInput, req.body));
  });

  app.post('/:id/store', { config: { perm: 'samples.store' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return storeSample(id, parse(benchStoreInput, req.body));
  });

  app.post('/:id/dispose', { config: { perm: 'samples.store' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return disposeSample(id, parse(benchDisposeInput, req.body));
  });
}

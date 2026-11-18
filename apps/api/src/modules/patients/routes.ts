import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { attachmentQuery, duplicateCheckInput, mergeInput, patientCreateInput, patientListQuery, patientUpdateInput, uuid } from '@natija/contracts';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { page, parse } from '../../lib/http';
import {
  attachmentFile,
  createPatient,
  deleteAttachment,
  findDuplicates,
  getPatient,
  listAttachments,
  listPatients,
  mergePatients,
  patientHistory,
  saveAttachment,
  updatePatient,
} from './service';

const idParams = z.object({ id: uuid });
const attachmentParams = z.object({ id: uuid, attachmentId: uuid });

export default async function patientRoutes(app: FastifyInstance) {
  app.get('/', { config: { perm: 'patients.read' } }, async (req) => {
    const { items, total } = await listPatients(parse(patientListQuery, req.query));
    return page(items, total);
  });

  app.post('/', { config: { perm: 'patients.write' } }, async (req, reply) => {
    const created = await createPatient(parse(patientCreateInput, req.body));
    return reply.status(201).send(created);
  });

  /** Live duplicate check while a new patient is typed in. */
  app.post('/duplicates', { config: { perm: ['patients.read', 'patients.write'] } }, async (req) => ({
    items: await findDuplicates(parse(duplicateCheckInput, req.body)),
  }));

  app.post('/merge', { config: { perm: 'patients.merge' } }, async (req) => mergePatients(parse(mergeInput, req.body)));

  app.get('/:id', { config: { perm: 'patients.read' } }, async (req) => getPatient(parse(idParams, req.params).id));

  app.put('/:id', { config: { perm: 'patients.write' } }, async (req) => updatePatient(parse(idParams, req.params).id, parse(patientUpdateInput, req.body)));

  app.get('/:id/history', { config: { perm: 'patients.read' } }, async (req) =>
    patientHistory(parse(idParams, req.params).id, { includeResults: req.auth!.permissions.has('results.read') }),
  );

  app.get('/:id/attachments', { config: { perm: 'patients.read' } }, async (req) => ({ items: await listAttachments(parse(idParams, req.params).id) }));

  /** Multipart upload (one file, ≤ 10 MB, images or PDF). `kind` and `orderId` come as query or form fields. */
  app.post('/:id/attachments', { config: { perm: 'patients.write' } }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    if (!req.isMultipart()) throw badRequest('multipart_expected', 'Send the file as multipart/form-data.');
    const file = await req.file();
    if (!file) throw badRequest('file_missing', 'No file in the request.');
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', 'Files can be up to 10 MB.');
      throw err;
    }
    const field = (name: string) => {
      const f = file.fields[name];
      const one = Array.isArray(f) ? f[0] : f;
      return one && 'value' in one ? String(one.value) : undefined;
    };
    const q = (req.query ?? {}) as Record<string, unknown>;
    const opts = parse(attachmentQuery, {
      kind: q.kind ?? field('kind') ?? 'other',
      orderId: q.orderId ?? field('orderId') ?? undefined,
    });
    const row = await saveAttachment(id, { fileName: file.filename || 'file', buffer, kind: opts.kind, orderId: opts.orderId ?? null });
    return reply.status(201).send(row);
  });

  /** Download (inline for viewing). The row is found through row-level security before the file is read. */
  app.get('/:id/attachments/:attachmentId', { config: { perm: 'patients.read' } }, async (req, reply) => {
    const { id, attachmentId } = parse(attachmentParams, req.params);
    const { row, path } = await attachmentFile(id, attachmentId);
    const info = await stat(path).catch(() => null);
    if (!info) throw notFound('attachment_missing');
    const download = (req.query as Record<string, unknown> | undefined)?.download === '1';
    return reply
      .header('Content-Type', row.mime)
      .header('Content-Length', String(info.size))
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.fileName)}`)
      .send(createReadStream(path));
  });

  app.delete('/:id/attachments/:attachmentId', { config: { perm: 'patients.write' } }, async (req) => {
    const { id, attachmentId } = parse(attachmentParams, req.params);
    await deleteAttachment(id, attachmentId);
    return { ok: true };
  });
}


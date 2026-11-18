/**
 * Patient routes (port of apps/api/src/modules/patients/routes.ts): the same paths and
 * permissions. The multipart upload arrives as the FormData the web app built (file in `file`,
 * `kind` in the query or the form); downloads come back as a MockFile.
 */
import { attachmentQuery, duplicateCheckInput, mergeInput, patientCreateInput, patientListQuery, patientUpdateInput } from '@natija/contracts';
import { badRequest, notFound } from '../../../core/context';
import { MockFile } from '../../../core/file';
import { page, parse } from '../../../core/lib';
import { route } from '../../../core/router';
import { keepTyped } from '../lenient';
import {
  attachmentFile,
  createPatient,
  dataUrlBytes,
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

/** Typed fields kept as typed even when the server's schema would refuse them (see ../lenient.ts). */
const PATIENT_TYPED = [
  'firstNameAr',
  'fatherNameAr',
  'motherNameAr',
  'lastNameAr',
  'firstNameEn',
  'lastNameEn',
  'phone',
  'email',
  'nationalId',
  'address',
  'notes',
  'birthDate',
  'age',
] as const;
const DUPLICATE_TYPED = ['firstNameAr', 'fatherNameAr', 'lastNameAr', 'phone', 'birthDate', 'age'] as const;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function registerPatients(): void {
  route('GET', '/patients', { perm: 'patients.read' }, (req) => {
    const { items, total } = listPatients(keepTyped(parse(patientListQuery, req.query), req.query, ['q']));
    return page(items, total);
  });

  route('POST', '/patients', { perm: 'patients.write' }, (req) => createPatient(keepTyped(parse(patientCreateInput, req.body), req.body, PATIENT_TYPED)));

  /** Live duplicate check while a new patient is typed in. */
  route('POST', '/patients/duplicates', { perm: ['patients.read', 'patients.write'] }, (req) => ({
    items: findDuplicates(keepTyped(parse(duplicateCheckInput, req.body), req.body, DUPLICATE_TYPED)),
  }));

  route('POST', '/patients/merge', { perm: 'patients.merge' }, (req) => mergePatients(keepTyped(parse(mergeInput, req.body), req.body, ['reason'])));

  route('GET', '/patients/:id', { perm: 'patients.read' }, (req) => getPatient(req.params.id!));

  route('PUT', '/patients/:id', { perm: 'patients.write' }, (req) =>
    updatePatient(req.params.id!, keepTyped(parse(patientUpdateInput, req.body), req.body, PATIENT_TYPED)),
  );

  route('GET', '/patients/:id/history', { perm: 'patients.read' }, (req) =>
    patientHistory(req.params.id!, { includeResults: req.auth!.permissions.has('results.read') }),
  );

  route('GET', '/patients/:id/attachments', { perm: 'patients.read' }, (req) => ({ items: listAttachments(req.params.id!) }));

  /** One file (≤ 10 MB) sent as FormData. `kind` and `orderId` come as query or form fields. */
  route('POST', '/patients/:id/attachments', { perm: 'patients.write' }, async (req) => {
    const form: unknown = req.body;
    if (typeof FormData === 'undefined' || !(form instanceof FormData)) throw badRequest('multipart_expected', 'Send the file as multipart/form-data.');
    let file = form.get('file');
    if (!file || typeof file === 'string') file = [...form.values()].find((v): v is File => typeof v !== 'string') ?? null;
    if (!file || typeof file === 'string') throw badRequest('file_missing', 'No file in the request.');
    const field = (name: string) => {
      const v = form.get(name);
      return typeof v === 'string' ? v : undefined;
    };
    const opts = parse(attachmentQuery, {
      kind: first(req.query.kind) ?? field('kind') ?? 'other',
      orderId: first(req.query.orderId) ?? field('orderId') ?? undefined,
    });
    const buffer = new Uint8Array(await file.arrayBuffer());
    return saveAttachment(req.params.id!, { fileName: file.name || 'file', buffer, kind: opts.kind ?? 'other', orderId: opts.orderId ?? null, mime: file.type || null });
  });

  /** Download (the web app shows previews from the stored data URL directly, see mockFileUrl). */
  route('GET', '/patients/:id/attachments/:attachmentId', { perm: 'patients.read' }, (req) => {
    const { row, dataUrl } = attachmentFile(req.params.id!, req.params.attachmentId!);
    if (!dataUrl) throw notFound('attachment_missing');
    return new MockFile(row.fileName, row.mime, dataUrlBytes(dataUrl));
  });

  route('DELETE', '/patients/:id/attachments/:attachmentId', { perm: 'patients.write' }, (req) => {
    deleteAttachment(req.params.id!, req.params.attachmentId!);
    return { ok: true };
  });
}

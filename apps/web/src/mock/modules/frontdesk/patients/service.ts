/**
 * Patients (port of apps/api/src/modules/patients/service.ts): registration (exact birth date
 * or an age), search, duplicate detection, merging records, cumulative results for trend charts,
 * and attachments (referrals, IDs, old results). Every function runs in the signed-in lab.
 *
 * Mock mode takes whatever is typed: an impossible birth date is brought into range instead of
 * refused (a missing one becomes an estimated adult age), and any file type is kept, as a data
 * URL in the store's files (state.files[storageKey]).
 */
import type { z } from 'zod';
import {
  AGE_UNITS,
  ATTACHMENT_KINDS,
  CONTACT_PREFS,
  SEXES,
  type AnalyteTrend,
  type AttachmentKind,
  type AttachmentRow,
  type DuplicateCandidate,
  type MergeResult,
  type PatientDetail,
  type PatientHistory,
  type PatientListItem,
  type duplicateCheckInput,
  type mergeInput,
  type patientCreateInput,
  type patientListQuery,
  type patientUpdateInput,
} from '@natija/contracts';
import { birthDateFromAge, duplicateScore, joinName, mrnFor, normalizeText } from '@natija/domain';
import { AppError, badRequest, conflict, ctx, notFound, now } from '../../../core/context';
import { by, find, insert, remove, rows, state, update, type Row } from '../../../core/db';
import { audit, dayRange, labToday, nextCounter, publish, slice } from '../../../core/lib';
import { userName } from '../../shared/billing';
import { oneOf, optText, reqText } from '../lenient';
import { listOrders } from '../orders/service';
import { contains, patientSearchCondition, patientSearchText, toSummary } from './search';

export type CreatePatientInput = z.output<typeof patientCreateInput>;
export type UpdatePatientInput = z.output<typeof patientUpdateInput>;
export type PatientListQuery = z.output<typeof patientListQuery>;
export type DuplicateInput = z.output<typeof duplicateCheckInput>;
export type MergePatientsInput = z.output<typeof mergeInput>;

type Patient = Row<'patients'>;
type Birth = { birthDate: string; estimated: boolean };
type AgeLike = { value?: unknown; unit?: unknown } | null | undefined;

/* ------------------------------------------------------------------ helpers */

/** Newest first; rows made in the same instant keep "last made first". */
function newestFirst<T extends { createdAt: Date }>(list: readonly T[]): T[] {
  return [...list].reverse().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The newest order that was not cancelled. */
function lastVisit(patientId: string): string | null {
  let last: Date | null = null;
  for (const o of by('orders', 'patientId', patientId)) if (o.status !== 'cancelled' && (!last || o.createdAt > last)) last = o.createdAt;
  return last ? last.toISOString() : null;
}

function orderCount(patientId: string): number {
  return by('orders', 'patientId', patientId).length;
}

const MIN_BIRTH = '1890-01-01';

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** A calendar day from what was typed: YYYY-MM-DD (an impossible day rolls over), or anything Date reads. */
function readDay(text: string): string | null {
  const s = text.trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return m ? d.toISOString().slice(0, 10) : `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clampDay(day: string, today: string): string {
  return day > today ? today : day < MIN_BIRTH ? MIN_BIRTH : day;
}

/**
 * Birth date from an exact date, or estimated from an age entered at the desk. The server refuses
 * a future or impossible date; mock mode brings it into range instead.
 */
function resolveBirth(input: { birthDate?: string | null; age?: AgeLike }): Birth | null {
  const today = labToday();
  if (input.birthDate) {
    const day = readDay(String(input.birthDate));
    if (day) return { birthDate: clampDay(day, today), estimated: false };
  }
  const age = input.age;
  if (age && typeof age === 'object') {
    const unit = oneOf(age.unit, AGE_UNITS, 'years');
    const value = Math.round(Number(age.value));
    if (Number.isFinite(value)) {
      const max = unit === 'years' ? 130 : unit === 'months' ? 130 * 12 : 130 * 365;
      const at = new Date(`${today}T12:00:00Z`);
      return { birthDate: clampDay(birthDateFromAge(Math.min(Math.max(0, value), max), unit, at), today), estimated: true };
    }
  }
  return null;
}

/** Neither a birth date nor an age came (the server answers 400): an estimated adult age. */
function defaultBirth(): Birth {
  return { birthDate: birthDateFromAge(30, 'years', new Date(`${labToday()}T12:00:00Z`)), estimated: true };
}

function namesOf(p: { firstNameAr: string; fatherNameAr?: string | null; lastNameAr: string; firstNameEn?: string | null; lastNameEn?: string | null }) {
  return {
    fullNameAr: joinName(p.firstNameAr, p.fatherNameAr, p.lastNameAr),
    fullNameEn: joinName(p.firstNameEn, p.lastNameEn) || null,
  };
}

function loadPatient(id: string): Patient {
  const row = find('patients', id);
  if (!row || row.deletedAt) throw notFound('patient_not_found');
  return row;
}

/* ------------------------------------------------------------------ read */

export function getPatient(id: string): PatientDetail {
  const p = loadPatient(id);
  const creator = p.createdBy ? find('users', p.createdBy) : undefined;
  const target = p.mergedIntoId ? find('patients', p.mergedIntoId) : undefined;
  return {
    ...toSummary(p),
    firstNameAr: p.firstNameAr,
    fatherNameAr: p.fatherNameAr,
    motherNameAr: p.motherNameAr,
    lastNameAr: p.lastNameAr,
    firstNameEn: p.firstNameEn,
    lastNameEn: p.lastNameEn,
    contactPref: p.contactPref,
    email: p.email,
    nationalId: p.nationalId,
    address: p.address,
    notes: p.notes,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    createdBy: creator ? { id: creator.id, fullNameAr: creator.fullNameAr, fullNameEn: creator.fullNameEn } : null,
    mergedInto: target ? toSummary(target) : null,
    orderCount: orderCount(p.id),
    lastVisitAt: lastVisit(p.id),
    attachmentCount: by('patientAttachments', 'patientId', p.id).length,
  };
}

export function listPatients(query: PatientListQuery): { items: PatientListItem[]; total: number } {
  let list = rows('patients').filter((p) => !p.mergedIntoId && !p.deletedAt);
  if (query.q) {
    const c = patientSearchCondition(query.q);
    if (c) list = list.filter(c);
  }
  if (query.sex) list = list.filter((p) => p.sex === query.sex);
  if (query.from || query.to) {
    const { start, end } = dayRange(query.from, query.to);
    list = list.filter((p) => p.createdAt >= start && p.createdAt < end);
  }
  return {
    items: slice(newestFirst(list), query).map((p) => ({
      ...toSummary(p),
      contactPref: p.contactPref,
      createdAt: p.createdAt.toISOString(),
      lastVisitAt: lastVisit(p.id),
      orderCount: orderCount(p.id),
    })),
    total: list.length,
  };
}

/* ------------------------------------------------------------------ write */

export function createPatient(input: CreatePatientInput): PatientDetail {
  const { userId } = ctx();
  const birth = resolveBirth(input) ?? defaultBirth();
  const mrn = mrnFor(nextCounter('patient'));
  const given = {
    firstNameAr: reqText(input.firstNameAr),
    fatherNameAr: optText(input.fatherNameAr),
    motherNameAr: optText(input.motherNameAr),
    lastNameAr: reqText(input.lastNameAr),
    firstNameEn: optText(input.firstNameEn),
    lastNameEn: optText(input.lastNameEn),
  };
  const names = namesOf(given);
  const phone = optText(input.phone);
  const nationalId = optText(input.nationalId);
  const sex = oneOf(input.sex, SEXES, 'male');
  const row = insert('patients', {
    mrn,
    ...given,
    ...names,
    searchText: patientSearchText({ ...names, mrn, phone, nationalId }),
    sex,
    birthDate: birth.birthDate,
    birthDateEstimated: birth.estimated,
    phone,
    contactPref: oneOf(input.contactPref, CONTACT_PREFS, 'whatsapp'),
    email: optText(input.email),
    nationalId,
    address: optText(input.address),
    notes: optText(input.notes),
    createdBy: userId,
  });
  audit({
    action: 'patient.create',
    entityType: 'patient',
    entityId: row.id,
    summary: `${mrn} · ${names.fullNameAr}`,
    after: { mrn, fullNameAr: names.fullNameAr, sex, birthDate: birth.birthDate, birthDateEstimated: birth.estimated },
  });
  return getPatient(row.id);
}

const PATIENT_FIELDS = [
  'firstNameAr',
  'fatherNameAr',
  'motherNameAr',
  'lastNameAr',
  'firstNameEn',
  'lastNameEn',
  'sex',
  'phone',
  'contactPref',
  'email',
  'nationalId',
  'address',
  'notes',
] as const;

/** A sent field as stored (text trimmed, blank → null); undefined when it can't be stored. */
function fieldValue(key: (typeof PATIENT_FIELDS)[number], value: unknown): string | null | undefined {
  if (key === 'sex') return (SEXES as readonly unknown[]).includes(value) ? (value as string) : undefined;
  if (key === 'contactPref') return (CONTACT_PREFS as readonly unknown[]).includes(value) ? (value as string) : undefined;
  return optText(value);
}

export function updatePatient(id: string, input: UpdatePatientInput): PatientDetail {
  const current = find('patients', id);
  if (!current || current.deletedAt) throw notFound('patient_not_found');
  if (current.mergedIntoId) throw conflict('patient_merged', 'This record was merged into another patient.');
  const next: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  for (const key of PATIENT_FIELDS) {
    if (input[key] === undefined) continue;
    const value = fieldValue(key, input[key]);
    if (value === undefined) continue;
    if ((key === 'firstNameAr' || key === 'lastNameAr') && !value) continue;
    if ((current[key] ?? null) === value) continue;
    next[key] = value;
    before[key] = current[key];
  }
  const birth = input.birthDate || input.age ? resolveBirth(input) : null;
  if (birth && (birth.birthDate !== current.birthDate || birth.estimated !== current.birthDateEstimated)) {
    next.birthDate = birth.birthDate;
    next.birthDateEstimated = birth.estimated;
    before.birthDate = current.birthDate;
    before.birthDateEstimated = current.birthDateEstimated;
  }
  if (!Object.keys(next).length) return getPatient(id);
  const merged = { ...current, ...next } as Patient;
  const names = namesOf(merged);
  update('patients', current, {
    ...(next as Partial<Patient>),
    ...names,
    searchText: patientSearchText({ ...names, mrn: current.mrn, phone: merged.phone, nationalId: merged.nationalId }),
    updatedAt: now(),
  });
  audit({ action: 'patient.update', entityType: 'patient', entityId: id, summary: `${current.mrn} · ${Object.keys(next).join(', ')}`, before, after: { ...next } });
  return getPatient(id);
}

/* ------------------------------------------------------------------ duplicates & merge */

/** Existing records that look like the same person (score ≥ 60), best first. */
export function findDuplicates(input: DuplicateInput): DuplicateCandidate[] {
  const firstNameAr = reqText(input.firstNameAr);
  const lastNameAr = optText(input.lastNameAr);
  const phone = optText(input.phone);
  const fullNameAr = joinName(firstNameAr, optText(input.fatherNameAr), lastNameAr);
  const birth = input.birthDate || input.age ? resolveBirth(input) : null;
  const first = normalizeText(firstNameAr).split(' ').filter(Boolean)[0];
  const last = normalizeText(lastNameAr ?? '').split(' ').filter(Boolean).pop();
  const digits = (phone ?? '').replace(/\D/g, '');
  const like = (p: Patient, t: string) => contains(p.searchText, t);
  const options: Array<(p: Patient) => boolean> = [];
  if (first && last) options.push((p) => like(p, first) && like(p, last));
  else if (first) options.push((p) => like(p, first));
  if (last && birth) options.push((p) => like(p, last) && p.birthDate === birth.birthDate);
  if (digits.length >= 7) options.push((p) => like(p, digits.slice(-9)));
  if (!options.length) return [];
  const found = rows('patients').filter(
    (p) => !p.mergedIntoId && !p.deletedAt && (!input.excludeId || p.id !== input.excludeId) && options.some((match) => match(p)),
  );
  const me = { fullNameAr, birthDate: birth?.birthDate ?? '', phone };
  return newestFirst(found)
    .slice(0, 300)
    .map((p) => {
      const s = duplicateScore({ ...me, sex: input.sex ?? p.sex }, { fullNameAr: p.fullNameAr, birthDate: p.birthDate, sex: p.sex, phone: p.phone });
      return { ...toSummary(p), score: s.score, reasons: s.reasons, lastVisitAt: lastVisit(p.id) };
    })
    .filter((c) => c.score >= 60)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

const FILLABLE = ['fatherNameAr', 'motherNameAr', 'firstNameEn', 'lastNameEn', 'phone', 'email', 'nationalId', 'address', 'notes'] as const;

/**
 * Merge two records of the same person: orders and attachments move to the target, blanks on
 * the target are filled from the source, and the source is marked as merged (kept for history).
 * Different sex or birth dates more than two years apart need `force`.
 */
export function mergePatients(input: MergePatientsInput): MergeResult {
  if (!input.sourceId || !input.targetId) throw notFound('patient_not_found');
  if (input.sourceId === input.targetId) throw badRequest('merge_same', 'Pick two different records.');
  const source = find('patients', input.sourceId);
  const target = find('patients', input.targetId);
  if (!source || !target || source.deletedAt || target.deletedAt) throw notFound('patient_not_found');
  if (source.mergedIntoId || target.mergedIntoId) throw conflict('patient_merged', 'One of the records was already merged.');
  const mismatch: string[] = [];
  if (source.sex !== target.sex) mismatch.push('sex');
  const gapDays = Math.abs(new Date(`${source.birthDate}T00:00:00Z`).getTime() - new Date(`${target.birthDate}T00:00:00Z`).getTime()) / 86_400_000;
  if (gapDays > 2 * 365.25) mismatch.push('birth');
  if (mismatch.length && !input.force) {
    throw new AppError(409, 'merge_mismatch', 'Sex or birth date differ between the two records.', { mismatch });
  }
  const reason = reqText(input.reason);
  const beforeBoth = { source: toSummary(source), target: toSummary(target) };
  const at = now();

  const moved = by('orders', 'patientId', source.id);
  for (const o of moved) update('orders', o, { patientId: target.id, updatedAt: at });
  const movedFiles = by('patientAttachments', 'patientId', source.id);
  for (const a of movedFiles) update('patientAttachments', a, { patientId: target.id });

  const fill: Record<string, unknown> = {};
  for (const key of FILLABLE) if (!target[key] && source[key]) fill[key] = source[key];
  const filled = { ...target, ...fill } as Patient;
  const names = namesOf(filled);
  update('patients', target, {
    ...(fill as Partial<Patient>),
    ...names,
    searchText: patientSearchText({ ...names, mrn: target.mrn, phone: filled.phone, nationalId: filled.nationalId }),
    updatedAt: at,
  });
  update('patients', source, { mergedIntoId: target.id, updatedAt: at });

  const after = { sourceId: source.id, targetId: target.id, movedOrders: moved.length, movedAttachments: movedFiles.length, filled: Object.keys(fill), forced: mismatch, reason };
  audit({
    action: 'patient.merge',
    entityType: 'patient',
    entityId: target.id,
    summary: `${source.mrn} → ${target.mrn} · ${reason}`,
    before: beforeBoth,
    after,
  });
  audit({ action: 'patient.merged_into', entityType: 'patient', entityId: source.id, summary: `${source.mrn} → ${target.mrn} · ${reason}`, after: { ...after } });
  if (moved.length) publish({ type: 'orders.changed', data: { patientId: target.id } });
  return { targetId: target.id, movedOrders: moved.length, movedAttachments: movedFiles.length, filledFields: Object.keys(fill) };
}

/* ------------------------------------------------------------------ history */

/** The patient's orders, and validated numeric results per analyte (oldest first) for trend charts. */
export function patientHistory(id: string, opts: { includeResults: boolean }): PatientHistory {
  loadPatient(id);
  const { items } = listOrders({ patientId: id, limit: 200, offset: 0 });
  if (!opts.includeResults) return { orders: items, analytes: [] };
  const visits = by('orders', 'patientId', id)
    .filter((o) => o.status !== 'cancelled')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const byAnalyte = new Map<string, AnalyteTrend & { sortOrder: number }>();
  for (const o of visits) {
    for (const r of by('results', 'orderId', o.id)) {
      if (r.valueNum === null || (r.status !== 'validated' && r.status !== 'released')) continue;
      const a = find('analytes', r.analyteId);
      if (!a) continue;
      const t = byAnalyte.get(a.id) ?? {
        analyteId: a.id,
        code: a.code,
        nameAr: a.nameAr,
        nameEn: a.nameEn,
        unit: a.unit,
        decimals: a.decimals,
        refLow: null,
        refHigh: null,
        points: [],
        sortOrder: a.sortOrder,
      };
      t.points.push({ orderId: o.id, accession: o.accession, at: o.createdAt.toISOString(), value: r.valueNum, flag: r.flag, isCritical: r.isCritical, status: r.status });
      t.refLow = r.refLow;
      t.refHigh = r.refHigh;
      byAnalyte.set(a.id, t);
    }
  }
  const analytes = [...byAnalyte.values()]
    .sort((a, b) => b.points.length - a.points.length || a.sortOrder - b.sortOrder)
    .map(({ sortOrder, ...t }) => {
      void sortOrder;
      return t;
    });
  return { orders: items, analytes };
}

/* ------------------------------------------------------------------ attachments */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function latin1(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, end));
}

/** Content type from the file's first bytes (images and PDF); null when it is something else. */
export function sniffMime(buf: Uint8Array): string | null {
  if (buf.length >= 5 && latin1(buf, 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && latin1(buf, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(latin1(buf, 0, 6))) return 'image/gif';
  if (buf.length >= 12 && latin1(buf, 0, 4) === 'RIFF' && latin1(buf, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || 'file').slice(0, 200);
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The bytes of a stored file (a base64 data URL). */
export function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function attachmentRow(a: Row<'patientAttachments'>): AttachmentRow {
  return {
    id: a.id,
    patientId: a.patientId,
    orderId: a.orderId,
    kind: a.kind,
    fileName: a.fileName,
    mime: a.mime,
    size: a.size,
    createdAt: a.createdAt.toISOString(),
    uploadedBy: userName(a.uploadedBy),
  };
}

export function listAttachments(patientId: string): AttachmentRow[] {
  loadPatient(patientId);
  return newestFirst(by('patientAttachments', 'patientId', patientId)).map(attachmentRow);
}

export type AttachmentUpload = {
  fileName: string;
  buffer: Uint8Array;
  kind: AttachmentKind;
  orderId?: string | null;
  /** The type the browser gave the file, kept when its bytes are not an image or PDF. */
  mime?: string | null;
};

/** Keep an uploaded file (as a data URL under storage key <labId>/<uuid>) and record it. */
export function saveAttachment(patientId: string, file: AttachmentUpload): AttachmentRow {
  const { labId, userId } = ctx();
  const patient = loadPatient(patientId);
  if (file.orderId) {
    const order = find('orders', file.orderId);
    if (!order || order.patientId !== patientId) throw badRequest('order_not_found', 'The order does not belong to this patient.');
  }
  if (file.buffer.length > MAX_ATTACHMENT_BYTES) throw new AppError(413, 'file_too_large', 'Files can be up to 10 MB.');
  const mime = sniffMime(file.buffer) ?? (file.mime || 'application/octet-stream');
  const kind = oneOf(file.kind, ATTACHMENT_KINDS, 'other');
  const storageKey = `${labId}/${crypto.randomUUID()}`;
  state.files[storageKey] = `data:${mime};base64,${toBase64(file.buffer)}`;
  const row = insert('patientAttachments', {
    patientId,
    orderId: file.orderId ?? null,
    kind,
    fileName: cleanFileName(file.fileName),
    mime,
    size: file.buffer.length,
    storageKey,
    uploadedBy: userId,
  });
  audit({
    action: 'patient.attachment_add',
    entityType: 'patient',
    entityId: patientId,
    summary: `${patient.mrn} · ${row.fileName} (${kind})`,
    after: { attachmentId: row.id, kind, mime, size: file.buffer.length, orderId: file.orderId ?? null },
  });
  return attachmentRow(row);
}

/** An attachment row of this patient and its stored file (a data URL; null if the file is gone). */
export function attachmentFile(patientId: string, attachmentId: string): { row: Row<'patientAttachments'>; dataUrl: string | null } {
  const row = find('patientAttachments', attachmentId);
  if (!row || row.patientId !== patientId) throw notFound('attachment_not_found');
  return { row, dataUrl: state.files[row.storageKey] ?? null };
}

export function deleteAttachment(patientId: string, attachmentId: string): void {
  const { row } = attachmentFile(patientId, attachmentId);
  const patient = loadPatient(patientId);
  remove('patientAttachments', (a) => a.id === row.id);
  delete state.files[row.storageKey];
  audit({
    action: 'patient.attachment_delete',
    entityType: 'patient',
    entityId: patientId,
    summary: `${patient.mrn} · ${row.fileName}`,
    before: { attachmentId: row.id, kind: row.kind, fileName: row.fileName, size: row.size },
  });
}

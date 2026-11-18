/**
 * Patients: registration (exact birth date or an age), search, duplicate detection, merging
 * records, cumulative results for trend charts, and attachments (referrals, IDs, old results).
 * Every function runs inside the current lab context.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { analytes, orders, patientAttachments, patients, results, users, type Patient } from '@natija/db';
import { birthDateFromAge, dateKey, duplicateScore, joinName, mrnFor, normalizeText } from '@natija/domain';
import type {
  AnalyteTrend,
  AttachmentKind,
  AttachmentRow,
  DuplicateCandidate,
  MergeResult,
  PatientDetail,
  PatientHistory,
  PatientListItem,
  duplicateCheckInput,
  mergeInput,
  patientCreateInput,
  patientListQuery,
  patientUpdateInput,
} from '@natija/contracts';
import { config } from '../../config';
import { afterCommit, ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { nextCounter } from '../../lib/counters';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange } from '../../lib/http';
import { getLab } from '../../lib/lab';
import { listOrders } from '../orders/service';
import { escapeLike, patientSearchCondition, patientSearchText, toSummary } from './search';

export type CreatePatientInput = z.output<typeof patientCreateInput>;
export type UpdatePatientInput = z.output<typeof patientUpdateInput>;
export type PatientListQuery = z.output<typeof patientListQuery>;
export type DuplicateInput = z.output<typeof duplicateCheckInput>;
export type MergePatientsInput = z.output<typeof mergeInput>;

/* ------------------------------------------------------------------ helpers */

// Written out in full on purpose: in a single-table select drizzle drops the table name from
// interpolated columns, which would turn `patients.id` into the subquery's own `id`.
const lastVisit = sql`(select max(o.created_at) from orders o where o.patient_id = "patients"."id" and o.status <> 'cancelled')`.mapWith(orders.createdAt);
const orderCount = sql<number>`(select count(*) from orders o where o.patient_id = "patients"."id")`.mapWith(Number);

function isRealDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

async function labToday(): Promise<string> {
  return dateKey(new Date(), (await getLab(ctx().labId)).timezone);
}

/** Birth date from an exact date, or estimated from an age entered at the desk. */
async function resolveBirth(input: { birthDate?: string | null; age?: { value: number; unit: 'years' | 'months' | 'days' } | null }) {
  const today = await labToday();
  if (input.birthDate) {
    if (!isRealDate(input.birthDate) || input.birthDate > today || input.birthDate < '1890-01-01') {
      throw badRequest('validation', 'Invalid birth date.', { birthDate: ['birth_date_invalid'] });
    }
    return { birthDate: input.birthDate, estimated: false };
  }
  if (input.age) return { birthDate: birthDateFromAge(input.age.value, input.age.unit, new Date(`${today}T12:00:00Z`)), estimated: true };
  return null;
}

function namesOf(p: { firstNameAr: string; fatherNameAr?: string | null; lastNameAr: string; firstNameEn?: string | null; lastNameEn?: string | null }) {
  return {
    fullNameAr: joinName(p.firstNameAr, p.fatherNameAr, p.lastNameAr),
    fullNameEn: joinName(p.firstNameEn, p.lastNameEn) || null,
  };
}

async function loadPatient(id: string): Promise<Patient> {
  const [row] = await db().select().from(patients).where(eq(patients.id, id));
  if (!row || row.deletedAt) throw notFound('patient_not_found');
  return row;
}

/* ------------------------------------------------------------------ read */

export async function getPatient(id: string): Promise<PatientDetail> {
  const tx = db();
  const [row] = await tx
    .select({ p: patients, lastVisitAt: lastVisit, orderCount })
    .from(patients)
    .where(eq(patients.id, id));
  if (!row || row.p.deletedAt) throw notFound('patient_not_found');
  const { p } = row;
  const [creator] = p.createdBy ? await tx.select({ id: users.id, fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn }).from(users).where(eq(users.id, p.createdBy)) : [];
  const [target] = p.mergedIntoId ? await tx.select().from(patients).where(eq(patients.id, p.mergedIntoId)) : [];
  const [att] = await tx.select({ n: count() }).from(patientAttachments).where(eq(patientAttachments.patientId, id));
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
    createdBy: creator ?? null,
    mergedInto: target ? toSummary(target) : null,
    orderCount: row.orderCount,
    lastVisitAt: row.lastVisitAt ? (row.lastVisitAt as Date).toISOString() : null,
    attachmentCount: att?.n ?? 0,
  };
}

export async function listPatients(query: PatientListQuery): Promise<{ items: PatientListItem[]; total: number }> {
  const tx = db();
  const conds: SQL[] = [isNull(patients.mergedIntoId), isNull(patients.deletedAt)];
  if (query.q) {
    const c = patientSearchCondition(query.q);
    if (c) conds.push(c);
  }
  if (query.sex) conds.push(eq(patients.sex, query.sex));
  if (query.from || query.to) {
    const { start, end } = await dayRange(query.from, query.to);
    conds.push(gte(patients.createdAt, start), lt(patients.createdAt, end));
  }
  const where = and(...conds);
  const rows = await tx
    .select({ p: patients, lastVisitAt: lastVisit, orderCount })
    .from(patients)
    .where(where)
    .orderBy(desc(patients.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await tx.select({ n: count() }).from(patients).where(where);
  return {
    items: rows.map(({ p, lastVisitAt, orderCount: n }) => ({
      ...toSummary(p),
      contactPref: p.contactPref,
      createdAt: p.createdAt.toISOString(),
      lastVisitAt: lastVisitAt ? (lastVisitAt as Date).toISOString() : null,
      orderCount: n,
    })),
    total: total?.n ?? 0,
  };
}

/* ------------------------------------------------------------------ write */

export async function createPatient(input: CreatePatientInput): Promise<PatientDetail> {
  const { labId, userId } = ctx();
  const birth = await resolveBirth(input);
  if (!birth) throw badRequest('validation', 'Birth date or age is required.', { birthDate: ['birth_date_or_age'] });
  const mrn = mrnFor(await nextCounter('patient'));
  const names = namesOf(input);
  const [row] = await db()
    .insert(patients)
    .values({
      labId,
      mrn,
      firstNameAr: input.firstNameAr,
      fatherNameAr: input.fatherNameAr ?? null,
      motherNameAr: input.motherNameAr ?? null,
      lastNameAr: input.lastNameAr,
      firstNameEn: input.firstNameEn ?? null,
      lastNameEn: input.lastNameEn ?? null,
      ...names,
      searchText: patientSearchText({ ...names, mrn, phone: input.phone, nationalId: input.nationalId }),
      sex: input.sex,
      birthDate: birth.birthDate,
      birthDateEstimated: birth.estimated,
      phone: input.phone ?? null,
      contactPref: input.contactPref,
      email: input.email ?? null,
      nationalId: input.nationalId ?? null,
      address: input.address ?? null,
      notes: input.notes ?? null,
      createdBy: userId,
    })
    .returning();
  await audit({
    action: 'patient.create',
    entityType: 'patient',
    entityId: row!.id,
    summary: `${mrn} · ${names.fullNameAr}`,
    after: { mrn, fullNameAr: names.fullNameAr, sex: input.sex, birthDate: birth.birthDate, birthDateEstimated: birth.estimated },
  });
  return getPatient(row!.id);
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

export async function updatePatient(id: string, input: UpdatePatientInput): Promise<PatientDetail> {
  const tx = db();
  const [current] = await tx.select().from(patients).where(eq(patients.id, id)).for('update');
  if (!current || current.deletedAt) throw notFound('patient_not_found');
  if (current.mergedIntoId) throw conflict('patient_merged', 'This record was merged into another patient.');
  const next: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  for (const key of PATIENT_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    if ((key === 'firstNameAr' || key === 'lastNameAr') && !value) continue;
    if ((current[key] ?? null) === (value ?? null)) continue;
    next[key] = value ?? null;
    before[key] = current[key];
  }
  const birth = input.birthDate || input.age ? await resolveBirth(input) : null;
  if (birth && (birth.birthDate !== current.birthDate || birth.estimated !== current.birthDateEstimated)) {
    next.birthDate = birth.birthDate;
    next.birthDateEstimated = birth.estimated;
    before.birthDate = current.birthDate;
    before.birthDateEstimated = current.birthDateEstimated;
  }
  if (!Object.keys(next).length) return getPatient(id);
  const merged = { ...current, ...next } as Patient;
  const names = namesOf(merged);
  await tx
    .update(patients)
    .set({
      ...(next as Partial<Patient>),
      ...names,
      searchText: patientSearchText({ ...names, mrn: current.mrn, phone: merged.phone, nationalId: merged.nationalId }),
      updatedAt: new Date(),
    })
    .where(eq(patients.id, id));
  const after = Object.fromEntries(Object.keys(next).map((k) => [k, next[k]]));
  await audit({ action: 'patient.update', entityType: 'patient', entityId: id, summary: `${current.mrn} · ${Object.keys(next).join(', ')}`, before, after });
  return getPatient(id);
}

/* ------------------------------------------------------------------ duplicates & merge */

/** Existing records that look like the same person (score ≥ 60), best first. */
export async function findDuplicates(input: DuplicateInput): Promise<DuplicateCandidate[]> {
  const tx = db();
  const fullNameAr = joinName(input.firstNameAr, input.fatherNameAr, input.lastNameAr);
  const birth = input.birthDate || input.age ? await resolveBirth(input).catch(() => null) : null;
  const first = normalizeText(input.firstNameAr).split(' ').filter(Boolean)[0];
  const last = normalizeText(input.lastNameAr ?? '').split(' ').filter(Boolean).pop();
  const digits = (input.phone ?? '').replace(/\D/g, '');
  const like = (t: string) => ilike(patients.searchText, `%${escapeLike(t)}%`);
  const options: SQL[] = [];
  if (first && last) options.push(and(like(first), like(last))!);
  else if (first) options.push(like(first));
  if (last && birth) options.push(and(like(last), eq(patients.birthDate, birth.birthDate))!);
  if (digits.length >= 7) options.push(like(digits.slice(-9)));
  if (!options.length) return [];
  const conds: SQL[] = [isNull(patients.mergedIntoId), isNull(patients.deletedAt), or(...options)!];
  if (input.excludeId) conds.push(ne(patients.id, input.excludeId));
  const rows = await tx
    .select({ p: patients, lastVisitAt: lastVisit })
    .from(patients)
    .where(and(...conds))
    .orderBy(desc(patients.createdAt))
    .limit(300);
  const me = { fullNameAr, birthDate: birth?.birthDate ?? '', phone: input.phone ?? null };
  return rows
    .map(({ p, lastVisitAt }) => {
      const s = duplicateScore({ ...me, sex: input.sex ?? p.sex }, { fullNameAr: p.fullNameAr, birthDate: p.birthDate, sex: p.sex, phone: p.phone });
      return { ...toSummary(p), score: s.score, reasons: s.reasons, lastVisitAt: lastVisitAt ? (lastVisitAt as Date).toISOString() : null };
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
export async function mergePatients(input: MergePatientsInput): Promise<MergeResult> {
  const tx = db();
  if (input.sourceId === input.targetId) throw badRequest('merge_same', 'Pick two different records.');
  const locked = await tx
    .select()
    .from(patients)
    .where(inArray(patients.id, [input.sourceId, input.targetId]))
    .orderBy(asc(patients.id))
    .for('update');
  const source = locked.find((p) => p.id === input.sourceId);
  const target = locked.find((p) => p.id === input.targetId);
  if (!source || !target || source.deletedAt || target.deletedAt) throw notFound('patient_not_found');
  if (source.mergedIntoId || target.mergedIntoId) throw conflict('patient_merged', 'One of the records was already merged.');
  const mismatch: string[] = [];
  if (source.sex !== target.sex) mismatch.push('sex');
  const gapDays = Math.abs(new Date(`${source.birthDate}T00:00:00Z`).getTime() - new Date(`${target.birthDate}T00:00:00Z`).getTime()) / 86_400_000;
  if (gapDays > 2 * 365.25) mismatch.push('birth');
  if (mismatch.length && !input.force) {
    throw new AppError(409, 'merge_mismatch', 'Sex or birth date differ between the two records.', { mismatch });
  }

  const moved = await tx.update(orders).set({ patientId: target.id, updatedAt: new Date() }).where(eq(orders.patientId, source.id)).returning({ id: orders.id });
  const movedFiles = await tx
    .update(patientAttachments)
    .set({ patientId: target.id })
    .where(eq(patientAttachments.patientId, source.id))
    .returning({ id: patientAttachments.id });

  const fill: Record<string, unknown> = {};
  for (const key of FILLABLE) if (!target[key] && source[key]) fill[key] = source[key];
  const filled = { ...target, ...fill } as Patient;
  const names = namesOf(filled);
  await tx
    .update(patients)
    .set({
      ...(fill as Partial<Patient>),
      ...names,
      searchText: patientSearchText({ ...names, mrn: target.mrn, phone: filled.phone, nationalId: filled.nationalId }),
      updatedAt: new Date(),
    })
    .where(eq(patients.id, target.id));
  await tx.update(patients).set({ mergedIntoId: target.id, updatedAt: new Date() }).where(eq(patients.id, source.id));

  const after = { sourceId: source.id, targetId: target.id, movedOrders: moved.length, movedAttachments: movedFiles.length, filled: Object.keys(fill), forced: mismatch, reason: input.reason };
  await audit({
    action: 'patient.merge',
    entityType: 'patient',
    entityId: target.id,
    summary: `${source.mrn} → ${target.mrn} · ${input.reason}`,
    before: { source: toSummary(source), target: toSummary(target) },
    after,
  });
  await audit({ action: 'patient.merged_into', entityType: 'patient', entityId: source.id, summary: `${source.mrn} → ${target.mrn} · ${input.reason}`, after });
  if (moved.length) publish({ type: 'orders.changed', data: { patientId: target.id } });
  return { targetId: target.id, movedOrders: moved.length, movedAttachments: movedFiles.length, filledFields: Object.keys(fill) };
}

/* ------------------------------------------------------------------ history */

/** The patient's orders, and validated numeric results per analyte (oldest first) for trend charts. */
export async function patientHistory(id: string, opts: { includeResults: boolean }): Promise<PatientHistory> {
  await loadPatient(id);
  const { items } = await listOrders({ patientId: id, limit: 200, offset: 0 });
  if (!opts.includeResults) return { orders: items, analytes: [] };
  const rows = await db()
    .select({
      analyteId: analytes.id,
      code: analytes.code,
      nameAr: analytes.nameAr,
      nameEn: analytes.nameEn,
      unit: analytes.unit,
      decimals: analytes.decimals,
      sortOrder: analytes.sortOrder,
      value: results.valueNum,
      flag: results.flag,
      isCritical: results.isCritical,
      status: results.status,
      refLow: results.refLow,
      refHigh: results.refHigh,
      orderId: orders.id,
      accession: orders.accession,
      at: orders.createdAt,
    })
    .from(results)
    .innerJoin(orders, eq(orders.id, results.orderId))
    .innerJoin(analytes, eq(analytes.id, results.analyteId))
    .where(
      and(
        eq(orders.patientId, id),
        ne(orders.status, 'cancelled'),
        isNotNull(results.valueNum),
        inArray(results.status, ['validated', 'released']),
      ),
    )
    .orderBy(asc(orders.createdAt));
  const byAnalyte = new Map<string, AnalyteTrend & { sortOrder: number }>();
  for (const r of rows) {
    const t = byAnalyte.get(r.analyteId) ?? {
      analyteId: r.analyteId,
      code: r.code,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      unit: r.unit,
      decimals: r.decimals,
      refLow: null,
      refHigh: null,
      points: [],
      sortOrder: r.sortOrder,
    };
    t.points.push({ orderId: r.orderId, accession: r.accession, at: r.at.toISOString(), value: r.value!, flag: r.flag, isCritical: r.isCritical, status: r.status });
    t.refLow = r.refLow;
    t.refHigh = r.refHigh;
    byAnalyte.set(r.analyteId, t);
  }
  const analyteList = [...byAnalyte.values()]
    .sort((a, b) => b.points.length - a.points.length || a.sortOrder - b.sortOrder)
    .map(({ sortOrder, ...t }) => {
      void sortOrder;
      return t;
    });
  return { orders: items, analytes: analyteList };
}

/* ------------------------------------------------------------------ attachments */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Content type from the file's first bytes: only images and PDF are accepted. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || 'file').slice(0, 200);
}

function storagePath(storageKey: string): string {
  const [labPart, filePart] = storageKey.split('/');
  if (!labPart || !filePart || !/^[0-9a-f-]{36}$/i.test(labPart) || !/^[0-9a-f-]{36}$/i.test(filePart)) throw notFound('attachment_not_found');
  return join(config.storageDir, labPart, filePart);
}

function attachmentRow(a: typeof patientAttachments.$inferSelect, names: Map<string, { fullNameAr: string; fullNameEn: string }>): AttachmentRow {
  return {
    id: a.id,
    patientId: a.patientId,
    orderId: a.orderId,
    kind: a.kind,
    fileName: a.fileName,
    mime: a.mime,
    size: a.size,
    createdAt: a.createdAt.toISOString(),
    uploadedBy: a.uploadedBy ? names.get(a.uploadedBy) ?? null : null,
  };
}

export async function listAttachments(patientId: string): Promise<AttachmentRow[]> {
  await loadPatient(patientId);
  const rows = await db().select().from(patientAttachments).where(eq(patientAttachments.patientId, patientId)).orderBy(desc(patientAttachments.createdAt));
  const ids = [...new Set(rows.map((r) => r.uploadedBy).filter((x): x is string => !!x))];
  const people = ids.length ? await db().select({ id: users.id, fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn }).from(users).where(inArray(users.id, ids)) : [];
  const names = new Map(people.map((u) => [u.id, { fullNameAr: u.fullNameAr, fullNameEn: u.fullNameEn }]));
  return rows.map((r) => attachmentRow(r, names));
}

/** Store an uploaded image or PDF under storage/<labId>/<uuid> and record it. */
export async function saveAttachment(
  patientId: string,
  file: { fileName: string; buffer: Buffer; kind: AttachmentKind; orderId?: string | null },
): Promise<AttachmentRow> {
  const { labId, userId } = ctx();
  const patient = await loadPatient(patientId);
  if (file.orderId) {
    const [order] = await db().select({ id: orders.id }).from(orders).where(and(eq(orders.id, file.orderId), eq(orders.patientId, patientId)));
    if (!order) throw badRequest('order_not_found', 'The order does not belong to this patient.');
  }
  if (!file.buffer.length) throw badRequest('file_empty', 'The file is empty.');
  if (file.buffer.length > MAX_ATTACHMENT_BYTES) throw new AppError(413, 'file_too_large', 'Files can be up to 10 MB.');
  const mime = sniffMime(file.buffer);
  if (!mime) throw new AppError(415, 'file_type_not_allowed', 'Only images (PNG, JPEG, GIF, WebP) and PDF files are accepted.');

  const fileId = randomUUID();
  const storageKey = `${labId}/${fileId}`;
  const path = storagePath(storageKey);
  await mkdir(join(config.storageDir, labId), { recursive: true });
  await writeFile(path, file.buffer, { flag: 'wx' });
  try {
    const [row] = await db()
      .insert(patientAttachments)
      .values({
        labId,
        patientId,
        orderId: file.orderId ?? null,
        kind: file.kind,
        fileName: cleanFileName(file.fileName),
        mime,
        size: file.buffer.length,
        storageKey,
        uploadedBy: userId,
      })
      .returning();
    await audit({
      action: 'patient.attachment_add',
      entityType: 'patient',
      entityId: patientId,
      summary: `${patient.mrn} · ${row!.fileName} (${file.kind})`,
      after: { attachmentId: row!.id, kind: file.kind, mime, size: file.buffer.length, orderId: file.orderId ?? null },
    });
    return (await listAttachments(patientId)).find((a) => a.id === row!.id)!;
  } catch (err) {
    await unlink(path).catch(() => undefined);
    throw err;
  }
}

/** Where an attachment's file is on disk (looked up through row-level security first). */
export async function attachmentFile(patientId: string, attachmentId: string): Promise<{ row: typeof patientAttachments.$inferSelect; path: string }> {
  const [row] = await db()
    .select()
    .from(patientAttachments)
    .where(and(eq(patientAttachments.id, attachmentId), eq(patientAttachments.patientId, patientId)));
  if (!row) throw notFound('attachment_not_found');
  return { row, path: storagePath(row.storageKey) };
}

export async function deleteAttachment(patientId: string, attachmentId: string): Promise<void> {
  const { row, path } = await attachmentFile(patientId, attachmentId);
  const patient = await loadPatient(patientId);
  await db().delete(patientAttachments).where(eq(patientAttachments.id, row.id));
  await audit({
    action: 'patient.attachment_delete',
    entityType: 'patient',
    entityId: patientId,
    summary: `${patient.mrn} · ${row.fileName}`,
    before: { attachmentId: row.id, kind: row.kind, fileName: row.fileName, size: row.size },
  });
  afterCommit(() => unlink(path).catch(() => undefined));
}

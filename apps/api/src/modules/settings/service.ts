import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { branches, cashSessions, labs, orders, paymentMethods, payments, users, type LabSettings } from '@natija/db';
import type {
  SettingsBranch,
  SettingsBranchInput,
  SettingsLabInput,
  SettingsLabProfile,
  SettingsLabProfileInput,
  SettingsLogoResult,
  SettingsPaymentMethod,
  SettingsPaymentMethodInput,
} from '@natija/contracts';
import { afterCommit, ctx, db } from '../../db';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { invalidateLab } from '../../lib/lab';
import { changes, countRows, record } from '../audit/kit';
import { sanitizeSvg, SvgError } from './svg';

type In<T extends z.ZodTypeAny> = z.output<T>;

function labChanged(kind: string) {
  const { labId } = ctx();
  afterCommit(() => invalidateLab(labId));
  publish({ type: 'settings.changed', data: { kind } });
}

const DEFAULT_SETTINGS: LabSettings = {
  segregationOfDuties: true,
  requireCollectionStep: true,
  digits: 'latin',
  defaultLanguage: 'ar',
  reportLanguage: 'bilingual',
  deltaCheckDays: 365,
  showUsd: false,
};

async function loadLab() {
  const [lab] = await db().select().from(labs).where(eq(labs.id, ctx().labId));
  if (!lab) throw notFound();
  return lab;
}

function profileOut(lab: typeof labs.$inferSelect): SettingsLabProfile {
  const s = { ...DEFAULT_SETTINGS, ...(lab.settings ?? {}) };
  return {
    id: lab.id,
    code: lab.code,
    nameAr: lab.nameAr,
    nameEn: lab.nameEn,
    taglineAr: lab.taglineAr,
    taglineEn: lab.taglineEn,
    phone: lab.phone,
    email: lab.email,
    city: lab.city,
    addressAr: lab.addressAr,
    addressEn: lab.addressEn,
    directorNameAr: lab.directorNameAr,
    directorNameEn: lab.directorNameEn,
    directorTitleAr: lab.directorTitleAr,
    directorTitleEn: lab.directorTitleEn,
    brandColor: lab.brandColor,
    currency: lab.currency,
    timezone: lab.timezone,
    logoSvg: lab.logoSvg,
    updatedAt: lab.updatedAt.toISOString(),
    settings: {
      segregationOfDuties: !!s.segregationOfDuties,
      requireCollectionStep: !!s.requireCollectionStep,
      digits: s.digits ?? 'latin',
      defaultLanguage: s.defaultLanguage ?? 'ar',
      reportLanguage: s.reportLanguage ?? 'bilingual',
      reportFooterAr: s.reportFooterAr ?? null,
      reportFooterEn: s.reportFooterEn ?? null,
      deltaCheckDays: s.deltaCheckDays ?? 365,
      showUsd: !!s.showUsd,
      usdRate: s.usdRate ?? null,
      demo: s.demo,
    },
  };
}

export async function getProfile(): Promise<SettingsLabProfile> {
  return profileOut(await loadLab());
}

function assertTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw badRequest('validation', 'Unknown time zone', { timezone: ['invalid_timezone'] });
  }
}

export async function updateProfile(input: In<typeof SettingsLabProfileInput>) {
  assertTimezone(input.timezone);
  const before = await loadLab();
  const fields = { ...input, brandColor: input.brandColor.toUpperCase() };
  await db()
    .update(labs)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(labs.id, ctx().labId));
  const diff = changes(before as Record<string, unknown>, fields as Record<string, unknown>);
  if (diff) await record({ action: 'settings.lab.updated', entityType: 'lab', entityId: before.id, summary: Object.keys(diff.after).join(', '), ...diff });
  labChanged('profile');
  return getProfile();
}

export async function updateSettings(input: In<typeof SettingsLabInput>) {
  if (input.showUsd && !input.usdRate) throw badRequest('validation', 'USD rate required', { usdRate: ['required'] });
  const before = await loadLab();
  const next: LabSettings = {
    ...(before.settings ?? {}),
    segregationOfDuties: input.segregationOfDuties,
    requireCollectionStep: input.requireCollectionStep,
    digits: input.digits,
    defaultLanguage: input.defaultLanguage,
    reportLanguage: input.reportLanguage,
    reportFooterAr: input.reportFooterAr ?? undefined,
    reportFooterEn: input.reportFooterEn ?? undefined,
    deltaCheckDays: input.deltaCheckDays,
    showUsd: input.showUsd,
    usdRate: input.usdRate ?? undefined,
  };
  for (const k of Object.keys(next) as Array<keyof LabSettings>) if (next[k] === undefined) delete next[k];
  await db().update(labs).set({ settings: next, updatedAt: new Date() }).where(eq(labs.id, ctx().labId));
  const diff = changes((before.settings ?? {}) as Record<string, unknown>, next as Record<string, unknown>);
  if (diff) await record({ action: 'settings.lab.settings_updated', entityType: 'lab', entityId: before.id, summary: Object.keys(diff.after).join(', '), ...diff });
  labChanged('settings');
  return getProfile();
}

/* ------------------------------------------------------------------ logo */

function sanitize(svg: string): SettingsLogoResult {
  try {
    return sanitizeSvg(svg);
  } catch (err) {
    if (err instanceof SvgError) throw new AppError(err.code === 'svg_too_large' ? 413 : 400, err.code, err.message);
    throw err;
  }
}

export function previewLogo(svg: string): SettingsLogoResult {
  return sanitize(svg);
}

export async function saveLogo(svg: string): Promise<SettingsLogoResult> {
  const result = sanitize(svg);
  const before = await loadLab();
  await db().update(labs).set({ logoSvg: result.svg, updatedAt: new Date() }).where(eq(labs.id, ctx().labId));
  await record({
    action: 'settings.logo.updated',
    entityType: 'lab',
    entityId: before.id,
    summary: `${result.bytes} bytes${result.removed.length ? `; removed ${result.removed.join(', ')}` : ''}`,
    before: { logoBytes: before.logoSvg ? Buffer.byteLength(before.logoSvg, 'utf8') : 0 },
    after: { logoBytes: result.bytes },
  });
  labChanged('logo');
  return result;
}

export async function removeLogo() {
  const before = await loadLab();
  if (!before.logoSvg) return { ok: true };
  await db().update(labs).set({ logoSvg: null, updatedAt: new Date() }).where(eq(labs.id, ctx().labId));
  await record({ action: 'settings.logo.removed', entityType: 'lab', entityId: before.id });
  labChanged('logo');
  return { ok: true };
}

/* ------------------------------------------------------------------ payment methods */

export async function listPaymentMethods(f: { active?: boolean } = {}): Promise<SettingsPaymentMethod[]> {
  return db()
    .select({
      id: paymentMethods.id,
      code: paymentMethods.code,
      nameAr: paymentMethods.nameAr,
      nameEn: paymentMethods.nameEn,
      isCash: paymentMethods.isCash,
      isActive: paymentMethods.isActive,
      sortOrder: paymentMethods.sortOrder,
      useCount: sql<number>`(select count(*)::int from payments p where p.method_id = "payment_methods"."id")`,
    })
    .from(paymentMethods)
    .where(f.active ? eq(paymentMethods.isActive, true) : undefined)
    .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.code));
}

export async function createPaymentMethod(input: In<typeof SettingsPaymentMethodInput>) {
  const [row] = await db()
    .insert(paymentMethods)
    .values({ labId: ctx().labId, ...input })
    .returning();
  await record({ action: 'settings.payment_method.created', entityType: 'payment_method', entityId: row!.id, summary: row!.code, after: input });
  publish({ type: 'settings.changed', data: { kind: 'payment_method' } });
  return row!;
}

export async function updatePaymentMethod(id: string, input: In<typeof SettingsPaymentMethodInput>) {
  const [before] = await db().select().from(paymentMethods).where(eq(paymentMethods.id, id));
  if (!before) throw notFound();
  if (before.isCash !== input.isCash && (await countRows(payments, eq(payments.methodId, id))) > 0) {
    throw conflict('method_in_use', 'Cash and non-cash cannot be switched once payments exist');
  }
  const [row] = await db().update(paymentMethods).set(input).where(eq(paymentMethods.id, id)).returning();
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) await record({ action: 'settings.payment_method.updated', entityType: 'payment_method', entityId: id, summary: input.code, ...diff });
  publish({ type: 'settings.changed', data: { kind: 'payment_method' } });
  return row!;
}

export async function deletePaymentMethod(id: string) {
  const [before] = await db().select().from(paymentMethods).where(eq(paymentMethods.id, id));
  if (!before) throw notFound();
  if ((await countRows(payments, eq(payments.methodId, id))) > 0) throw conflict('method_in_use', 'Payments use this method; deactivate it instead');
  await db().delete(paymentMethods).where(eq(paymentMethods.id, id));
  await record({ action: 'settings.payment_method.deleted', entityType: 'payment_method', entityId: id, summary: before.code, before });
  publish({ type: 'settings.changed', data: { kind: 'payment_method' } });
  return { ok: true };
}

/* ------------------------------------------------------------------ branches */

export async function listBranches(): Promise<SettingsBranch[]> {
  return db()
    .select({
      id: branches.id,
      code: branches.code,
      nameAr: branches.nameAr,
      nameEn: branches.nameEn,
      addressAr: branches.addressAr,
      addressEn: branches.addressEn,
      phone: branches.phone,
      isMain: branches.isMain,
      orderCount: sql<number>`(select count(*)::int from orders o where o.branch_id = "branches"."id")`,
    })
    .from(branches)
    .orderBy(sql`${branches.isMain} desc`, asc(branches.code));
}

async function setMain(id: string) {
  await db().update(branches).set({ isMain: false }).where(and(ne(branches.id, id), eq(branches.isMain, true)));
}

export async function createBranch(input: In<typeof SettingsBranchInput>) {
  const [row] = await db()
    .insert(branches)
    .values({ labId: ctx().labId, ...input })
    .returning();
  if (input.isMain) await setMain(row!.id);
  await record({ action: 'settings.branch.created', entityType: 'branch', entityId: row!.id, summary: row!.code, after: input });
  publish({ type: 'settings.changed', data: { kind: 'branch' } });
  return row!;
}

export async function updateBranch(id: string, input: In<typeof SettingsBranchInput>) {
  const [before] = await db().select().from(branches).where(eq(branches.id, id));
  if (!before) throw notFound();
  if (before.isMain && !input.isMain) throw conflict('main_branch_required', 'Choose another main branch first');
  const [row] = await db().update(branches).set(input).where(eq(branches.id, id)).returning();
  if (input.isMain) await setMain(id);
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) await record({ action: 'settings.branch.updated', entityType: 'branch', entityId: id, summary: input.code, ...diff });
  publish({ type: 'settings.changed', data: { kind: 'branch' } });
  return row!;
}

export async function deleteBranch(id: string) {
  const [before] = await db().select().from(branches).where(eq(branches.id, id));
  if (!before) throw notFound();
  if (before.isMain) throw conflict('main_branch_required', 'The main branch cannot be deleted');
  const uses =
    (await countRows(orders, eq(orders.branchId, id))) +
    (await countRows(cashSessions, eq(cashSessions.branchId, id))) +
    (await countRows(users, sql`${id}::uuid = any(${users.branchIds})`));
  if (uses > 0) throw conflict('in_use', `Used by ${uses} record(s)`);
  await db().delete(branches).where(eq(branches.id, id));
  await record({ action: 'settings.branch.deleted', entityType: 'branch', entityId: id, summary: before.code, before });
  publish({ type: 'settings.changed', data: { kind: 'branch' } });
  return { ok: true };
}

/**
 * Lab profile and branding, workflow and report settings, payment methods and branches (port of
 * apps/api/src/modules/settings). Payment methods and branches are readable by any signed-in
 * user (desk dropdowns). Logos go through the same SVG sanitiser as on the server (./svg.ts).
 */
import { z } from 'zod';
import type { LabSettings } from '@natija/db/schema';
import {
  SettingsBranchInput,
  SettingsLabInput,
  SettingsLabProfileInput,
  SettingsLogoInput,
  SettingsPaymentMethodInput,
  type SettingsBranch,
  type SettingsLabProfile,
  type SettingsLogoResult,
  type SettingsPaymentMethod,
} from '@natija/contracts';
import { AppError, badRequest, conflict, ctx, notFound, now } from '../../core/context';
import { by, find, insert, remove, rows, update, type Row } from '../../core/db';
import { parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { assertUnique, byteLength, changes, cmp, input, record } from './kit';
import { sanitizeSvg, SvgError } from './svg';

type In<T extends z.ZodTypeAny> = z.output<T>;

/** The server also drops its cached lab profile here; the mock reads the lab row every time. */
function labChanged(kind: string) {
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

function loadLab(): Row<'labs'> {
  const lab = rows('labs').find((l) => l.id === ctx().labId);
  if (!lab) throw notFound();
  return lab;
}

function profileOut(lab: Row<'labs'>): SettingsLabProfile {
  const s: LabSettings = { ...DEFAULT_SETTINGS, ...(lab.settings ?? {}) };
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

export function getProfile(): SettingsLabProfile {
  return profileOut(loadLab());
}

/** An unknown time zone would break every date shown for the lab, so it is still refused. */
function assertTimezone(tz: string | undefined) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw badRequest('validation', 'Unknown time zone', { timezone: ['invalid_timezone'] });
  }
}

export function updateProfile(input: In<typeof SettingsLabProfileInput>): SettingsLabProfile {
  assertTimezone(input.timezone);
  const lab = loadLab();
  const before = { ...lab };
  const fields = { ...input, brandColor: input.brandColor?.toUpperCase() };
  update('labs', lab, { ...fields, updatedAt: now() });
  const diff = changes(before as Record<string, unknown>, fields as Record<string, unknown>);
  if (diff) record({ action: 'settings.lab.updated', entityType: 'lab', entityId: before.id, summary: Object.keys(diff.after).join(', '), ...diff });
  labChanged('profile');
  return getProfile();
}

export function updateSettings(input: In<typeof SettingsLabInput>): SettingsLabProfile {
  if (input.showUsd && !input.usdRate) throw badRequest('validation', 'USD rate required', { usdRate: ['required'] });
  const lab = loadLab();
  const before: LabSettings = { ...(lab.settings ?? {}) };
  const next: LabSettings = {
    ...before,
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
  update('labs', lab, { settings: next, updatedAt: now() });
  const diff = changes(before as Record<string, unknown>, next as Record<string, unknown>);
  if (diff) record({ action: 'settings.lab.settings_updated', entityType: 'lab', entityId: lab.id, summary: Object.keys(diff.after).join(', '), ...diff });
  labChanged('settings');
  return getProfile();
}

/* ------------------------------------------------------------------ logo */

function sanitize(svg: string | undefined): SettingsLogoResult {
  try {
    return sanitizeSvg(svg ?? '');
  } catch (err) {
    if (err instanceof SvgError) throw new AppError(err.code === 'svg_too_large' ? 413 : 400, err.code, err.message);
    throw err;
  }
}

export function previewLogo(svg: string): SettingsLogoResult {
  return sanitize(svg);
}

export function saveLogo(svg: string): SettingsLogoResult {
  const result = sanitize(svg);
  const lab = loadLab();
  const beforeBytes = lab.logoSvg ? byteLength(lab.logoSvg) : 0;
  update('labs', lab, { logoSvg: result.svg, updatedAt: now() });
  record({
    action: 'settings.logo.updated',
    entityType: 'lab',
    entityId: lab.id,
    summary: `${result.bytes} bytes${result.removed.length ? `; removed ${result.removed.join(', ')}` : ''}`,
    before: { logoBytes: beforeBytes },
    after: { logoBytes: result.bytes },
  });
  labChanged('logo');
  return result;
}

export function removeLogo() {
  const lab = loadLab();
  if (!lab.logoSvg) return { ok: true };
  update('labs', lab, { logoSvg: null, updatedAt: now() });
  record({ action: 'settings.logo.removed', entityType: 'lab', entityId: lab.id });
  labChanged('logo');
  return { ok: true };
}

/* ------------------------------------------------------------------ payment methods */

export function listPaymentMethods(f: { active?: boolean } = {}): SettingsPaymentMethod[] {
  const uses = new Map<string, number>();
  for (const p of rows('payments')) uses.set(p.methodId, (uses.get(p.methodId) ?? 0) + 1);
  return rows('paymentMethods')
    .filter((m) => !f.active || m.isActive)
    .sort((a, b) => cmp(a.sortOrder, b.sortOrder) || cmp(a.code, b.code))
    .map((m) => ({
      id: m.id,
      code: m.code,
      nameAr: m.nameAr,
      nameEn: m.nameEn,
      isCash: m.isCash,
      isActive: m.isActive,
      sortOrder: m.sortOrder,
      useCount: uses.get(m.id) ?? 0,
    }));
}

export function createPaymentMethod(input: In<typeof SettingsPaymentMethodInput>): Row<'paymentMethods'> {
  assertUnique('paymentMethods', 'code', input.code, 'payment_methods_code_uq');
  const row = insert('paymentMethods', input);
  record({ action: 'settings.payment_method.created', entityType: 'payment_method', entityId: row.id, summary: row.code, after: input });
  publish({ type: 'settings.changed', data: { kind: 'payment_method' } });
  return row;
}

export function updatePaymentMethod(id: string, input: In<typeof SettingsPaymentMethodInput>): Row<'paymentMethods'> {
  const row = find('paymentMethods', id);
  if (!row) throw notFound();
  if (input.isCash !== undefined && row.isCash !== input.isCash && by('payments', 'methodId', id).length > 0) {
    throw conflict('method_in_use', 'Cash and non-cash cannot be switched once payments exist');
  }
  assertUnique('paymentMethods', 'code', input.code, 'payment_methods_code_uq', id);
  const before = { ...row };
  update('paymentMethods', row, input);
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) record({ action: 'settings.payment_method.updated', entityType: 'payment_method', entityId: id, summary: input.code, ...diff });
  publish({ type: 'settings.changed', data: { kind: 'payment_method' } });
  return row;
}

export function deletePaymentMethod(id: string) {
  const before = find('paymentMethods', id);
  if (!before) throw notFound();
  if (by('payments', 'methodId', id).length > 0) throw conflict('method_in_use', 'Payments use this method; deactivate it instead');
  remove('paymentMethods', (m) => m.id === id);
  record({ action: 'settings.payment_method.deleted', entityType: 'payment_method', entityId: id, summary: before.code, before });
  publish({ type: 'settings.changed', data: { kind: 'payment_method' } });
  return { ok: true };
}

/* ------------------------------------------------------------------ branches */

export function listBranches(): SettingsBranch[] {
  const orders = new Map<string, number>();
  for (const o of rows('orders')) if (o.branchId) orders.set(o.branchId, (orders.get(o.branchId) ?? 0) + 1);
  return [...rows('branches')]
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || cmp(a.code, b.code))
    .map((b) => ({
      id: b.id,
      code: b.code,
      nameAr: b.nameAr,
      nameEn: b.nameEn,
      addressAr: b.addressAr,
      addressEn: b.addressEn,
      phone: b.phone,
      isMain: b.isMain,
      orderCount: orders.get(b.id) ?? 0,
    }));
}

/** Only one main branch: the others stop being main. */
function setMain(id: string): void {
  for (const b of rows('branches')) if (b.id !== id && b.isMain) update('branches', b, { isMain: false });
}

export function createBranch(input: In<typeof SettingsBranchInput>): Row<'branches'> {
  assertUnique('branches', 'code', input.code, 'branches_code_uq');
  const row = insert('branches', input);
  if (input.isMain) setMain(row.id);
  record({ action: 'settings.branch.created', entityType: 'branch', entityId: row.id, summary: row.code, after: input });
  publish({ type: 'settings.changed', data: { kind: 'branch' } });
  return row;
}

export function updateBranch(id: string, input: In<typeof SettingsBranchInput>): Row<'branches'> {
  const row = find('branches', id);
  if (!row) throw notFound();
  if (row.isMain && !input.isMain) throw conflict('main_branch_required', 'Choose another main branch first');
  assertUnique('branches', 'code', input.code, 'branches_code_uq', id);
  const before = { ...row };
  update('branches', row, input);
  if (input.isMain) setMain(id);
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) record({ action: 'settings.branch.updated', entityType: 'branch', entityId: id, summary: input.code, ...diff });
  publish({ type: 'settings.changed', data: { kind: 'branch' } });
  return row;
}

export function deleteBranch(id: string) {
  const before = find('branches', id);
  if (!before) throw notFound();
  if (before.isMain) throw conflict('main_branch_required', 'The main branch cannot be deleted');
  const uses =
    by('orders', 'branchId', id).length +
    rows('cashSessions').filter((s) => s.branchId === id).length +
    rows('users').filter((u) => u.branchIds.includes(id)).length;
  if (uses > 0) throw conflict('in_use', `Used by ${uses} record(s)`);
  remove('branches', (b) => b.id === id);
  record({ action: 'settings.branch.deleted', entityType: 'branch', entityId: id, summary: before.code, before });
  publish({ type: 'settings.changed', data: { kind: 'branch' } });
  return { ok: true };
}

/* ------------------------------------------------------------------ routes */

export function registerSettings(): void {
  const manage = { perm: 'settings.manage' };

  route('GET', '/settings/lab', manage, () => getProfile());
  route('PUT', '/settings/lab', manage, (req) => updateProfile(input(SettingsLabProfileInput, req.body)));
  route('PUT', '/settings/lab/settings', manage, (req) => updateSettings(input(SettingsLabInput, req.body)));

  /** Sanitise without saving, for the live preview. */
  route('POST', '/settings/lab/logo/preview', manage, (req) => previewLogo(input(SettingsLogoInput, req.body).svg));
  route('PUT', '/settings/lab/logo', manage, (req) => saveLogo(input(SettingsLogoInput, req.body).svg));
  route('DELETE', '/settings/lab/logo', manage, () => removeLogo());

  route('GET', '/settings/payment-methods', (req) => listPaymentMethods({ active: parse(z.object({ active: z.enum(['true', 'false']).optional() }), req.query).active === 'true' }));
  route('POST', '/settings/payment-methods', manage, (req) => createPaymentMethod(input(SettingsPaymentMethodInput, req.body)));
  route('PUT', '/settings/payment-methods/:id', manage, (req) => updatePaymentMethod(req.params.id, input(SettingsPaymentMethodInput, req.body)));
  route('DELETE', '/settings/payment-methods/:id', manage, (req) => deletePaymentMethod(req.params.id));

  route('GET', '/settings/branches', () => listBranches());
  route('POST', '/settings/branches', manage, (req) => createBranch(input(SettingsBranchInput, req.body)));
  route('PUT', '/settings/branches/:id', manage, (req) => updateBranch(req.params.id, input(SettingsBranchInput, req.body)));
  route('DELETE', '/settings/branches/:id', manage, (req) => deleteBranch(req.params.id));
}

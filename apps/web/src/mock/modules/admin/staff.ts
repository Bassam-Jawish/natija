/**
 * Staff accounts, roles and the permission registry (port of apps/api/src/modules/staff).
 * Everything here needs users.manage. Passwords have no rules in mock mode and sign-in ignores
 * them, so accounts keep a placeholder hash; the temporary password is shown once, as on the
 * server. The guards stay: nobody disables their own account, and the lab always keeps an
 * active user with users.manage. The server rolls a refused change back in its transaction; the
 * mock checks the guard first instead, so a refused change writes nothing.
 */
import type { z } from 'zod';
import { isPermission, PERMISSIONS } from '@natija/domain';
import {
  StaffRoleInput,
  StaffRoleUpdateInput,
  StaffUserCreateInput,
  StaffUserInput,
  type StaffPermissionGroup,
  type StaffRole,
  type StaffTemporaryPassword,
  type StaffUser,
} from '@natija/contracts';
import { badRequest, conflict, ctx, notFound, now } from '../../core/context';
import { by, find, insert, remove, rows, update, type Row } from '../../core/db';
import { publish } from '../../core/lib';
import { route } from '../../core/router';
import { signOut } from '../auth';
import { assertUnique, changes, cmp, fieldError, input, record } from './kit';

type In<T extends z.ZodTypeAny> = z.output<T>;
const changed = (kind: string) => publish({ type: 'staff.changed', data: { kind } });

/** Stored instead of a password hash: mock sign-in accepts any password. */
const MOCK_PASSWORD_HASH = 'mock';

/* ------------------------------------------------------------------ passwords */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}

/** 12 random characters in three groups, easy to read aloud and type: "Kq7m-3TzP-a9Rw". */
export function temporaryPassword(): string {
  for (;;) {
    const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]!).join('');
    if (/[A-Z]/.test(chars) && /[a-z]/.test(chars) && /[0-9]/.test(chars)) return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
  }
}

/* ------------------------------------------------------------------ users */

function roleIdsOf(userId: string): string[] {
  return by('userRoles', 'userId', userId).map((ur) => ur.roleId);
}

function userOut(u: Row<'users'>): StaffUser {
  return {
    id: u.id,
    username: u.username,
    fullNameAr: u.fullNameAr,
    fullNameEn: u.fullNameEn,
    title: u.title,
    email: u.email,
    phone: u.phone,
    language: u.language ?? null,
    status: u.status,
    departmentIds: u.departmentIds,
    branchIds: u.branchIds,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    lockedUntil: u.lockedUntil && u.lockedUntil > now() ? u.lockedUntil.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    roleIds: roleIdsOf(u.id),
  };
}

export function listUsers(): StaffUser[] {
  return [...rows('users')].sort((a, b) => cmp(a.status, b.status) || cmp(a.fullNameEn, b.fullNameEn)).map(userOut);
}

function getUser(id: string): StaffUser {
  const row = find('users', id);
  if (!row) throw notFound();
  return userOut(row);
}

function validateScope(input: In<typeof StaffUserInput>): void {
  if ([...new Set(input.roleIds ?? [])].some((id) => !find('roles', id))) fieldError('roleIds', 'not_found');
  if ([...new Set(input.departmentIds ?? [])].some((id) => !find('departments', id))) fieldError('departmentIds', 'not_found');
  if ([...new Set(input.branchIds ?? [])].some((id) => !find('branches', id))) fieldError('branchIds', 'not_found');
}

/** A change about to be made, to check the staff-admin guard before writing it. */
type Pending = { status?: Map<string, string>; userRoles?: Map<string, string[]>; rolePermissions?: Map<string, string[]> };

/** Refuse a change that would leave the lab without an active user who can manage staff. */
function assertAdminRemains(pending: Pending = {}): void {
  const canManage = (roleId: string) => {
    const role = find('roles', roleId);
    return !!role && (pending.rolePermissions?.get(roleId) ?? role.permissions).includes('users.manage');
  };
  const remains = rows('users').some(
    (u) => (pending.status?.get(u.id) ?? u.status) === 'active' && (pending.userRoles?.get(u.id) ?? roleIdsOf(u.id)).some(canManage),
  );
  if (!remains) throw conflict('last_admin', 'At least one active user must keep the staff management permission');
}

function setRoles(userId: string, roleIds: string[]): void {
  remove('userRoles', (ur) => ur.userId === userId);
  for (const roleId of new Set(roleIds)) insert('userRoles', { userId, roleId });
}

/**
 * The server revokes a user's sessions after a password reset. The mock has one session, this
 * browser's: it ends when its own user is the one reset (a disabled user's session already ends,
 * since sign-in refuses inactive accounts).
 */
function revokeSessions(userId: string): void {
  if (userId === ctx().userId) signOut();
}

export function createUser(input: In<typeof StaffUserCreateInput>): StaffTemporaryPassword {
  validateScope(input);
  const { roleIds, ...fields } = input;
  const username = (fields.username ?? '').toLowerCase();
  assertUnique('users', 'username', username, 'users_username_uq');
  const password = temporaryPassword();
  const row = insert('users', { ...fields, username, passwordHash: MOCK_PASSWORD_HASH });
  setRoles(row.id, roleIds ?? []);
  record({ action: 'staff.user.created', entityType: 'user', entityId: row.id, summary: username, after: { ...fields, username, roleIds } });
  changed('user');
  return { user: getUser(row.id), temporaryPassword: password };
}

export function updateUser(id: string, input: In<typeof StaffUserInput>): StaffUser {
  const row = find('users', id);
  if (!row) throw notFound();
  validateScope(input);
  const { roleIds, ...fields } = input;
  const beforeRoles = roleIdsOf(id);
  const nextRoles = roleIds ? [...new Set(roleIds)] : beforeRoles;
  const rolesChanged = [...beforeRoles].sort().join(',') !== [...nextRoles].sort().join(',');
  if (rolesChanged) assertAdminRemains({ userRoles: new Map([[id, nextRoles]]) });
  const before = { ...row, roleIds: [...beforeRoles].sort() };
  update('users', row, { ...fields, updatedAt: now() });
  if (rolesChanged) setRoles(id, nextRoles);
  const diff = changes(before as Record<string, unknown>, { ...fields, roleIds: [...nextRoles].sort() } as Record<string, unknown>);
  if (diff) record({ action: 'staff.user.updated', entityType: 'user', entityId: id, summary: before.username, ...diff });
  changed('user');
  return getUser(id);
}

export function setUserStatus(id: string, status: 'active' | 'disabled'): StaffUser {
  const row = find('users', id);
  if (!row) throw notFound();
  if (status === 'disabled' && id === ctx().userId) throw badRequest('cannot_disable_self', 'You cannot disable your own account');
  if (row.status === status) return getUser(id);
  if (status === 'disabled') assertAdminRemains({ status: new Map([[id, status]]) });
  const before = row.status;
  update('users', row, { status, updatedAt: now() });
  record({
    action: status === 'disabled' ? 'staff.user.disabled' : 'staff.user.enabled',
    entityType: 'user',
    entityId: id,
    summary: row.username,
    before: { status: before },
    after: { status },
  });
  changed('user');
  return getUser(id);
}

export function resetPassword(id: string): StaffTemporaryPassword {
  const row = find('users', id);
  if (!row) throw notFound();
  const password = temporaryPassword();
  update('users', row, { passwordHash: MOCK_PASSWORD_HASH, failedAttempts: 0, lockedUntil: null, updatedAt: now() });
  record({ action: 'staff.user.password_reset', entityType: 'user', entityId: id, summary: row.username });
  revokeSessions(id);
  changed('user');
  return { user: getUser(id), temporaryPassword: password };
}

export function unlockUser(id: string): StaffUser {
  const row = find('users', id);
  if (!row) throw notFound();
  update('users', row, { failedAttempts: 0, lockedUntil: null });
  record({ action: 'staff.user.unlocked', entityType: 'user', entityId: id, summary: row.username });
  changed('user');
  return getUser(id);
}

/* ------------------------------------------------------------------ roles */

export function listRoles(): StaffRole[] {
  const counts = new Map<string, number>();
  for (const ur of rows('userRoles')) counts.set(ur.roleId, (counts.get(ur.roleId) ?? 0) + 1);
  return rows('roles')
    .map((r) => ({ id: r.id, key: r.key, nameAr: r.nameAr, nameEn: r.nameEn, permissions: r.permissions, isSystem: r.isSystem, userCount: counts.get(r.id) ?? 0 }))
    .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.nameEn.localeCompare(b.nameEn));
}

/** Known permissions only, unique and sorted (the server refuses unknown ones; mock mode drops them). */
function cleanPermissions(perms: string[]): string[] {
  return [...new Set(perms.filter(isPermission))].sort();
}

function getRole(id: string): StaffRole {
  const found = listRoles().find((r) => r.id === id);
  if (!found) throw notFound();
  return found;
}

export function createRole(input: In<typeof StaffRoleInput>): StaffRole {
  const permissions = cleanPermissions(input.permissions ?? []);
  const key = (input.key ?? '').toLowerCase();
  assertUnique('roles', 'key', key, 'roles_key_uq');
  const row = insert('roles', { key, nameAr: input.nameAr, nameEn: input.nameEn, permissions, isSystem: false });
  record({ action: 'staff.role.created', entityType: 'role', entityId: row.id, summary: key, after: { ...input, key, permissions } });
  changed('role');
  return getRole(row.id);
}

/** System roles can be edited (names and permissions) but not deleted or renamed by key. */
export function updateRole(id: string, input: In<typeof StaffRoleUpdateInput>): StaffRole {
  const row = find('roles', id);
  if (!row) throw notFound();
  const permissions = input.permissions ? cleanPermissions(input.permissions) : row.permissions;
  assertAdminRemains({ rolePermissions: new Map([[id, permissions]]) });
  const before = { ...row };
  update('roles', row, { nameAr: input.nameAr, nameEn: input.nameEn, permissions });
  const added = permissions.filter((p) => !before.permissions.includes(p));
  const removed = before.permissions.filter((p) => !permissions.includes(p));
  const diff = changes(before as Record<string, unknown>, { nameAr: input.nameAr, nameEn: input.nameEn, permissions } as Record<string, unknown>);
  if (diff) {
    record({
      action: 'staff.role.updated',
      entityType: 'role',
      entityId: id,
      summary: `${before.key}${added.length ? ` +${added.join(' +')}` : ''}${removed.length ? ` -${removed.join(' -')}` : ''}`,
      ...diff,
    });
  }
  changed('role');
  return getRole(id);
}

export function deleteRole(id: string) {
  const before = find('roles', id);
  if (!before) throw notFound();
  if (before.isSystem) throw conflict('system_role', 'System roles cannot be deleted');
  const assigned = by('userRoles', 'roleId', id).length;
  if (assigned > 0) throw conflict('role_in_use', `${assigned} user(s) have this role`);
  remove('roles', (r) => r.id === id);
  record({ action: 'staff.role.deleted', entityType: 'role', entityId: id, summary: before.key, before });
  changed('role');
  return { ok: true };
}

/* ------------------------------------------------------------------ permission registry */

const GROUPS: Record<string, { ar: string; en: string }> = {
  patients: { ar: 'المرضى', en: 'Patients' },
  orders: { ar: 'الطلبات', en: 'Orders' },
  samples: { ar: 'العينات', en: 'Samples' },
  results: { ar: 'النتائج', en: 'Results' },
  reports: { ar: 'التقارير', en: 'Reports' },
  finance: { ar: 'المالية', en: 'Finance' },
  settings: { ar: 'الدليل والأسعار والأطباء', en: 'Catalog, prices and doctors' },
  instruments: { ar: 'الأجهزة وضبط الجودة', en: 'Analyzers and QC' },
  admin: { ar: 'الإدارة', en: 'Administration' },
};

export function permissionGroups(): StaffPermissionGroup[] {
  const out = new Map<string, StaffPermissionGroup>();
  for (const [key, p] of Object.entries(PERMISSIONS)) {
    const g = out.get(p.group) ?? { group: p.group, ar: GROUPS[p.group]?.ar ?? p.group, en: GROUPS[p.group]?.en ?? p.group, permissions: [] };
    g.permissions.push({ key, ar: p.ar, en: p.en });
    out.set(p.group, g);
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ routes */

export function registerStaff(): void {
  const perm = { perm: 'users.manage' };

  route('GET', '/staff/users', perm, () => listUsers());
  /** The response carries a temporary password once; it is never shown again. */
  route('POST', '/staff/users', perm, (req) => createUser(input(StaffUserCreateInput, req.body)));
  route('PUT', '/staff/users/:id', perm, (req) => updateUser(req.params.id, input(StaffUserInput, req.body)));
  route('POST', '/staff/users/:id/disable', perm, (req) => setUserStatus(req.params.id, 'disabled'));
  route('POST', '/staff/users/:id/enable', perm, (req) => setUserStatus(req.params.id, 'active'));
  route('POST', '/staff/users/:id/reset-password', perm, (req) => resetPassword(req.params.id));
  route('POST', '/staff/users/:id/unlock', perm, (req) => unlockUser(req.params.id));

  route('GET', '/staff/roles', perm, () => listRoles());
  route('POST', '/staff/roles', perm, (req) => createRole(input(StaffRoleInput, req.body)));
  route('PUT', '/staff/roles/:id', perm, (req) => updateRole(req.params.id, input(StaffRoleUpdateInput, req.body)));
  route('DELETE', '/staff/roles/:id', perm, (req) => deleteRole(req.params.id));

  route('GET', '/staff/permissions', perm, () => permissionGroups());
}

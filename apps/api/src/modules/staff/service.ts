import { randomInt } from 'node:crypto';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { branches, departments, roles, userRoles, users } from '@natija/db';
import { isPermission, PERMISSIONS } from '@natija/domain';
import type { StaffPermissionGroup, StaffRole, StaffRoleInput, StaffRoleUpdateInput, StaffTemporaryPassword, StaffUser, StaffUserCreateInput, StaffUserInput } from '@natija/contracts';
import { afterCommit, ctx, db } from '../../db';
import { invalidateAuthCache, revokeUserSessions } from '../../lib/auth';
import { hashPassword } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { changes, fieldError, record, rowsOf } from '../audit/kit';

type In<T extends z.ZodTypeAny> = z.output<T>;
const changed = (kind: string) => publish({ type: 'staff.changed', data: { kind } });

/* ------------------------------------------------------------------ passwords */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 12 random characters in three groups (about 70 bits), easy to read aloud and type: "Kq7m-3TzP-a9Rw". */
export function temporaryPassword(): string {
  for (;;) {
    const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]!).join('');
    if (/[A-Z]/.test(chars) && /[a-z]/.test(chars) && /[0-9]/.test(chars)) return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
  }
}

/* ------------------------------------------------------------------ users */

const userColumns = {
  id: users.id,
  username: users.username,
  fullNameAr: users.fullNameAr,
  fullNameEn: users.fullNameEn,
  title: users.title,
  email: users.email,
  phone: users.phone,
  language: users.language,
  status: users.status,
  departmentIds: users.departmentIds,
  branchIds: users.branchIds,
  lastLoginAt: users.lastLoginAt,
  lockedUntil: users.lockedUntil,
  createdAt: users.createdAt,
  roleIds: sql<string[]>`coalesce((select array_agg(ur.role_id::text) from user_roles ur where ur.user_id = "users"."id"), '{}'::text[])`,
};

type UserRow = Awaited<ReturnType<typeof selectUsers>>[number];
function selectUsers(id?: string) {
  return db()
    .select(userColumns)
    .from(users)
    .where(id ? eq(users.id, id) : undefined)
    .orderBy(asc(users.status), asc(users.fullNameEn));
}

function userOut(u: UserRow): StaffUser {
  return {
    ...u,
    language: u.language ?? null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function listUsers(): Promise<StaffUser[]> {
  return (await selectUsers()).map(userOut);
}

async function getUser(id: string): Promise<StaffUser> {
  const [row] = await selectUsers(id);
  if (!row) throw notFound();
  return userOut(row);
}

async function validateScope(input: In<typeof StaffUserInput>) {
  const roleIds = [...new Set(input.roleIds)];
  const found = await db().select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds));
  if (found.length !== roleIds.length) fieldError('roleIds', 'not_found');
  if (input.departmentIds.length) {
    const ids = [...new Set(input.departmentIds)];
    const d = await db().select({ id: departments.id }).from(departments).where(inArray(departments.id, ids));
    if (d.length !== ids.length) fieldError('departmentIds', 'not_found');
  }
  if (input.branchIds.length) {
    const ids = [...new Set(input.branchIds)];
    const b = await db().select({ id: branches.id }).from(branches).where(inArray(branches.id, ids));
    if (b.length !== ids.length) fieldError('branchIds', 'not_found');
  }
}

/** Refuse a change that would leave the lab without an active user who can manage staff. */
async function assertAdminRemains() {
  const [row] = await rowsOf<{ n: number }>(sql`
    select count(distinct u.id)::int as n from users u
    join user_roles ur on ur.user_id = u.id
    join roles r on r.id = ur.role_id
    where u.status = 'active' and 'users.manage' = any(r.permissions)`);
  if (!row || row.n === 0) throw conflict('last_admin', 'At least one active user must keep the staff management permission');
}

async function setRoles(userId: string, roleIds: string[]) {
  await db().delete(userRoles).where(eq(userRoles.userId, userId));
  await db()
    .insert(userRoles)
    .values([...new Set(roleIds)].map((roleId) => ({ labId: ctx().labId, userId, roleId })));
}

function refreshAuth(userId?: string, revoke = false) {
  afterCommit(async () => {
    if (revoke && userId) await revokeUserSessions(userId);
    invalidateAuthCache(userId);
  });
}

export async function createUser(input: In<typeof StaffUserCreateInput>): Promise<StaffTemporaryPassword> {
  await validateScope(input);
  const password = temporaryPassword();
  const { roleIds, ...fields } = input;
  const [row] = await db()
    .insert(users)
    .values({ labId: ctx().labId, ...fields, passwordHash: await hashPassword(password) })
    .returning({ id: users.id });
  await setRoles(row!.id, roleIds);
  await record({ action: 'staff.user.created', entityType: 'user', entityId: row!.id, summary: input.username, after: { ...fields, roleIds } });
  changed('user');
  return { user: await getUser(row!.id), temporaryPassword: password };
}

export async function updateUser(id: string, input: In<typeof StaffUserInput>) {
  const [before] = await selectUsers(id);
  if (!before) throw notFound();
  await validateScope(input);
  const { roleIds, ...fields } = input;
  await db()
    .update(users)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(users.id, id));
  const rolesChanged = [...before.roleIds].sort().join(',') !== [...new Set(roleIds)].sort().join(',');
  if (rolesChanged) {
    await setRoles(id, roleIds);
    await assertAdminRemains();
  }
  const diff = changes(
    { ...before, roleIds: [...before.roleIds].sort() } as Record<string, unknown>,
    { ...fields, roleIds: [...new Set(roleIds)].sort() } as Record<string, unknown>,
  );
  if (diff) await record({ action: 'staff.user.updated', entityType: 'user', entityId: id, summary: before.username, ...diff });
  refreshAuth(id);
  changed('user');
  return getUser(id);
}

export async function setUserStatus(id: string, status: 'active' | 'disabled') {
  const [before] = await db().select().from(users).where(eq(users.id, id));
  if (!before) throw notFound();
  if (status === 'disabled' && id === ctx().userId) throw badRequest('cannot_disable_self', 'You cannot disable your own account');
  if (before.status === status) return getUser(id);
  await db().update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, id));
  if (status === 'disabled') await assertAdminRemains();
  await record({
    action: status === 'disabled' ? 'staff.user.disabled' : 'staff.user.enabled',
    entityType: 'user',
    entityId: id,
    summary: before.username,
    before: { status: before.status },
    after: { status },
  });
  refreshAuth(id, status === 'disabled');
  changed('user');
  return getUser(id);
}

export async function resetPassword(id: string): Promise<StaffTemporaryPassword> {
  const [before] = await db().select().from(users).where(eq(users.id, id));
  if (!before) throw notFound();
  const password = temporaryPassword();
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(password), failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(users.id, id));
  await record({ action: 'staff.user.password_reset', entityType: 'user', entityId: id, summary: before.username });
  refreshAuth(id, true);
  changed('user');
  return { user: await getUser(id), temporaryPassword: password };
}

export async function unlockUser(id: string) {
  const [before] = await db().select().from(users).where(eq(users.id, id));
  if (!before) throw notFound();
  await db().update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, id));
  await record({ action: 'staff.user.unlocked', entityType: 'user', entityId: id, summary: before.username });
  changed('user');
  return getUser(id);
}

/* ------------------------------------------------------------------ roles */

export async function listRoles(): Promise<StaffRole[]> {
  return db()
    .select({
      id: roles.id,
      key: roles.key,
      nameAr: roles.nameAr,
      nameEn: roles.nameEn,
      permissions: roles.permissions,
      isSystem: roles.isSystem,
      userCount: sql<number>`(select count(*)::int from user_roles ur where ur.role_id = "roles"."id")`,
    })
    .from(roles)
    .orderBy(asc(roles.isSystem), asc(roles.nameEn))
    .then((rows) => rows.sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.nameEn.localeCompare(b.nameEn)));
}

function cleanPermissions(perms: string[]): string[] {
  const unknown = perms.filter((p) => !isPermission(p));
  if (unknown.length) throw badRequest('validation', 'Unknown permissions', { permissions: unknown.map((p) => `unknown:${p}`) });
  return [...new Set(perms)].sort();
}

async function getRole(id: string): Promise<StaffRole> {
  const found = (await listRoles()).find((r) => r.id === id);
  if (!found) throw notFound();
  return found;
}

export async function createRole(input: In<typeof StaffRoleInput>) {
  const permissions = cleanPermissions(input.permissions);
  const [row] = await db()
    .insert(roles)
    .values({ labId: ctx().labId, key: input.key, nameAr: input.nameAr, nameEn: input.nameEn, permissions, isSystem: false })
    .returning({ id: roles.id });
  await record({ action: 'staff.role.created', entityType: 'role', entityId: row!.id, summary: input.key, after: { ...input, permissions } });
  changed('role');
  return getRole(row!.id);
}

/** System roles can be edited (names and permissions) but not deleted or renamed by key. */
export async function updateRole(id: string, input: In<typeof StaffRoleUpdateInput>) {
  const [before] = await db().select().from(roles).where(eq(roles.id, id));
  if (!before) throw notFound();
  const permissions = cleanPermissions(input.permissions);
  await db().update(roles).set({ nameAr: input.nameAr, nameEn: input.nameEn, permissions }).where(eq(roles.id, id));
  await assertAdminRemains();
  const added = permissions.filter((p) => !before.permissions.includes(p));
  const removed = before.permissions.filter((p) => !permissions.includes(p));
  const diff = changes(before as Record<string, unknown>, { nameAr: input.nameAr, nameEn: input.nameEn, permissions } as Record<string, unknown>);
  if (diff) {
    await record({
      action: 'staff.role.updated',
      entityType: 'role',
      entityId: id,
      summary: `${before.key}${added.length ? ` +${added.join(' +')}` : ''}${removed.length ? ` -${removed.join(' -')}` : ''}`,
      ...diff,
    });
  }
  refreshAuth();
  changed('role');
  return getRole(id);
}

export async function deleteRole(id: string) {
  const [before] = await db().select().from(roles).where(eq(roles.id, id));
  if (!before) throw notFound();
  if (before.isSystem) throw conflict('system_role', 'System roles cannot be deleted');
  const [assigned] = await rowsOf<{ n: number }>(sql`select count(*)::int as n from user_roles where role_id = ${id}`);
  if (assigned && assigned.n > 0) throw conflict('role_in_use', `${assigned.n} user(s) have this role`);
  await db().delete(roles).where(eq(roles.id, id));
  await record({ action: 'staff.role.deleted', entityType: 'role', entityId: id, summary: before.key, before });
  refreshAuth();
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

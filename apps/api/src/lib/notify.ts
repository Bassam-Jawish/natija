import { and, eq, inArray, sql } from 'drizzle-orm';
import { notifications, roles, userRoles, users } from '@natija/db';
import type { Permission } from '@natija/domain';
import { ctx, db } from '../db';
import { publish } from './events';

export type NotificationInput = {
  kind: 'critical' | 'rejection' | 'pending' | 'report_ready' | 'instrument' | 'approval' | 'system';
  severity?: 'info' | 'warning' | 'critical';
  titleAr: string;
  titleEn: string;
  bodyAr?: string | null;
  bodyEn?: string | null;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
};

/** Notify specific users (in-app). Delivered live after commit. */
export async function notifyUsers(userIds: string[], n: NotificationInput): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  const { labId } = ctx();
  const rows = await db()
    .insert(notifications)
    .values(
      ids.map((userId) => ({
        labId,
        userId,
        kind: n.kind,
        severity: n.severity ?? 'info',
        titleAr: n.titleAr,
        titleEn: n.titleEn,
        bodyAr: n.bodyAr ?? null,
        bodyEn: n.bodyEn ?? null,
        link: n.link ?? null,
        entityType: n.entityType ?? null,
        entityId: n.entityId ?? null,
      })),
    )
    .returning();
  publish({ type: 'notification', userIds: ids, data: rows[0] });
}

/** Active users of the current lab who hold a permission. */
export async function usersWithPermission(perm: Permission): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.status, 'active'), sql`${perm} = any(${roles.permissions})`));
  return rows.map((r) => r.id);
}

/** Notify everyone in the lab who holds the permission (e.g. results.validate for criticals). */
export async function notifyPermission(perm: Permission, n: NotificationInput): Promise<void> {
  await notifyUsers(await usersWithPermission(perm), n);
}

export async function notifyPermissions(perms: Permission[], n: NotificationInput): Promise<void> {
  const ids = (await Promise.all(perms.map(usersWithPermission))).flat();
  await notifyUsers(ids, n);
}

export { inArray };

import { and, eq, gt, isNull } from 'drizzle-orm';
import { agents, roles, sessions, userRoles, users } from '@natija/db';
import { config } from '../config';
import { appDb, db, withLab } from '../db';
import type { AgentContext, AuthContext } from '../types';
import { hmac, randomToken, sha256 } from './crypto';

export const SESSION_COOKIE = 'natija_sid';

export async function createSession(userId: string, labId: string, ip: string | null, userAgent: string | null) {
  const token = randomToken(32);
  const [row] = await appDb
    .insert(sessions)
    .values({
      tokenHash: sha256(token),
      userId,
      labId,
      ip,
      userAgent,
      expiresAt: new Date(Date.now() + config.sessionHours * 3_600_000),
    })
    .returning({ id: sessions.id });
  return { token, sessionId: row!.id };
}

export async function revokeSession(sessionId: string) {
  await appDb.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  authCache.delete(sessionId);
}

export async function revokeUserSessions(userId: string) {
  const rows = await appDb
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  rows.forEach((r) => authCache.delete(r.id));
}

/** CSRF token bound to the session; the web app sends it back in the x-csrf-token header. */
export function csrfFor(sessionId: string): string {
  return hmac(`csrf:${sessionId}`);
}

const authCache = new Map<string, { ctx: AuthContext; at: number }>();
const AUTH_TTL_MS = 10_000;

export function invalidateAuthCache(userId?: string) {
  if (!userId) return authCache.clear();
  for (const [key, value] of authCache) if (value.ctx.userId === userId) authCache.delete(key);
}

/** Resolve a session cookie to the signed-in user, their lab and permissions. */
export async function authenticateToken(token: string): Promise<AuthContext | null> {
  const [session] = await appDb
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  if (!session) return null;
  const idleLimit = Date.now() - config.idleMinutes * 60_000;
  if (session.lastSeenAt.getTime() < idleLimit) {
    await revokeSession(session.id);
    return null;
  }
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await appDb.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, session.id));
  }
  const cached = authCache.get(session.id);
  if (cached && Date.now() - cached.at < AUTH_TTL_MS) return cached.ctx;

  const ctx = await withLab(session.labId, { userId: session.userId }, async () => {
    const [user] = await db().select().from(users).where(eq(users.id, session.userId));
    if (!user || user.status !== 'active') return null;
    const roleRows = await db()
      .select({ key: roles.key, permissions: roles.permissions })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, user.id));
    const permissions = new Set(roleRows.flatMap((r) => r.permissions));
    const result: AuthContext = {
      sessionId: session.id,
      userId: user.id,
      labId: session.labId,
      permissions,
      roleKeys: roleRows.map((r) => r.key),
      user: {
        id: user.id,
        username: user.username,
        fullNameAr: user.fullNameAr,
        fullNameEn: user.fullNameEn,
        title: user.title,
        language: user.language ?? null,
        departmentIds: user.departmentIds,
        branchIds: user.branchIds,
      },
    };
    return result;
  });
  if (!ctx) {
    await revokeSession(session.id);
    return null;
  }
  authCache.set(session.id, { ctx, at: Date.now() });
  return ctx;
}

/** Resolve a Lab Agent bearer token. Agents table has no row-level security, by design. */
export async function authenticateAgent(token: string): Promise<AgentContext | null> {
  const [agent] = await appDb
    .select({ id: agents.id, labId: agents.labId, name: agents.name, status: agents.status })
    .from(agents)
    .where(eq(agents.tokenHash, sha256(token)));
  if (!agent || agent.status !== 'active') return null;
  return { agentId: agent.id, labId: agent.labId, name: agent.name };
}

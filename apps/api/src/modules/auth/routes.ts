import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { labs, roles, userRoles, users, type Lab } from '@natija/db';
import type { Me } from '@natija/contracts';
import { config } from '../../config';
import { appDb, db, withLab } from '../../db';
import { audit } from '../../lib/audit';
import {
  authenticateToken,
  createSession,
  csrfFor,
  invalidateAuthCache,
  revokeSession,
  revokeUserSessions,
  SESSION_COOKIE,
} from '../../lib/auth';
import { hashPassword, verifyPassword } from '../../lib/crypto';
import { AppError, badRequest, notFound, unauthorized } from '../../lib/errors';
import { parse } from '../../lib/http';
import { getLab } from '../../lib/lab';
import type { AuthContext } from '../../types';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Natija@2026';

const LoginBody = z.object({
  labCode: z.string().trim().toLowerCase().min(1).max(40),
  username: z.string().trim().toLowerCase().min(1).max(60),
  password: z.string().min(1).max(200),
});

// Compared against when the username doesn't exist, so timing doesn't reveal valid usernames.
let dummyHash: string | null = null;

export async function buildMe(auth: AuthContext, lab: Lab): Promise<Me> {
  const roleRows = await withLab(lab.id, { userId: auth.userId }, () =>
    db()
      .select({ key: roles.key, nameAr: roles.nameAr, nameEn: roles.nameEn })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, auth.userId)),
  );
  return {
    user: auth.user,
    lab: {
      id: lab.id,
      code: lab.code,
      nameAr: lab.nameAr,
      nameEn: lab.nameEn,
      taglineAr: lab.taglineAr,
      taglineEn: lab.taglineEn,
      logoSvg: lab.logoSvg,
      brandColor: lab.brandColor,
      currency: lab.currency,
      timezone: lab.timezone,
      settings: lab.settings as Record<string, unknown>,
    },
    roles: roleRows,
    permissions: [...auth.permissions].sort(),
    csrfToken: csrfFor(auth.sessionId),
  };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post(
    '/login',
    { config: { public: true, tenant: false, rateLimit: { max: config.loginRateLimit, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(LoginBody, req.body);
      const [lab] = await appDb.select().from(labs).where(eq(labs.code, body.labCode));
      if (!lab) throw unauthorized('invalid_credentials');
      if (lab.status !== 'active') throw new AppError(403, 'lab_suspended');

      const outcome = await withLab(lab.id, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null }, async () => {
        const [user] = await db().select().from(users).where(eq(users.username, body.username));
        if (!user) {
          dummyHash ??= await hashPassword('timing-equaliser');
          await verifyPassword(body.password, dummyHash);
          return { error: 'invalid_credentials' as const };
        }
        if (user.status !== 'active') return { error: 'account_disabled' as const };
        if (user.lockedUntil && user.lockedUntil > new Date()) return { error: 'account_locked' as const, until: user.lockedUntil };
        const ok = await verifyPassword(body.password, user.passwordHash);
        if (!ok) {
          const attempts = user.failedAttempts + 1;
          const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
          await db()
            .update(users)
            .set({ failedAttempts: lockedUntil ? 0 : attempts, lockedUntil })
            .where(eq(users.id, user.id));
          await audit({
            action: 'auth.login_failed',
            entityType: 'user',
            entityId: user.id,
            summary: lockedUntil ? 'Locked for 15 minutes after 5 failed attempts' : `Failed attempt ${attempts}`,
            userId: user.id,
            actorName: user.fullNameEn,
          });
          return lockedUntil ? { error: 'account_locked' as const, until: lockedUntil } : { error: 'invalid_credentials' as const };
        }
        await db().update(users).set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
        await audit({ action: 'auth.login', entityType: 'user', entityId: user.id, summary: user.username, userId: user.id, actorName: user.fullNameEn });
        return { user };
      });

      if ('error' in outcome) {
        if (outcome.error === 'account_locked') throw new AppError(423, 'account_locked', outcome.until?.toISOString());
        if (outcome.error === 'account_disabled') throw new AppError(403, 'account_disabled');
        throw unauthorized('invalid_credentials');
      }
      const { token } = await createSession(outcome.user.id, lab.id, req.ip, req.headers['user-agent'] ?? null);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProd,
        path: '/',
        maxAge: config.sessionHours * 3600,
      });
      const auth = await authenticateToken(token);
      return buildMe(auth!, lab);
    },
  );

  app.post('/logout', async (req, reply) => {
    await audit({ action: 'auth.logout', entityType: 'user', entityId: req.auth!.userId });
    await revokeSession(req.auth!.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { config: { tenant: false } }, async (req) => buildMe(req.auth!, await getLab(req.auth!.labId)));

  app.put('/me/language', async (req) => {
    const body = parse(z.object({ language: z.enum(['ar', 'en']) }), req.body);
    await db().update(users).set({ language: body.language, updatedAt: new Date() }).where(eq(users.id, req.auth!.userId));
    invalidateAuthCache(req.auth!.userId);
    return { ok: true };
  });

  app.put('/me/password', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (req) => {
    const body = parse(z.object({ current: z.string().min(1), next: z.string().min(8).max(200) }), req.body);
    const [user] = await db().select().from(users).where(eq(users.id, req.auth!.userId));
    if (!user || !(await verifyPassword(body.current, user.passwordHash))) throw badRequest('wrong_password');
    await db().update(users).set({ passwordHash: await hashPassword(body.next), updatedAt: new Date() }).where(eq(users.id, user.id));
    await audit({ action: 'auth.password_changed', entityType: 'user', entityId: user.id });
    await revokeUserSessions(user.id);
    return { ok: true, signedOut: true };
  });

  /** Demo environment only: the accounts shown on the sign-in page. */
  app.get('/demo-accounts', { config: { public: true, tenant: false } }, async () => {
    if (!config.demoMode) throw notFound();
    const labRows = await appDb.select().from(labs).where(eq(labs.status, 'active'));
    const out = [];
    for (const lab of labRows) {
      const accounts = await withLab(lab.id, {}, async () => {
        const rows = await db()
          .select({ username: users.username, fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn, userId: users.id })
          .from(users)
          .where(eq(users.status, 'active'));
        const ids = rows.map((r) => r.userId);
        const roleRows = ids.length
          ? await db()
              .select({ userId: userRoles.userId, key: roles.key, nameAr: roles.nameAr, nameEn: roles.nameEn })
              .from(userRoles)
              .innerJoin(roles, eq(roles.id, userRoles.roleId))
              .where(inArray(userRoles.userId, ids))
          : [];
        return rows.map((r) => ({
          username: r.username,
          fullNameAr: r.fullNameAr,
          fullNameEn: r.fullNameEn,
          roles: roleRows.filter((x) => x.userId === r.userId).map(({ key, nameAr, nameEn }) => ({ key, nameAr, nameEn })),
        }));
      });
      out.push({
        lab: { code: lab.code, nameAr: lab.nameAr, nameEn: lab.nameEn, brandColor: lab.brandColor, logoSvg: lab.logoSvg, city: lab.city },
        accounts,
      });
    }
    return { password: DEMO_PASSWORD, labs: out };
  });
}

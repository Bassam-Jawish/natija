/**
 * Mock sign-in, current user, notifications and search. Mock mode accepts any lab code, user
 * name and password: an unknown lab code opens the first demo lab, and an unknown user name
 * signs in as the account its name suggests (reception, tech, doctor…) or as the lab owner.
 */
import { z } from 'zod';
import type { Me } from '@natija/contracts';
import { normalizeText } from '@natija/domain';
import { now, withContext, type MockAuth } from '../core/context';
import { by, find, rows, rowsOfLab, update, type Row } from '../core/db';
import { audit, getLab, parse } from '../core/lib';
import { route } from '../core/router';

/* ------------------------------------------------------------------ session */

const SESSION_KEY = 'natija.mock.session';
type Session = { sessionId: string; userId: string; labId: string };
let memorySession: Session | null = null;

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : memorySession;
  } catch {
    return memorySession;
  }
}

function writeSession(session: Session | null): void {
  memorySession = session;
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage refused: the session lives in memory */
  }
}

/** The signed-in user's context, built like the server's authenticateToken(). */
export function authFor(userId: string, labId: string, sessionId = 'mock'): MockAuth | null {
  return withContext({ labId, userId, actorName: null, auth: null }, () => {
    const user = find('users', userId);
    if (!user || user.status !== 'active') return null;
    const roleRows = by('userRoles', 'userId', user.id)
      .map((ur) => find('roles', ur.roleId))
      .filter((r): r is Row<'roles'> => !!r);
    return {
      sessionId,
      userId: user.id,
      labId,
      permissions: new Set(roleRows.flatMap((r) => r.permissions)),
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
  });
}

export function currentAuth(): MockAuth | null {
  const s = readSession();
  if (!s) return null;
  const auth = authFor(s.userId, s.labId, s.sessionId);
  if (!auth) writeSession(null);
  return auth;
}

export function signOut(): void {
  writeSession(null);
}

function buildMe(auth: MockAuth): Me {
  const lab = getLab(auth.labId);
  const roleRows = withContext({ labId: lab.id, userId: auth.userId, actorName: null, auth }, () =>
    by('userRoles', 'userId', auth.userId)
      .map((ur) => find('roles', ur.roleId))
      .filter((r): r is Row<'roles'> => !!r),
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
    roles: roleRows.map((r) => ({ key: r.key, nameAr: r.nameAr, nameEn: r.nameEn })),
    permissions: [...auth.permissions].sort(),
    csrfToken: 'mock',
  };
}

const ROLE_HINTS: Array<[RegExp, string]> = [
  [/rec|desk|front|استقبال/i, 'reception'],
  [/hem/i, 'tech.hem'],
  [/tech|lab|bench|فني/i, 'tech'],
  [/doc|dr|valid|طبيب/i, 'doctor'],
  [/acc|cash|finance|محاسب/i, 'accountant'],
  [/man|admin|مدير/i, 'manager'],
];

function pickUser(labId: string, username: string): Row<'users'> | undefined {
  const users = rowsOfLab('users', labId).filter((u) => u.status === 'active');
  const name = username.trim().toLowerCase();
  const exact = users.find((u) => u.username === name);
  if (exact) return exact;
  for (const [pattern, key] of ROLE_HINTS) {
    if (!pattern.test(name)) continue;
    const hit = users.find((u) => u.username === key);
    if (hit) return hit;
  }
  return users.find((u) => u.username === 'owner') ?? users[0];
}

/* ------------------------------------------------------------------ routes */

export function registerAuth(): void {
  route('POST', '/auth/login', { public: true }, (req) => {
    const body = parse(z.object({ labCode: z.string().optional(), username: z.string().optional(), password: z.string().optional() }), req.body);
    const labs = rows('labs').filter((l) => l.status === 'active');
    const code = (body.labCode ?? '').trim().toLowerCase();
    const lab = labs.find((l) => l.code === code) ?? labs.find((l) => l.code === 'yasmin') ?? labs[0];
    if (!lab) throw new Error('Mock: no labs');
    const user = pickUser(lab.id, body.username ?? '');
    if (!user) throw new Error('Mock: the lab has no users');
    const session: Session = { sessionId: crypto.randomUUID(), userId: user.id, labId: lab.id };
    withContext({ labId: lab.id, userId: user.id, actorName: user.fullNameEn, auth: null }, () => {
      update('users', user, { failedAttempts: 0, lockedUntil: null, lastLoginAt: now() });
      audit({ action: 'auth.login', entityType: 'user', entityId: user.id, summary: user.username, userId: user.id, actorName: user.fullNameEn });
    });
    writeSession(session);
    return buildMe(authFor(user.id, lab.id, session.sessionId)!);
  });

  route('POST', '/auth/logout', (req) => {
    audit({ action: 'auth.logout', entityType: 'user', entityId: req.auth!.userId });
    writeSession(null);
    return { ok: true };
  });

  route('GET', '/auth/me', (req) => buildMe(req.auth!));

  route('PUT', '/auth/me/language', (req) => {
    const body = parse(z.object({ language: z.enum(['ar', 'en']) }), req.body);
    const user = find('users', req.auth!.userId);
    if (user) update('users', user, { language: body.language, updatedAt: now() });
    return { ok: true };
  });

  // Any current password is accepted, and the new one is taken as typed.
  route('PUT', '/auth/me/password', (req) => {
    audit({ action: 'auth.password_changed', entityType: 'user', entityId: req.auth!.userId });
    return { ok: true, signedOut: false };
  });

  route('GET', '/auth/demo-accounts', { public: true }, () => {
    const labs = rows('labs').filter((l) => l.status === 'active');
    return {
      password: 'Natija@2026',
      labs: labs.map((lab) => {
        const users = rowsOfLab('users', lab.id).filter((u) => u.status === 'active');
        const roles = rowsOfLab('roles', lab.id);
        const links = rowsOfLab('userRoles', lab.id);
        return {
          lab: { code: lab.code, nameAr: lab.nameAr, nameEn: lab.nameEn, brandColor: lab.brandColor, logoSvg: lab.logoSvg, city: lab.city },
          accounts: users.map((u) => ({
            username: u.username,
            fullNameAr: u.fullNameAr,
            fullNameEn: u.fullNameEn,
            roles: links
              .filter((l) => l.userId === u.id)
              .map((l) => roles.find((r) => r.id === l.roleId))
              .filter((r): r is Row<'roles'> => !!r)
              .map((r) => ({ key: r.key, nameAr: r.nameAr, nameEn: r.nameEn })),
          })),
        };
      }),
    };
  });

  /* notifications */

  route('GET', '/notifications', (req) => {
    const q = parse(z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    const mine = by('notifications', 'userId', req.auth!.userId);
    const unread = mine.filter((n) => !n.readAt);
    const items = (q.unread ? unread : mine).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, q.limit ?? 30);
    return { items, unread: unread.length };
  });

  route('POST', '/notifications/:id/read', (req) => {
    const n = find('notifications', req.params.id);
    if (n && n.userId === req.auth!.userId && !n.readAt) update('notifications', n, { readAt: now() });
    return { ok: true };
  });

  route('POST', '/notifications/read-all', (req) => {
    for (const n of by('notifications', 'userId', req.auth!.userId)) if (!n.readAt) update('notifications', n, { readAt: now() });
    return { ok: true };
  });

  /* search (command palette and barcode scanners) */

  route('GET', '/search', { perm: ['patients.read', 'orders.read'] }, (req) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return { patients: [], orders: [], samples: [] };
    const term = normalizeText(q);
    const prefix = q.toLowerCase();
    const patients = rows('patients')
      .filter((p) => !p.deletedAt && !p.mergedIntoId && ((p.searchText ?? '').includes(term) || p.mrn.toLowerCase().startsWith(prefix)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 6)
      .map((p) => ({ id: p.id, mrn: p.mrn, fullNameAr: p.fullNameAr, fullNameEn: p.fullNameEn, sex: p.sex, birthDate: p.birthDate, phone: p.phone }));
    const orders = rows('orders')
      .filter((o) => o.accession.toLowerCase().startsWith(prefix))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 6)
      .map((o) => ({ id: o.id, accession: o.accession, status: o.status, createdAt: o.createdAt, patientName: find('patients', o.patientId)?.fullNameAr ?? '' }));
    const samples = rows('samples')
      .filter((s) => s.barcode.toLowerCase().startsWith(prefix))
      .slice(0, 6)
      .map((s) => ({ id: s.id, barcode: s.barcode, status: s.status, orderId: s.orderId }));
    return { patients, orders, samples };
  });
}

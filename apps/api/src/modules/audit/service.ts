import { and, asc, count, desc, eq, gt, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { auditLog, users } from '@natija/db';
import type { AuditChainCheck, AuditLogFacets, AuditLogRow } from '@natija/contracts';
import { db } from '../../db';
import { sha256 } from '../../lib/crypto';
import { dayRange } from '../../lib/http';
import { inSequence } from './kit';

/* ------------------------------------------------------------------ queries */

export type AuditFilters = {
  from?: string;
  to?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  action?: string;
  q?: string;
  limit: number;
  offset: number;
};

export async function listAudit(f: AuditFilters): Promise<{ items: AuditLogRow[]; total: number }> {
  const where: SQL[] = [];
  if (f.from || f.to) {
    const { start, end } = await dayRange(f.from, f.to);
    where.push(gte(auditLog.at, start), lt(auditLog.at, end));
  }
  if (f.entityType) where.push(eq(auditLog.entityType, f.entityType));
  if (f.entityId) where.push(eq(auditLog.entityId, f.entityId));
  if (f.userId) where.push(eq(auditLog.userId, f.userId));
  if (f.action) where.push(f.action.endsWith('*') ? ilike(auditLog.action, `${f.action.slice(0, -1).replace(/[%_]/g, '')}%`) : eq(auditLog.action, f.action));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, '')}%`;
    where.push(or(ilike(auditLog.summary, like), ilike(auditLog.actorName, like), ilike(auditLog.action, like))!);
  }
  const cond = where.length ? and(...where) : undefined;
  const [rows, [total]] = await inSequence([
    () => db().select().from(auditLog).where(cond).orderBy(desc(auditLog.seq)).limit(f.limit).offset(f.offset),
    () => db().select({ n: count() }).from(auditLog).where(cond),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      at: r.at.toISOString(),
      userId: r.userId,
      actorName: r.actorName,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: r.summary,
      before: r.before ?? null,
      after: r.after ?? null,
      ip: r.ip,
      userAgent: r.userAgent,
    })),
    total: total?.n ?? 0,
  };
}

export async function auditFacets(): Promise<AuditLogFacets> {
  const [types, actions, people] = await inSequence([
    () => db().selectDistinct({ v: auditLog.entityType }).from(auditLog).orderBy(asc(auditLog.entityType)),
    () => db().selectDistinct({ v: auditLog.action }).from(auditLog).orderBy(asc(auditLog.action)),
    () => db().select({ id: users.id, fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn }).from(users).orderBy(asc(users.fullNameEn)),
  ]);
  return { entityTypes: types.map((r) => r.v), actions: actions.map((r) => r.v), users: people };
}

/**
 * Walk the lab's audit log in `seq` order and recompute every hash. A row is broken when its
 * stored hash does not match its content, or when it does not point at the previous row's hash
 * (a row was removed or inserted). Reports the first broken link.
 */
export async function verifyChain(): Promise<AuditChainCheck> {
  let prevHash: string | null = null;
  let lastSeq = 0;
  let checked = 0;
  for (;;) {
    const rows = await db().select().from(auditLog).where(gt(auditLog.seq, lastSeq)).orderBy(asc(auditLog.seq)).limit(2000);
    if (!rows.length) break;
    for (const r of rows) {
      const brokenAt = (reason: 'hash_mismatch' | 'chain_break'): AuditChainCheck => ({
        ok: false,
        checked,
        verifiedAt: new Date().toISOString(),
        lastSeq: lastSeq || null,
        broken: { id: r.id, seq: r.seq, at: r.at.toISOString(), action: r.action, reason },
      });
      if ((r.prevHash ?? null) !== prevHash) return brokenAt('chain_break');
      const expected = sha256(
        JSON.stringify({
          labId: r.labId,
          userId: r.userId,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          summary: r.summary,
          before: r.before ?? null,
          after: r.after ?? null,
          at: r.at.toISOString(),
          prevHash: r.prevHash ?? null,
        }),
      );
      if (expected !== r.hash) return brokenAt('hash_mismatch');
      checked++;
      prevHash = r.hash;
      lastSeq = r.seq;
    }
  }
  return { ok: true, checked, verifiedAt: new Date().toISOString(), lastSeq: lastSeq || null, broken: null };
}

/** Lab-wide count, used by the audit page header. */
export async function auditCount(): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(auditLog);
  return row?.n ?? 0;
}

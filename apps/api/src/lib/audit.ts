import { desc, eq, sql } from 'drizzle-orm';
import { auditLog } from '@natija/db';
import { ctx } from '../db';
import { sha256 } from './crypto';

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  before?: unknown;
  after?: unknown;
  /** Override the actor (e.g. at sign-in, before the session exists). */
  userId?: string | null;
  actorName?: string | null;
};

function compareJsonbKeys(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return ba.length - bb.length;
  return Buffer.compare(ba, bb);
}

/**
 * Re-key objects the way PostgreSQL stores jsonb (shorter keys first, then byte order) and turn
 * dates into ISO strings. The audit hash covers JSON.stringify(before/after), and jsonb does not
 * keep key order, so a value hashed in insertion order could not be re-hashed from the stored row.
 * Values passed through this function serialise identically before and after the round trip.
 */
export function jsonbCanonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined || typeof v === 'function' ? null : jsonbCanonical(v)));
  if (typeof value === 'object') {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') return jsonbCanonical(toJSON.call(value));
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && typeof v !== 'function');
    entries.sort(([a], [b]) => compareJsonbKeys(a, b));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = jsonbCanonical(v);
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Append to the lab's audit log inside the current transaction. Each row stores the hash of
 * the previous row, so edits or deletions in the database itself become detectable.
 * The application role can insert into audit_log but cannot update or delete it.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  const c = ctx();
  const before = jsonbCanonical(entry.before);
  const after = jsonbCanonical(entry.after);
  await c.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'audit:' + c.labId}))`);
  const [prev] = await c.tx
    .select({ hash: auditLog.hash })
    .from(auditLog)
    .where(eq(auditLog.labId, c.labId))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  const at = new Date();
  const prevHash = prev?.hash ?? null;
  const userId = entry.userId !== undefined ? entry.userId : c.userId;
  const actorName = entry.actorName !== undefined ? entry.actorName : c.actorName;
  const hash = sha256(
    JSON.stringify({
      labId: c.labId,
      userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary ?? null,
      before,
      after,
      at: at.toISOString(),
      prevHash,
    }),
  );
  await c.tx.insert(auditLog).values({
    labId: c.labId,
    userId,
    actorName,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary ?? null,
    before,
    after,
    ip: c.ip,
    userAgent: c.userAgent,
    at,
    prevHash,
    hash,
  });
}

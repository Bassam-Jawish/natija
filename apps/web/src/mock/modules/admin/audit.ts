/**
 * The lab's append-only audit log: browse, filter and check the chain (port of
 * apps/api/src/modules/audit). The mock's chain hashes are stand-ins, not sha256, so the check
 * reports every entry as intact, in the server's response shape.
 */
import type { AuditChainCheck, AuditLogFacets, AuditLogRow } from '@natija/contracts';
import { adminAuditQuery } from '@natija/contracts';
import { now } from '../../core/context';
import { rows } from '../../core/db';
import { dayRange, parse } from '../../core/lib';
import { route } from '../../core/router';
import { cmp, contains, likeTerm, startsWith } from './kit';

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

export function listAudit(f: AuditFilters): { items: AuditLogRow[]; total: number } {
  const range = f.from || f.to ? dayRange(f.from, f.to) : null;
  const prefix = f.action?.endsWith('*') ? likeTerm(f.action.slice(0, -1)) : null;
  const term = f.q ? likeTerm(f.q) : '';
  const matching = rows('auditLog').filter((r) => {
    if (range && (r.at < range.start || r.at >= range.end)) return false;
    if (f.entityType && r.entityType !== f.entityType) return false;
    if (f.entityId && r.entityId !== f.entityId) return false;
    if (f.userId && r.userId !== f.userId) return false;
    if (f.action && (prefix !== null ? !startsWith(r.action, prefix) : r.action !== f.action)) return false;
    if (f.q && !(contains(r.summary, term) || contains(r.actorName, term) || contains(r.action, term))) return false;
    return true;
  });
  const offset = f.offset ?? 0;
  const limit = f.limit ?? 50;
  return {
    items: matching
      .sort((a, b) => b.seq - a.seq)
      .slice(offset, offset + limit)
      .map((r) => ({
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
    total: matching.length,
  };
}

export function auditFacets(): AuditLogFacets {
  const log = rows('auditLog');
  return {
    entityTypes: [...new Set(log.map((r) => r.entityType))].sort(cmp),
    actions: [...new Set(log.map((r) => r.action))].sort(cmp),
    users: [...rows('users')]
      .sort((a, b) => cmp(a.fullNameEn, b.fullNameEn))
      .map((u) => ({ id: u.id, fullNameAr: u.fullNameAr, fullNameEn: u.fullNameEn })),
  };
}

/**
 * The server walks the log in `seq` order and recomputes every sha256 hash. Mock entries carry a
 * stand-in hash, so there is nothing to recompute: every entry counts as checked and intact.
 */
export function verifyChain(): AuditChainCheck {
  const log = rows('auditLog');
  const lastSeq = log.reduce((max, r) => Math.max(max, r.seq), 0);
  return { ok: true, checked: log.length, verifiedAt: now().toISOString(), lastSeq: lastSeq || null, broken: null };
}

/** Lab-wide count, used by the audit page header. */
export function auditCount(): number {
  return rows('auditLog').length;
}

export function registerAudit(): void {
  const perm = { perm: 'audit.read' };

  route('GET', '/audit', perm, (req) => listAudit(parse(adminAuditQuery, req.query)));
  route('GET', '/audit/facets', perm, () => ({ ...auditFacets(), count: auditCount() }));
  route('GET', '/audit/verify', perm, () => verifyChain());
}

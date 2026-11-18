/**
 * Helpers shared by the mock services, mirroring apps/api/src/lib: audit log, live events,
 * notifications, counters, the lab profile, input parsing and day ranges.
 */
import type { z } from 'zod';
import { ctx, hasContext, now } from './context';
import { find, insert, rows, state, type Row } from './db';

/* ------------------------------------------------------------------ audit */

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  before?: unknown;
  after?: unknown;
  userId?: string | null;
  actorName?: string | null;
};

function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A stand-in for the server's sha256 chain hash: same shape (64 hex), not cryptographic. */
function chainHash(text: string): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += fnv(text, 2166136261 + i * 7919);
  return out;
}

const lastHash = new Map<string, string>();

/** Append to the lab's audit log (who, what, before/after), like the server's audit(). */
export function audit(entry: AuditEntry): void {
  const c = ctx();
  const at = now();
  const prevHash = lastHash.get(c.labId) ?? null;
  const userId = entry.userId !== undefined ? entry.userId : c.userId;
  const actorName = entry.actorName !== undefined ? entry.actorName : c.actorName;
  const hash = chainHash(`${prevHash}|${c.labId}|${entry.action}|${entry.entityId ?? ''}|${at.getTime()}|${entry.summary ?? ''}`);
  insert('auditLog', {
    labId: c.labId,
    userId,
    actorName,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: '127.0.0.1',
    userAgent: 'Natija mock',
    at,
    prevHash,
    hash,
  });
  lastHash.set(c.labId, hash);
}

/** Forget cached chain heads (after the store is replaced). */
export function resetAuditHeads(): void {
  lastHash.clear();
}

/* ------------------------------------------------------------------ live events */

export type LiveEvent = { type: string; data?: unknown; userIds?: string[]; labId?: string };
type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
let queue: LiveEvent[] | null = null;

/** Publish a live event (orders.changed, results.changed, notification…). Delivered after the request. */
export function publish(event: LiveEvent): void {
  const e = { ...event, labId: event.labId ?? (hasContext() ? ctx().labId : undefined) };
  if (queue) queue.push(e);
  else for (const fn of listeners) fn(e);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Hold events while a request runs; deliver them when it finishes (like the server's afterCommit). */
export function beginEvents(): void {
  queue = [];
}

export function flushEvents(deliver: boolean): void {
  const pending = queue ?? [];
  queue = null;
  if (!deliver) return;
  for (const e of pending) for (const fn of listeners) fn(e);
}

/* ------------------------------------------------------------------ notifications */

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

/** Active users of the signed-in lab who hold a permission. */
export function usersWithPermission(perm: string): string[] {
  const roleIds = new Set(rows('roles').filter((r) => r.permissions.includes(perm)).map((r) => r.id));
  const out = new Set<string>();
  for (const ur of rows('userRoles')) {
    if (!roleIds.has(ur.roleId)) continue;
    const u = find('users', ur.userId);
    if (u && u.status === 'active') out.add(u.id);
  }
  return [...out];
}

export function notifyUsers(userIds: string[], n: NotificationInput): void {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  let firstRow: Row<'notifications'> | null = null;
  for (const userId of ids) {
    const row = insert('notifications', {
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
    });
    firstRow ??= row;
  }
  publish({ type: 'notification', userIds: ids, data: firstRow });
}

export function notifyPermission(perm: string, n: NotificationInput): void {
  notifyUsers(usersWithPermission(perm), n);
}

export function notifyPermissions(perms: string[], n: NotificationInput): void {
  notifyUsers(perms.flatMap(usersWithPermission), n);
}

/* ------------------------------------------------------------------ counters and the lab */

/** Next value of a per-lab counter: `order:YYYY-MM-DD`, `patient`, `invoice:YYYY`… */
export function nextCounter(key: string): number {
  const lab = ctx().labId;
  const counters = (state.counters[lab] ??= {});
  counters[key] = (counters[key] ?? 0) + 1;
  return counters[key]!;
}

export function getLab(labId: string = ctx().labId): Row<'labs'> {
  const lab = rows('labs').find((l) => l.id === labId);
  if (!lab) throw new Error(`Mock: lab ${labId} not found`);
  return lab;
}

export function labTimezone(labId?: string): string {
  return getLab(labId).timezone;
}

/** Where patient links and QR codes point: this page (hash routes work offline from a file too). */
export function publicUrl(): string {
  if (typeof location === 'undefined') return 'http://localhost:5173';
  const hash = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ROUTER === 'hash';
  return hash ? `${location.origin === 'null' ? 'file://' : location.origin}${location.pathname}#` : location.origin;
}

/* ------------------------------------------------------------------ input */

type Issue = { path: PropertyKey[] };

/** Marks a list entry to remove once every failing path of this round has been handled. */
const DROPPED = Symbol('dropped');

function dropPath(input: unknown, path: PropertyKey[]): boolean {
  if (!path.length || input === null || typeof input !== 'object') return false;
  let target = input as Record<PropertyKey, unknown>;
  for (const key of path.slice(0, -1)) {
    const next = target[key];
    if (next === null || typeof next !== 'object') return false;
    target = next as Record<PropertyKey, unknown>;
  }
  const last = path[path.length - 1]!;
  if (!(last in target) || target[last] === DROPPED) return false;
  // List entries are marked, not spliced, so the other failing positions stay valid.
  if (Array.isArray(target) && typeof last === 'number') target[last] = DROPPED;
  else delete target[last];
  return true;
}

function sweepDropped(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== DROPPED).map(sweepDropped);
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Blob)) {
    for (const [k, v] of Object.entries(value)) (value as Record<string, unknown>)[k] = sweepDropped(v);
  }
  return value;
}

/**
 * Read input with the same zod schema the server uses, but never refuse it: a field that does
 * not pass is dropped (so its default or "not set" applies) and the rest goes through. Mock mode
 * accepts whatever is typed.
 */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  let input: unknown = structuredClone(data ?? {});
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = schema.safeParse(input);
    if (res.success) return res.data;
    let dropped = false;
    for (const issue of res.error.issues as Issue[]) dropped = dropPath(input, issue.path) || dropped;
    if (!dropped) break;
    input = sweepDropped(input);
  }
  // Still refused (a required field failed): take every field the schema accepts on its own
  // (trimmed, coerced, defaults filled), and keep what was typed for the rest.
  const shape = (schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
  const raw = structuredClone(data ?? {}) as Record<string, unknown>;
  if (shape && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, unknown> = { ...raw };
    for (const [key, field] of Object.entries(shape)) {
      const r = field.safeParse(raw[key]);
      if (r.success) {
        if (r.data !== undefined) out[key] = r.data;
        continue;
      }
      // A field that can be left out falls back to its default (or to "not set")…
      const fallback = field.safeParse(undefined);
      if (fallback.success) {
        if (fallback.data === undefined) delete out[key];
        else out[key] = fallback.data;
      } else if (typeof raw[key] === 'string') {
        // …a required one keeps what was typed.
        out[key] = (raw[key] as string).trim();
      }
    }
    return out as z.infer<S>;
  }
  return input as z.infer<S>;
}

export function page<T>(items: T[], total: number): { items: T[]; total: number } {
  return { items, total };
}

/** Paging from a query: `limit` (default 50, max 500) and `offset`. */
export function slice<T>(items: T[], query: { limit?: number | string; offset?: number | string }): T[] {
  const limit = Math.min(500, Math.max(1, Number(query.limit ?? 50) || 50));
  const offset = Math.max(0, Number(query.offset ?? 0) || 0);
  return items.slice(offset, offset + limit);
}

/* ------------------------------------------------------------------ days */

function offsetMinutes(timeZone: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? '');
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Start of a calendar day (YYYY-MM-DD) in a time zone, as an instant. */
export function zonedDayStart(date: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, mo - 1, d);
  return new Date(guess - offsetMinutes(timeZone, new Date(guess)) * 60_000);
}

/** Today's date (YYYY-MM-DD) in the lab's time zone. */
export function labToday(timeZone = labTimezone()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now());
}

/** Optional from/to dates → [start, end) instants in the lab's time zone; today when both are missing. */
export function dayRange(from?: string | null, to?: string | null): { start: Date; end: Date } {
  const tz = labTimezone();
  const today = labToday(tz);
  const start = zonedDayStart(from ?? to ?? today, tz);
  const endDay = zonedDayStart(to ?? from ?? today, tz);
  return { start, end: new Date(endDay.getTime() + 86_400_000) };
}

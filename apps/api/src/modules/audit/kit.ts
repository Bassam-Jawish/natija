/**
 * Small helpers shared by the administration modules (catalog, pricing, doctors, staff,
 * settings, finance): audit entries whose hashes can be re-verified, change sets, raw SQL rows.
 */
import { count, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../../db';
import { audit, jsonbCanonical, type AuditEntry } from '../../lib/audit';
import { badRequest } from '../../lib/errors';

/** audit() under the name the admin modules use; audit() itself stores before/after in jsonb key order. */
export async function record(entry: AuditEntry): Promise<void> {
  await audit(entry);
}

/** Only the fields that changed, for compact before/after entries on updates. Null when nothing changed. */
export function changes<T extends object>(before: T, after: Partial<T>): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const key of Object.keys(after) as Array<keyof T>) {
    const y = after[key];
    if (y === undefined) continue;
    const x = before[key];
    if (JSON.stringify(jsonbCanonical(x)) !== JSON.stringify(jsonbCanonical(y))) {
      b[key] = x;
      a[key] = y;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

/** Rows of a raw query, typed by the caller. */
export async function rowsOf<T>(query: SQL): Promise<T[]> {
  const res = await db().execute(query);
  return res.rows as T[];
}

export async function countRows(table: PgTable, where: SQL | undefined): Promise<number> {
  const [r] = await db().select({ n: count() }).from(table).where(where);
  return r?.n ?? 0;
}

/** 400 with a field error, in the same shape as zod validation errors. */
export function fieldError(field: string, code: string): never {
  throw badRequest('validation', code, { [field]: [code] });
}

/** Numbers from SQL aggregates (numeric and bigint arrive as strings). */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Run queries one after another. A request's queries share one transaction connection, which
 * cannot run statements in parallel (pg warns today and will refuse in pg 9).
 */
export async function inSequence<T extends readonly unknown[]>(tasks: readonly [...{ [K in keyof T]: () => PromiseLike<T[K]> }]): Promise<T> {
  const out: unknown[] = [];
  for (const task of tasks) out.push(await task());
  return out as unknown as T;
}

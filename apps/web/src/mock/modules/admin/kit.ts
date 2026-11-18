/**
 * Helpers shared by the administration ports: audit entries with before/after in jsonb key
 * order, change sets and field errors (port of apps/api/src/modules/audit/kit.ts and the jsonb
 * canonical form in apps/api/src/lib/audit.ts), the database's unique indexes, sorting and
 * ILIKE-style matching, and input(): the server's request schema read the mock-mode way.
 */
import type { z } from 'zod';
import { AppError, badRequest } from '../../core/context';
import { rows, type TableName } from '../../core/db';
import { audit, parse, type AuditEntry } from '../../core/lib';

/* ------------------------------------------------------------------ audit entries */

const utf8 = new TextEncoder();

/** UTF-8 size of a text, as the server measures it. */
export function byteLength(text: string): number {
  return utf8.encode(text).length;
}

function compareJsonbKeys(a: string, b: string): number {
  const ba = utf8.encode(a);
  const bb = utf8.encode(b);
  if (ba.length !== bb.length) return ba.length - bb.length;
  for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) return ba[i]! - bb[i]!;
  return 0;
}

/**
 * Re-key objects the way PostgreSQL stores jsonb (shorter keys first, then byte order) and turn
 * dates into ISO strings, so audit before/after read exactly as the server returns them.
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

/** audit() under the name the admin modules use, with before/after stored as jsonb would. */
export function record(entry: AuditEntry): void {
  audit({ ...entry, before: jsonbCanonical(entry.before), after: jsonbCanonical(entry.after) });
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

/** 400 with a field error, in the same shape as the server's validation errors. */
export function fieldError(field: string, code: string): never {
  throw badRequest('validation', code, { [field]: [code] });
}

/**
 * A unique index of the database (e.g. one test code per lab): a second row with the same value
 * is refused with 409 "duplicate", the constraint name in the details, as the server answers.
 */
export function assertUnique(table: TableName, field: string, value: unknown, constraint: string, exceptId?: string): void {
  if (value === undefined || value === null) return;
  const list = rows(table) as unknown as ReadonlyArray<Record<string, unknown>>;
  if (list.some((r) => r[field] === value && r.id !== exceptId)) throw new AppError(409, 'duplicate', 'Already exists', undefined, constraint);
}

/* ------------------------------------------------------------------ sorting and matching */

type Key = string | number | boolean | null | undefined;

/** ORDER BY for one column: numbers and booleans by value, text by locale, nulls last. */
export function cmp(a: Key, b: Key): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, 'en');
  return Number(a) - Number(b);
}

/** ILIKE '%term%' (the server strips % and _ from search terms first). */
export function contains(value: string | null | undefined, term: string): boolean {
  return !!value && value.toLowerCase().includes(term.toLowerCase());
}

/** ILIKE 'term%'. */
export function startsWith(value: string | null | undefined, term: string): boolean {
  return !!value && value.toLowerCase().startsWith(term.toLowerCase());
}

/** A search term as the server uses it in LIKE patterns. */
export const likeTerm = (q: string) => q.replace(/[%_]/g, '');

/* ------------------------------------------------------------------ input */

type Def = { type?: string; innerType?: unknown; in?: unknown };
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'catch', 'readonly', 'nonoptional']);

function defOf(schema: unknown): Def | undefined {
  return (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;
}

/** The value type under optional / nullable / default / transform wrappers: 'string', 'number'… */
function baseType(schema: unknown): string {
  let def = defOf(schema);
  for (let i = 0; def && i < 16; i++) {
    if (def.type && WRAPPERS.has(def.type)) def = defOf(def.innerType);
    else if (def.type === 'pipe') def = defOf(def.in);
    else return def.type ?? 'unknown';
  }
  return 'unknown';
}

/** What a field the schema refused is kept as: the typed text, number, yes/no or list. */
function loose(value: unknown, type: string): unknown {
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return undefined;
    case 'number':
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      return undefined;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return undefined;
    case 'array':
      return Array.isArray(value) ? value : undefined;
    default:
      // Enums and anything else: an unknown value falls back to the field's default.
      return undefined;
  }
}

/**
 * Read a request body with the server's zod schema, without refusing it: valid input comes out
 * exactly as on the server (trimmed, defaults filled). A field the server would refuse for its
 * format (a code with a space, a long name, a number out of range) is kept as typed instead;
 * an unknown choice falls back to its default. Object-level rules are not applied.
 */
export function input<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const raw = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const whole = schema.safeParse(raw);
  if (whole.success) return whole.data;
  const shape = (schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (!shape || typeof shape !== 'object') return parse(schema, raw);
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const strict = field.safeParse(raw[key]);
    let value: unknown = strict.success ? strict.data : loose(raw[key], baseType(field));
    if (!strict.success && value !== undefined) {
      const again = field.safeParse(value);
      if (again.success) value = again.data;
    }
    if (value === undefined) {
      const fallback = field.safeParse(undefined);
      if (fallback.success) value = fallback.data;
    }
    if (value !== undefined) out[key] = value;
  }
  return out as z.output<S>;
}

/** A list of objects from the body (e.g. range rows), each read with input(). */
export function inputRows<S extends z.ZodTypeAny>(schema: S, list: unknown): Array<z.output<S>> {
  return Array.isArray(list) ? list.map((item) => input(schema, item)) : [];
}

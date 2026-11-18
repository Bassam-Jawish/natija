/**
 * The mock store: the same tables and fields as the real database, kept in memory (persist.ts
 * saves it in the browser). Rows are the database's row types, so mock services read like the
 * server's. Tables with a `labId` column are split per lab, and `rows()` returns the signed-in
 * lab's rows only, the way row-level security does on the server.
 *
 * Always change rows through insert / update / remove: they keep the lookups used by find()
 * and by() in step.
 */
import { getTableColumns, is, SQL } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@natija/db/schema';
import { ctx, notFound, now } from './context';

type Schema = typeof schema;
export type TableName = { [K in keyof Schema]: Schema[K] extends PgTable ? K : never }[keyof Schema];
export type Row<N extends TableName> = Schema[N] extends { $inferSelect: infer R } ? R : never;
type AnyRow = Record<string, unknown>;

/** Partition key for tables without a lab (the labs directory). */
const GLOBAL = '_';

/* ------------------------------------------------------------------ table metadata */

type Meta = { keys: string[]; defaults: Map<string, () => unknown>; serial: string[]; partitioned: boolean };

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function makeDefault(column: unknown): (() => unknown) | null {
  const c = column as { defaultFn?: () => unknown; hasDefault?: boolean; default?: unknown; columnType: string };
  if (c.defaultFn) return c.defaultFn;
  if (!c.hasDefault) return null;
  const d = c.default;
  if (is(d, SQL)) {
    if (c.columnType === 'PgUUID') return () => crypto.randomUUID();
    if (c.columnType.startsWith('PgTimestamp')) return () => now();
    if (c.columnType === 'PgArray') return () => [];
    if (c.columnType.startsWith('PgDate')) return () => isoDay(now());
    if (c.columnType === 'PgJsonb') return () => ({});
    return () => null;
  }
  if (d !== null && typeof d === 'object') return () => structuredClone(d);
  return () => d;
}

const TABLES = new Map<TableName, PgTable>();
const NAME_OF = new Map<PgTable, TableName>();
const META = new Map<TableName, Meta>();
for (const [key, value] of Object.entries(schema)) {
  if (!is(value, PgTable)) continue;
  const name = key as TableName;
  TABLES.set(name, value);
  NAME_OF.set(value, name);
  const cols = getTableColumns(value) as Record<string, unknown>;
  const defaults = new Map<string, () => unknown>();
  const serial: string[] = [];
  for (const [k, col] of Object.entries(cols)) {
    if ((col as { columnType: string }).columnType.includes('Serial')) serial.push(k);
    const d = makeDefault(col);
    if (d) defaults.set(k, d);
  }
  META.set(name, { keys: Object.keys(cols), defaults, serial, partitioned: 'labId' in cols });
}

export function tableNames(): TableName[] {
  return [...TABLES.keys()];
}

export function tableName(table: PgTable): TableName {
  const name = NAME_OF.get(table);
  if (!name) throw new Error('Mock: unknown table');
  return name;
}

/** Column key (as in the row object) for a drizzle column object. */
export function columnKey(table: PgTable, column: unknown): string {
  for (const [k, c] of Object.entries(getTableColumns(table))) if (c === column) return k;
  throw new Error('Mock: unknown column');
}

/* ------------------------------------------------------------------ state */

export type StoreState = {
  version: number;
  data: Record<string, Record<string, AnyRow[]>>;
  seq: Record<string, number>;
  /** Per-lab counters (order numbers, MRNs, invoice numbers). */
  counters: Record<string, Record<string, number>>;
  /** Uploaded files by storage path, as data URLs. */
  files: Record<string, string>;
  /** When the demo history was generated (ms), for reference. */
  seededAt: number | null;
};

export const STATE_VERSION = 1;

export const state: StoreState = { version: STATE_VERSION, data: {}, seq: {}, counters: {}, files: {}, seededAt: null };

const byId = new Map<string, AnyRow>();
const tableOf = new WeakMap<AnyRow, TableName>();
/** Table partitions (`table|labId`) changed since the last save; persist.ts saves only these. */
export const dirtyParts = new Set<string>();
/** Secondary lookups: `${table}|${partition}|${field}` → value → rows. Built on first use. */
const indexes = new Map<string, Map<unknown, AnyRow[]>>();
const indexFields = new Map<string, Set<string>>();

function meta(name: TableName): Meta {
  const m = META.get(name);
  if (!m) throw new Error(`Mock: unknown table ${name}`);
  return m;
}

function partitionKey(name: TableName, labId?: string): string {
  if (!meta(name).partitioned) return GLOBAL;
  return labId ?? ctx().labId;
}

function partition(name: TableName, key: string): AnyRow[] {
  const t = (state.data[name] ??= {});
  return (t[key] ??= []);
}

/** Replace the whole state (after loading from the browser or reseeding) and rebuild lookups. */
export function replaceState(next: StoreState): void {
  state.version = next.version;
  state.data = next.data;
  state.seq = next.seq;
  state.counters = next.counters;
  state.files = next.files;
  state.seededAt = next.seededAt;
  byId.clear();
  indexes.clear();
  indexFields.clear();
  dirtyParts.clear();
  for (const [name, parts] of Object.entries(state.data)) {
    for (const list of Object.values(parts)) {
      for (const row of list) {
        tableOf.set(row, name as TableName);
        if (typeof row.id === 'string') byId.set(row.id, row);
      }
    }
  }
}

export function emptyState(): StoreState {
  return { version: STATE_VERSION, data: {}, seq: {}, counters: {}, files: {}, seededAt: null };
}

/* ------------------------------------------------------------------ reading */

/** Rows of the signed-in lab (or every row for tables without a lab). Do not modify the array. */
export function rows<N extends TableName>(name: N): readonly Row<N>[] {
  return partition(name, partitionKey(name)) as unknown as Row<N>[];
}

/** Rows of a given lab (public pages and the demo seed, which run outside a sign-in). */
export function rowsOfLab<N extends TableName>(name: N, labId: string): readonly Row<N>[] {
  return partition(name, partitionKey(name, labId)) as unknown as Row<N>[];
}

/** Every row of a table across all labs. */
export function allRows<N extends TableName>(name: N): Row<N>[] {
  return Object.values(state.data[name] ?? {}).flat() as unknown as Row<N>[];
}

/** A row by id in the signed-in lab (undefined if it belongs to another lab, like row-level security). */
export function find<N extends TableName>(name: N, id: string | null | undefined): Row<N> | undefined {
  if (!id) return undefined;
  const row = byId.get(id);
  if (!row || tableOf.get(row) !== name) return undefined;
  if (meta(name).partitioned && row.labId !== ctx().labId) return undefined;
  return row as unknown as Row<N>;
}

/** A row by id, or a 404 with the given code. */
export function get<N extends TableName>(name: N, id: string | null | undefined, code = 'not_found'): Row<N> {
  const row = find(name, id);
  if (!row) throw notFound(code);
  return row;
}

/** Rows whose `field` equals `value`, in the signed-in lab (fast: kept as a lookup). */
export function by<N extends TableName, K extends keyof Row<N> & string>(name: N, field: K, value: Row<N>[K]): Row<N>[] {
  const part = partitionKey(name);
  const key = `${name}|${part}|${field}`;
  let index = indexes.get(key);
  if (!index) {
    index = new Map();
    for (const row of partition(name, part)) {
      const v = row[field];
      const bucket = index.get(v);
      if (bucket) bucket.push(row);
      else index.set(v, [row]);
    }
    indexes.set(key, index);
    const fieldsKey = `${name}|${part}`;
    (indexFields.get(fieldsKey) ?? indexFields.set(fieldsKey, new Set()).get(fieldsKey)!).add(field);
  }
  return [...(index.get(value) ?? [])] as unknown as Row<N>[];
}

/** First row matching a predicate in the signed-in lab. */
export function first<N extends TableName>(name: N, pred: (row: Row<N>) => boolean): Row<N> | undefined {
  return rows(name).find(pred);
}

/* ------------------------------------------------------------------ writing */

function indexAdd(name: TableName, part: string, row: AnyRow): void {
  const fields = indexFields.get(`${name}|${part}`);
  if (!fields) return;
  for (const field of fields) {
    const index = indexes.get(`${name}|${part}|${field}`)!;
    const v = row[field];
    const bucket = index.get(v);
    if (bucket) bucket.push(row);
    else index.set(v, [row]);
  }
}

function indexRemove(name: TableName, part: string, row: AnyRow, field?: string, oldValue?: unknown): void {
  const fields = indexFields.get(`${name}|${part}`);
  if (!fields) return;
  for (const f of field ? [field] : fields) {
    if (!fields.has(f)) continue;
    const index = indexes.get(`${name}|${part}|${f}`)!;
    const v = f === field ? oldValue : row[f];
    const bucket = index.get(v);
    if (!bucket) continue;
    const i = bucket.indexOf(row);
    if (i >= 0) bucket.splice(i, 1);
  }
}

/**
 * Insert a row: database defaults fill what is missing (id, created_at, status…), `labId` defaults
 * to the signed-in lab, and every other missing column is null, as in a database row.
 */
export function insert<N extends TableName>(name: N, values: Partial<Row<N>>): Row<N> {
  const m = meta(name);
  const v = values as AnyRow;
  const row: AnyRow = {};
  for (const key of m.keys) {
    if (v[key] !== undefined) row[key] = v[key];
    else if (key === 'labId' && m.partitioned) row[key] = ctx().labId;
    else if (m.serial.includes(key)) row[key] = state.seq[`${name}.${key}`] = (state.seq[`${name}.${key}`] ?? 0) + 1;
    else row[key] = m.defaults.get(key)?.() ?? null;
  }
  const part = m.partitioned ? String(row.labId) : GLOBAL;
  partition(name, part).push(row);
  dirtyParts.add(`${name}|${part}`);
  tableOf.set(row, name);
  if (typeof row.id === 'string') byId.set(row.id, row);
  indexAdd(name, part, row);
  return row as unknown as Row<N>;
}

export function insertMany<N extends TableName>(name: N, values: Array<Partial<Row<N>>>): Row<N>[] {
  return values.map((v) => insert(name, v));
}

/** Change fields of a row in place (undefined values are ignored). Returns the row. */
export function update<N extends TableName>(name: N, row: Row<N>, patch: Partial<Row<N>>): Row<N> {
  const r = row as unknown as AnyRow;
  const part = meta(name).partitioned ? String(r.labId) : GLOBAL;
  dirtyParts.add(`${name}|${part}`);
  for (const [key, value] of Object.entries(patch as AnyRow)) {
    if (value === undefined) continue;
    const old = r[key];
    if (old === value) continue;
    indexRemove(name, part, r, key, old);
    r[key] = value;
    const fields = indexFields.get(`${name}|${part}`);
    if (fields?.has(key)) {
      const index = indexes.get(`${name}|${part}|${key}`)!;
      const bucket = index.get(value);
      if (bucket) bucket.push(r);
      else index.set(value, [r]);
    }
  }
  return row;
}

/** Remove rows of the signed-in lab that match. Returns how many were removed. */
export function remove<N extends TableName>(name: N, pred: (row: Row<N>) => boolean): number {
  const part = partitionKey(name);
  const list = partition(name, part);
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i]!;
    if (!pred(row as unknown as Row<N>)) continue;
    list.splice(i, 1);
    dirtyParts.add(`${name}|${part}`);
    if (typeof row.id === 'string') byId.delete(row.id);
    indexRemove(name, part, row);
    removed++;
  }
  return removed;
}

/* ------------------------------------------------------------------ drizzle-style inserts for the shared seeder */

/**
 * Just enough of drizzle's `db.insert(table).values(...).returning(...)` for packages/db's
 * seedLab() to write the demo labs into this store.
 */
export const seedDb = {
  insert(table: PgTable) {
    const name = tableName(table);
    return {
      values(values: AnyRow | AnyRow[]) {
        const list = (Array.isArray(values) ? values : [values]).map((v) => insert(name, v as Partial<Row<typeof name>>) as unknown as AnyRow);
        const done = Promise.resolve(undefined);
        return {
          returning(selection?: Record<string, unknown>) {
            if (!selection) return Promise.resolve(list);
            const picks = Object.entries(selection).map(([alias, column]) => [alias, columnKey(table, column)] as const);
            return Promise.resolve(list.map((r) => Object.fromEntries(picks.map(([alias, key]) => [alias, r[key]]))));
          },
          then: done.then.bind(done),
        };
      },
    };
  },
};

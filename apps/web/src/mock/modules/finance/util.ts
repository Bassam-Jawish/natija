/**
 * Small helpers for the finance, analytics and doctors mock ports. Ports the pieces of
 * apps/api/src/modules/audit/kit.ts these modules use (record, changes), fillDays from
 * finance/service.ts, and adds what SQL gave the server for free: cent-exact money sums and a
 * fast lab-time clock for grouping instants by calendar day, hour and weekday.
 */
import { audit, type AuditEntry } from '../../core/lib';

/** audit() under the name the admin modules use. */
export function record(entry: AuditEntry): void {
  audit(entry);
}

function canonical(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value, (_k, v: unknown) => (v === undefined ? null : v));
}

/** Only the fields that changed, for compact before/after entries on updates. Null when nothing changed. */
export function changes<T extends object>(before: T, after: Partial<T>): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const key of Object.keys(after) as Array<keyof T>) {
    const y = after[key];
    if (y === undefined) continue;
    const x = before[key];
    if (canonical(x) !== canonical(y)) {
      b[key] = x;
      a[key] = y;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

/** A money total as the database's numeric(14,2) sum gives it: exact to the cent, no float noise. */
export const cents = (v: number): number => Math.round(v * 100) / 100;

/** A number typed by the user: the parsed value, else the raw one when it is a finite number, else 0. */
export function amountOf(parsed: unknown, raw?: unknown): number {
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Free text typed by the user, trimmed: the parsed value, else the raw text as typed, else the
 * fallback. (When a required field fails, the lenient parse hands back the raw input untrimmed.)
 */
export function textOf(parsed: unknown, raw: unknown, fallback = ''): string {
  if (typeof parsed === 'string') return parsed.trim();
  if (typeof raw === 'string') return raw.trim();
  return fallback;
}

/** Every calendar day of the range (YYYY-MM-DD, inclusive), missing days filled by `empty`. */
export function fillDays<T extends { date: string }>(from: string, to: string, rows: T[], empty: (date: string) => T): T[] {
  const map = new Map(rows.map((r) => [r.date, r]));
  const out: T[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= last && i < 800; i++) {
    const key = d.toISOString().slice(0, 10);
    out.push(map.get(key) ?? empty(key));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Group rows by a key in one pass. */
export function groupBy<T, K>(list: readonly T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of list) {
    const k = key(r);
    const bucket = out.get(k);
    if (bucket) bucket.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** Count rows by a key in one pass. */
export function countBy<T, K>(list: readonly T[], key: (r: T) => K): Map<K, number> {
  const out = new Map<K, number>();
  for (const r of list) {
    const k = key(r);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/* ------------------------------------------------------------------ lab clock */

const MIN15 = 900_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export type LabClock = {
  /** Calendar day (YYYY-MM-DD) of an instant in the lab's time zone, like to_char((t at time zone tz)::date). */
  day(t: Date | number): string;
  /** Hour 0–23 in the lab's time zone, like extract(hour from t at time zone tz). */
  hour(t: Date | number): number;
  /** Weekday 0 (Sunday) – 6, like extract(dow from t at time zone tz). */
  weekday(t: Date | number): number;
  /** Local wall time "YYYY-MM-DD HH:mm". */
  dateTime(t: Date | number): string;
};

const clocks = new Map<string, LabClock>();

/**
 * Day, hour and weekday of instants in a time zone without an Intl call per row: the UTC offset is
 * looked up once per quarter hour (offsets only change on quarter-hour instants) and cached.
 */
export function labClock(timeZone: string): LabClock {
  const cached = clocks.get(timeZone);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  const offsets = new Map<number, number>();
  const dayKeys = new Map<number, string>();
  const local = (t: Date | number): number => {
    const at = typeof t === 'number' ? t : t.getTime();
    const bucket = Math.floor(at / MIN15);
    let off = offsets.get(bucket);
    if (off === undefined) {
      const start = bucket * MIN15;
      const p: Record<string, number> = {};
      for (const part of fmt.formatToParts(new Date(start))) if (part.type !== 'literal') p[part.type] = Number(part.value);
      off = Date.UTC(p.year!, p.month! - 1, p.day!, (p.hour ?? 0) % 24, p.minute ?? 0) - start;
      offsets.set(bucket, off);
    }
    return at + off;
  };
  const clock: LabClock = {
    day(t) {
      const n = Math.floor(local(t) / DAY);
      let key = dayKeys.get(n);
      if (key === undefined) {
        key = new Date(n * DAY).toISOString().slice(0, 10);
        dayKeys.set(n, key);
      }
      return key;
    },
    hour(t) {
      const l = local(t);
      return Math.floor((((l % DAY) + DAY) % DAY) / HOUR);
    },
    weekday(t) {
      const n = Math.floor(local(t) / DAY);
      return (((n + 4) % 7) + 7) % 7;
    },
    dateTime(t) {
      return new Date(local(t)).toISOString().slice(0, 16).replace('T', ' ');
    },
  };
  clocks.set(timeZone, clock);
  return clock;
}

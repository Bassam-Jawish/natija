/**
 * Small helpers shared by the analyzer ports: what the database does for the server (jsonb
 * copies, ordering, unique indexes, the content hash) and the mock rule that input in a format
 * the server would refuse is taken as typed.
 */
import { AppError } from '../../core/context';

/** What a jsonb column keeps: plain JSON (dates become strings, nothing is shared with live objects). */
export function asJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Text order of `order by` on a code column. */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first by a timestamp; rows with the same time put the last one written first. */
export function newestFirst<T>(list: readonly T[], at: (row: T) => Date): T[] {
  return list
    .map((row, i) => ({ row, i, t: new Date(at(row)).getTime() }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .map((x) => x.row);
}

/** A text field the lenient parse dropped (a format the server would refuse), taken as typed. */
export function typedText(body: unknown, key: string): string | undefined {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : undefined;
}

/** A number field the lenient parse dropped (out of range), taken as typed; `fallback` when it is no number at all. */
export function typedNumber(body: unknown, key: string, fallback = 0): number {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim().replace(',', '.')) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** The server's unique indexes answer 409 "duplicate" with the constraint's name. */
export function duplicate(constraint: string): AppError {
  return new AppError(409, 'duplicate', 'Already exists', undefined, constraint);
}

/**
 * A stable 64-hex hash of a text, standing in for the server's SHA-256 (the browser has no
 * synchronous one). It recognises the same content twice; it is not for security.
 */
export function contentHash(text: string): string {
  let out = '';
  for (let lane = 0; lane < 8; lane++) {
    let h = (0x811c9dc5 ^ Math.imul(lane + 1, 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

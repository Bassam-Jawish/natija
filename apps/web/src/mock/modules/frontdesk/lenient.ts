/**
 * Mock mode takes whatever is typed at the front desk (no server file behind this one).
 * parse() drops a field the server's schema refuses: a name over the length limit, an e-mail
 * without @, a phone sent as a number, a two-letter reason. keepTyped() puts such typed fields
 * back as they came (text trimmed, blank as null), so the record is saved with what was entered.
 */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Restore fields (dot paths, e.g. 'discount.reason') that parse() dropped but the request had. */
export function keepTyped<T>(parsed: T, raw: unknown, paths: readonly string[]): T {
  if (!isObj(parsed) || !isObj(raw)) return parsed;
  for (const path of paths) {
    const keys = path.split('.');
    const last = keys.pop()!;
    let src: unknown = raw;
    let dst: unknown = parsed;
    for (const k of keys) {
      src = isObj(src) ? src[k] : undefined;
      dst = isObj(dst) ? dst[k] : undefined;
    }
    if (!isObj(src) || !isObj(dst) || dst[last] !== undefined) continue;
    const value = src[last];
    if (typeof value === 'string' || typeof value === 'number') dst[last] = String(value).trim() || null;
    else if (isObj(value)) dst[last] = structuredClone(value);
  }
  return parsed;
}

/** Optional text as stored: trimmed, blank → null. */
export function optText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v).trim() || null;
}

/** Required text as stored: trimmed, never null. */
export function reqText(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}

/** A value from a fixed list, or the fallback. */
export function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback;
}

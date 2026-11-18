/**
 * Timestamps as analyzers send them: YYYYMMDD[HHMM[SS]] in the analyzer's local time,
 * optionally followed by an HL7 offset (+0300). Normalized values keep local time as
 * 'YYYY-MM-DDTHH:MM:SS' (no zone) unless the message carried an offset; the server
 * resolves local times in the lab's time zone.
 */

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const get = (type: string) => fmt.formatToParts(date).find((p) => p.type === type)?.value ?? '00';
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** YYYYMMDDHHMMSS in a time zone (ASTM E1394 / HL7 TS without offset). */
export function compactTimestamp(date: Date, timeZone = 'UTC'): string {
  const p = parts(date, timeZone);
  return `${p.y}${p.mo}${p.d}${p.h}${p.mi}${p.s}`;
}

/** Local 'YYYY-MM-DDTHH:MM:SS' in a time zone. */
export function localIso(date: Date, timeZone = 'UTC'): string {
  const p = parts(date, timeZone);
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}`;
}

/**
 * Parse a compact timestamp. Returns 'YYYY-MM-DDTHH:MM:SS' (local) or with '+HH:MM' when
 * the value carries an offset. Returns null for empty or malformed input.
 */
export function parseCompactTimestamp(value: string | null | undefined): string | null {
  const s = (value ?? '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.\d+)?)?\s*([+-]\d{4})?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', sec = '00', off] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;
  const base = `${y}-${mo}-${d}T${h}:${mi}:${sec}`;
  return off ? `${base}${off.slice(0, 3)}:${off.slice(3)}` : base;
}

/**
 * Turn a normalized timestamp into an instant. Values with an offset are exact; local
 * values are read in `timeZone` (the lab's zone).
 */
export function resolveTimestamp(value: string | null | undefined, timeZone: string): Date | null {
  if (!value) return null;
  if (/[+-]\d{2}:\d{2}$|Z$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  // Offset of the zone at (about) that instant; two passes settle DST edges.
  let instant = guess - zoneOffsetMs(timeZone, new Date(guess));
  instant = guess - zoneOffsetMs(timeZone, new Date(instant));
  return new Date(instant);
}

function zoneOffsetMs(timeZone: string, at: Date): number {
  const p = parts(at, timeZone);
  const asUtc = Date.UTC(Number(p.y), Number(p.mo) - 1, Number(p.d), Number(p.h), Number(p.mi), Number(p.s));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

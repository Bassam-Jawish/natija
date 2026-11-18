export type Sex = 'male' | 'female';
export type ResultFlag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';

export type RangeRow = {
  sex: 'any' | Sex;
  ageMinDays: number;
  ageMaxDays: number | null;
  low: number | null;
  high: number | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  textRange: string | null;
  sampleTypeId?: string | null;
  instrumentId?: string | null;
};

const DAY_MS = 86_400_000;

function toDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  // Date-only strings are calendar dates; parse them at UTC midnight.
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
}

/** Whole days between the birth date and `at`. */
export function ageInDays(birthDate: string | Date, at: Date = new Date()): number {
  const b = toDate(birthDate);
  const days = Math.floor((at.getTime() - b.getTime()) / DAY_MS);
  return Math.max(0, days);
}

export function ageParts(birthDate: string | Date, at: Date = new Date()): { years: number; months: number; days: number } {
  const b = toDate(birthDate);
  let years = at.getUTCFullYear() - b.getUTCFullYear();
  let months = at.getUTCMonth() - b.getUTCMonth();
  let days = at.getUTCDate() - b.getUTCDate();
  if (days < 0) {
    months -= 1;
    const prevMonthDays = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 0)).getUTCDate();
    days += prevMonthDays;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years: Math.max(0, years), months: Math.max(0, months), days: Math.max(0, days) };
}

/** Short age label: years for adults, months for infants, days for newborns. */
export function formatAge(birthDate: string | Date, lang: 'ar' | 'en' = 'en', at: Date = new Date()): string {
  const { years, months, days } = ageParts(birthDate, at);
  if (years >= 2) return lang === 'ar' ? `${years} سنة` : `${years} y`;
  const totalMonths = years * 12 + months;
  if (totalMonths >= 1) return lang === 'ar' ? `${totalMonths} شهر` : `${totalMonths} mo`;
  return lang === 'ar' ? `${days} يوم` : `${days} d`;
}

/** Estimate a birth date from an age entered at the desk. Returns an ISO date (YYYY-MM-DD). */
export function birthDateFromAge(value: number, unit: 'years' | 'months' | 'days', at: Date = new Date()): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (unit === 'years') {
    d.setUTCFullYear(d.getUTCFullYear() - value);
    // Middle of the year keeps the estimate stable for the whole year.
    d.setUTCMonth(0, 1);
  } else if (unit === 'months') {
    d.setUTCMonth(d.getUTCMonth() - value);
  } else {
    d.setUTCDate(d.getUTCDate() - value);
  }
  return d.toISOString().slice(0, 10);
}

export type RangeContext = {
  sex: Sex;
  ageDays: number;
  sampleTypeId?: string | null;
  instrumentId?: string | null;
};

/**
 * Pick the most specific range that applies: specimen match beats instrument match,
 * which beats a sex-specific row, which beats the narrowest age band.
 */
export function selectRange<T extends RangeRow>(ranges: T[], ctx: RangeContext): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const r of ranges) {
    if (r.sex !== 'any' && r.sex !== ctx.sex) continue;
    if (ctx.ageDays < r.ageMinDays) continue;
    if (r.ageMaxDays !== null && ctx.ageDays > r.ageMaxDays) continue;
    if (r.sampleTypeId && r.sampleTypeId !== ctx.sampleTypeId) continue;
    if (r.instrumentId && r.instrumentId !== ctx.instrumentId) continue;
    const span = (r.ageMaxDays ?? 50_000) - r.ageMinDays;
    const score =
      (r.sampleTypeId ? 1000 : 0) + (r.instrumentId ? 100 : 0) + (r.sex !== 'any' ? 10 : 0) - span / 100_000;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/** Flag a numeric value against a range. Normal is inclusive: low ≤ value ≤ high. */
export function flagNumeric(value: number | null | undefined, range: RangeRow | null): { flag: ResultFlag | null; isCritical: boolean } {
  if (value === null || value === undefined || Number.isNaN(value) || !range) return { flag: null, isCritical: false };
  if (range.criticalLow !== null && value < range.criticalLow) return { flag: 'LL', isCritical: true };
  if (range.criticalHigh !== null && value > range.criticalHigh) return { flag: 'HH', isCritical: true };
  if (range.low !== null && value < range.low) return { flag: 'L', isCritical: false };
  if (range.high !== null && value > range.high) return { flag: 'H', isCritical: false };
  if (range.low === null && range.high === null) return { flag: null, isCritical: false };
  return { flag: 'N', isCritical: false };
}

/**
 * Flag a text or option result. The range's textRange holds the expected (normal) answers,
 * separated by "/", e.g. "Negative" or "Yellow/Pale yellow". Anything else is abnormal ("A").
 */
export function flagText(value: string | null | undefined, range: RangeRow | null): ResultFlag | null {
  if (!value || !range?.textRange) return null;
  const expected = range.textRange
    .split(/[/|;]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!expected.length) return null;
  const actual = value.trim().toLowerCase();
  return expected.some((e) => actual === e) ? 'N' : 'A';
}

/** Parse what a technician or an analyzer typed: "5.4", "< 0.5", ">1000", "5,4". */
export function parseNumericValue(input: string | number | null | undefined): { value: number | null; qualifier: '<' | '>' | null } {
  if (input === null || input === undefined) return { value: null, qualifier: null };
  if (typeof input === 'number') return { value: Number.isFinite(input) ? input : null, qualifier: null };
  const s = input
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.')
    .replace(/,/g, '.');
  const m = /^([<>]=?)?\s*(-?\d+(?:\.\d+)?)/.exec(s);
  if (!m) return { value: null, qualifier: null };
  const qualifier = m[1] ? (m[1].startsWith('<') ? '<' : '>') : null;
  return { value: Number(m[2]), qualifier };
}

/** Printable reference text: "13.0 – 17.0", "< 200", "> 60", or the configured text. */
export function formatRange(range: Pick<RangeRow, 'low' | 'high' | 'textRange'> | null, decimals = 1): string {
  if (!range) return '';
  const f = (n: number) => n.toFixed(decimals);
  if (range.low !== null && range.high !== null) return `${f(range.low)} – ${f(range.high)}`;
  if (range.high !== null) return `< ${f(range.high)}`;
  if (range.low !== null) return `> ${f(range.low)}`;
  return range.textRange ?? '';
}

/** True when the change from the previous value is larger than the configured percentage. */
export function deltaExceeded(current: number | null, previous: number | null, pct: number | null | undefined): boolean {
  if (current === null || previous === null || pct === null || pct === undefined || previous === 0) return false;
  return (Math.abs(current - previous) / Math.abs(previous)) * 100 > pct;
}

/** Round a value for display using the analyte's decimals, without changing what is stored. */
export function formatValue(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return value.toFixed(Math.max(0, Math.min(6, decimals)));
}

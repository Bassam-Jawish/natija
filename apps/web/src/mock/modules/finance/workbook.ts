/**
 * Port of apps/api/src/modules/analytics/excel.ts for mock mode: the same sheet specs, written
 * as one CSV (core/file.ts) instead of an Excel workbook. Sheets follow one another, each under
 * its name when there are several; dates and times are shown in the lab's time zone.
 */
import { csvFile, type MockFile } from '../../core/file';
import { labClock } from './util';

export type Lang = 'ar' | 'en';
export type ColumnFormat = 'text' | 'int' | 'decimal' | 'money' | 'percent' | 'minutes' | 'datetime' | 'date';

export type SheetSpec = {
  name: string;
  title?: string;
  subtitle?: string;
  columns: Array<{ header: string; key: string; width?: number; format?: ColumnFormat }>;
  rows: Array<Record<string, unknown>>;
  /** Optional totals row, keyed like the columns. */
  totals?: Record<string, unknown>;
};

/** Pick the label for the workbook language. */
export const L = (lang: Lang, en: string, ar: string) => (lang === 'ar' ? ar : en);

type Cell = string | number | null;

function cell(value: unknown, format: ColumnFormat | undefined, timeZone: string): Cell {
  if (value === null || value === undefined) return null;
  if (format === 'datetime' || format === 'date') {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const at = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isNaN(at)) return typeof value === 'string' ? value : null;
    const clock = labClock(timeZone);
    return format === 'date' ? clock.day(at) : clock.dateTime(at);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

/** The "workbook" as a CSV file, named like the server's export (.xlsx becomes .csv). */
export function buildWorkbook(sheets: SheetSpec[], filename: string, opts: { timeZone: string }): MockFile {
  const out: Cell[][] = [];
  const several = sheets.length > 1;
  sheets.forEach((spec, i) => {
    if (i > 0) out.push([]);
    if (spec.title) out.push([spec.title]);
    if (spec.subtitle) out.push([spec.subtitle]);
    if (spec.title || spec.subtitle) out.push([]);
    if (several) out.push([spec.name]);
    out.push(spec.columns.map((c) => c.header));
    for (const row of spec.rows) out.push(spec.columns.map((c) => cell(row[c.key], c.format, opts.timeZone)));
    if (spec.totals) out.push(spec.columns.map((c) => cell(spec.totals![c.key], c.format, opts.timeZone)));
  });
  return csvFile(filename.replace(/[^A-Za-z0-9._-]/g, '_'), out);
}

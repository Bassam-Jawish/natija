import type { z } from 'zod';
import { ctx } from '../db';
import { labTimezone } from './lab';

/** Validate input with a zod schema; ZodErrors become 400 problem responses. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data ?? {});
}

export function page<T>(items: T[], total: number) {
  return { items, total };
}

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

/**
 * Turn optional from/to calendar dates into an instant range [start, end) in the lab's time zone.
 * Defaults to today when both are missing.
 */
export async function dayRange(from?: string, to?: string): Promise<{ start: Date; end: Date }> {
  const tz = await labTimezone(ctx().labId);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const start = zonedDayStart(from ?? to ?? today, tz);
  const endDay = zonedDayStart(to ?? from ?? today, tz);
  return { start, end: new Date(endDay.getTime() + 86_400_000) };
}

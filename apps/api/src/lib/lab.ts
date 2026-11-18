import { eq } from 'drizzle-orm';
import { labs, type Lab } from '@natija/db';
import { appDb } from '../db';

const cache = new Map<string, { lab: Lab; at: number }>();

/** Lab profile (the labs table has no row-level security). Cached for 30 seconds. */
export async function getLab(labId: string): Promise<Lab> {
  const hit = cache.get(labId);
  if (hit && Date.now() - hit.at < 30_000) return hit.lab;
  const [lab] = await appDb.select().from(labs).where(eq(labs.id, labId));
  if (!lab) throw new Error(`Lab ${labId} not found`);
  cache.set(labId, { lab, at: Date.now() });
  return lab;
}

export function invalidateLab(labId: string): void {
  cache.delete(labId);
}

export async function labTimezone(labId: string): Promise<string> {
  return (await getLab(labId)).timezone;
}

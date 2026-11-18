/**
 * The three fictional demo labs with their staff, catalog, prices, doctors and analyzers, written
 * by the same seeder the server uses (packages/db), through the mock store's insert adapter.
 */
import { LABS, seedLab, type LabSeed } from '@natija/db/seed/data';
import { seedDb } from '../core/db';

export async function seedBase(): Promise<LabSeed[]> {
  const out: LabSeed[] = [];
  for (const def of LABS) out.push(await seedLab(seedDb as never, def, 'mock'));
  return out;
}

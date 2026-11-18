import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDb, createPool, OWNER_URL } from '../index';
import { LABS } from './labs-data';
import { seedLab, type LabSeed } from './seed-lab';

export { LABS } from './labs-data';
export type { LabSeed } from './seed-lab';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Natija@2026';

/**
 * Wipe all lab data and create the three demo labs with their catalog, staff, payers,
 * doctors and instruments. Patients, orders and results are added by the history seed
 * (apps/api/src/seed/history.ts), which goes through the API's own services.
 */
export async function seedBase(url = OWNER_URL): Promise<LabSeed[]> {
  const pool = createPool(url, 4);
  const db = createDb(pool);
  try {
    await db.execute(sql`truncate table labs restart identity cascade`);
    const out: LabSeed[] = [];
    for (const def of LABS) {
      out.push(await seedLab(db, def, DEMO_PASSWORD));
      console.log(`  ✓ ${def.nameEn} (${def.code})`);
    }
    return out;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('Seeding demo labs…');
  seedBase()
    .then(() => console.log(`Done. Demo password for every account: ${DEMO_PASSWORD}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

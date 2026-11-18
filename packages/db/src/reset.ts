import { runMigrations } from './migrate';
import { DEMO_PASSWORD, seedBase } from './seed/index';

/** Apply migrations, wipe lab data and seed the three demo labs (base data only). */
await runMigrations();
console.log('Migrations applied. Seeding demo labs…');
await seedBase();
console.log(`Base data ready. Demo password for every account: ${DEMO_PASSWORD}`);

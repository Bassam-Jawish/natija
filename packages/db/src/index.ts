import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export * from './schema';
export { schema };

export type DB = NodePgDatabase<typeof schema>;

/** Owner connection: migrations and seeding only. Superusers bypass row-level security. */
export const OWNER_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/natija';
/** Application connection: the natija_app role, always subject to row-level security. */
export const APP_URL = process.env.APP_DATABASE_URL ?? 'postgres://natija_app:natija_app_dev@localhost:5433/natija';

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
}

export function createDb(pool: pg.Pool): DB {
  return drizzle(pool, { schema });
}

/**
 * Runs once per `vitest` run: make sure PostgreSQL is up, create a throwaway database for this
 * run (so parallel runs never step on each other), apply migrations and the base demo data
 * (3 labs, staff, catalog, payers, instruments), and drop it afterwards.
 * Test workers inherit DATABASE_URL / APP_DATABASE_URL from here.
 */
import pg from 'pg';
import { startServer, PG_PORT } from '../../../scripts/pg.mjs';

export default async function setup() {
  const name = `natija_test_${process.pid}_${Date.now().toString(36)}`;
  await startServer({ databases: [] });
  const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PG_PORT}/postgres` });
  await admin.connect();
  // Clean up databases left by runs that crashed more than an hour ago.
  const stale = await admin.query(`select datname from pg_database where datname like 'natija_test_%'`);
  for (const row of stale.rows as Array<{ datname: string }>) {
    const created = parseInt(row.datname.split('_').pop() ?? '', 36);
    if (Number.isFinite(created) && Date.now() - created > 3_600_000) await admin.query(`drop database if exists "${row.datname}" with (force)`);
  }
  await admin.query(`create database "${name}" encoding 'UTF8'`);
  await admin.end();

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${PG_PORT}/${name}`;
  process.env.APP_DATABASE_URL = `postgres://natija_app:natija_app_dev@localhost:${PG_PORT}/${name}`;

  const { runMigrations } = await import('../../../packages/db/src/migrate');
  const { seedBase } = await import('../../../packages/db/src/seed/index');
  await runMigrations(process.env.DATABASE_URL);
  await seedBase(process.env.DATABASE_URL);

  return async () => {
    const c = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PG_PORT}/postgres` });
    await c.connect();
    await c.query(`drop database if exists "${name}" with (force)`);
    await c.end();
  };
}

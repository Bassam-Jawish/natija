// Local PostgreSQL 18 managed from Node (no Docker or system install needed).
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PG_PORT = Number(process.env.PG_PORT ?? 5433);
export const DATA_DIR = join(root, '.data', 'pg');
const APP_ROLE_PASSWORD = process.env.APP_DB_PASSWORD ?? 'natija_app_dev';

export function createServer() {
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
}

export async function isRunning() {
  const client = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PG_PORT}/postgres`, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/** Initialise (first run), start, and make sure the databases and the app role exist. */
export async function startServer({ databases = ['natija'] } = {}) {
  if (await isRunning()) {
    await ensureDatabases(databases);
    return null;
  }
  const server = createServer();
  if (!existsSync(join(DATA_DIR, 'PG_VERSION'))) {
    mkdirSync(dirname(DATA_DIR), { recursive: true });
    await server.initialise();
  }
  await server.start();
  await ensureDatabases(databases);
  return server;
}

export async function ensureDatabases(databases) {
  const client = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PG_PORT}/postgres` });
  await client.connect();
  try {
    const role = await client.query(`select 1 from pg_roles where rolname = 'natija_app'`);
    if (!role.rowCount) {
      await client.query(`create role natija_app login nobypassrls password '${APP_ROLE_PASSWORD.replace(/'/g, "''")}'`);
    }
    for (const name of databases) {
      const db = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (!db.rowCount) await client.query(`create database "${name}" encoding 'UTF8'`);
    }
  } finally {
    await client.end();
  }
}

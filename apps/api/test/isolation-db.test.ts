/**
 * Lab isolation at the database level: the application role (natija_app) is subject to
 * row-level security on every lab-owned table, whatever the API code does.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const APP_URL = process.env.APP_DATABASE_URL!;
const OWNER_URL = process.env.DATABASE_URL!;

let app: pg.Client;
let owner: pg.Client;
let labs: Record<string, string>;
let tenantTables: string[];

async function asLab<T>(labId: string | null, fn: () => Promise<T>): Promise<T> {
  await app.query('begin');
  try {
    if (labId) await app.query(`select set_config('app.lab_id', $1, true)`, [labId]);
    return await fn();
  } finally {
    await app.query('rollback');
  }
}

beforeAll(async () => {
  app = new pg.Client({ connectionString: APP_URL });
  owner = new pg.Client({ connectionString: OWNER_URL });
  await app.connect();
  await owner.connect();
  const rows = (await owner.query('select id, code from labs')).rows as Array<{ id: string; code: string }>;
  labs = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  tenantTables = (
    await owner.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by 1`,
    )
  ).rows.map((r: { relname: string }) => r.relname);
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('row-level security', () => {
  it('is enabled and forced on every table that has a lab_id, except the documented exemptions', async () => {
    const withLabId = (
      await owner.query(
        `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'lab_id' order by 1`,
      )
    ).rows.map((r: { table_name: string }) => r.table_name);
    const exempt = ['agents', 'sessions'];
    for (const t of withLabId.filter((t: string) => !exempt.includes(t))) expect(tenantTables).toContain(t);
    const notForced = await owner.query(
      `select relname from pg_class where relrowsecurity and not relforcerowsecurity and relnamespace = 'public'::regnamespace`,
    );
    expect(notForced.rowCount).toBe(0);
  });

  it('shows nothing when no lab is set', async () => {
    await asLab(null, async () => {
      for (const t of ['users', 'tests', 'payer_groups', 'instruments', 'roles']) {
        const r = await app.query(`select count(*)::int as n from ${t}`);
        expect(r.rows[0].n, t).toBe(0);
      }
    });
  });

  it('shows only the current lab’s rows', async () => {
    const yasmin = await asLab(labs.yasmin!, async () => (await app.query('select distinct lab_id from tests')).rows);
    expect(yasmin).toEqual([{ lab_id: labs.yasmin }]);
    const citadelUsers = await asLab(labs.citadel!, async () => (await app.query('select username from users')).rows.length);
    expect(citadelUsers).toBeGreaterThan(0);
  });

  it('refuses to write a row into another lab', async () => {
    await expect(
      asLab(labs.yasmin!, () =>
        app.query(`insert into departments (lab_id, code, name_ar, name_en) values ($1, 'X', 'س', 'X')`, [labs.orontes]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move a row to another lab', async () => {
    const updated = await asLab(labs.yasmin!, async () => {
      try {
        const r = await app.query(`update departments set lab_id = $1 where code = 'HEM'`, [labs.orontes]);
        return r.rowCount;
      } catch (e) {
        return String(e);
      }
    });
    expect(String(updated)).toMatch(/row-level security/);
  });

  it('cannot read another lab’s row even by its id', async () => {
    const orontesTest = (await owner.query(`select id from tests where lab_id = $1 limit 1`, [labs.orontes])).rows[0].id;
    const seen = await asLab(labs.yasmin!, async () => (await app.query('select id from tests where id = $1', [orontesTest])).rowCount);
    expect(seen).toBe(0);
  });

  it('keeps the audit log append-only for the application', async () => {
    await expect(asLab(labs.yasmin!, () => app.query(`update audit_log set summary = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(asLab(labs.yasmin!, () => app.query(`delete from audit_log`))).rejects.toThrow(/permission denied/);
  });

  it('application role cannot bypass row-level security', async () => {
    const r = await owner.query(`select rolbypassrls, rolsuper from pg_roles where rolname = 'natija_app'`);
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

// pnpm dev:full — the real backend: start PostgreSQL (embedded), apply migrations, then run the API
// and the web app against it. First run: also seeds the demo labs (or run `pnpm seed:demo`).
// Plain `pnpm dev` runs the web app alone in mock mode (no server, no database).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PG_PORT, startServer } from './pg.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const children = [];

function run(name, args, color) {
  const child = spawn(isWin ? 'pnpm.cmd' : 'pnpm', args, { cwd: root, env: { ...process.env, VITE_MOCK: 'false' }, shell: isWin });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on('data', (buf) =>
      buf
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => out.write(prefix + line + '\n')),
    );
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefix}exited (${code})`));
  children.push(child);
  return child;
}

function runOnce(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(isWin ? 'pnpm.cmd' : 'pnpm', args, { cwd: root, env: process.env, stdio: 'inherit', shell: isWin });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} failed (${code})`))));
  });
}

const server = await startServer({ databases: ['natija'] });
console.log(`PostgreSQL ready on port ${PG_PORT}.`);
await runOnce(['--filter', '@natija/db', 'run', 'migrate']);

const client = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PG_PORT}/natija` });
await client.connect();
const { rows } = await client.query('select count(*)::int as n from labs');
await client.end();
if (rows[0].n === 0) {
  console.log('Empty database: seeding the demo labs (first run only)…');
  await runOnce(['seed:demo']);
}

run('api', ['--filter', '@natija/api', 'run', 'dev'], '36');
run('web', ['--filter', '@natija/web', 'run', 'dev'], '35');
console.log('\nNatija is starting: open http://localhost:5173  (API on http://localhost:4310)\n');

const shutdown = async () => {
  children.forEach((c) => c.kill());
  if (server) await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

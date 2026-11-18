// pnpm start — production-style local run: build the web app, start PostgreSQL, migrate,
// then serve the API and the built web app together on http://localhost:4310.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PG_PORT, startServer } from './pg.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const pnpm = (args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(isWin ? 'pnpm.cmd' : 'pnpm', args, { cwd: root, env, stdio: 'inherit', shell: isWin });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} failed (${code})`))));
  });

// The web app is built for the real API here (the default build is the mock-mode app).
await pnpm(['--filter', '@natija/web', 'run', 'build'], { ...process.env, VITE_MOCK: 'false' });
const server = await startServer({ databases: ['natija'] });
console.log(`PostgreSQL ready on port ${PG_PORT}.`);
await pnpm(['--filter', '@natija/db', 'run', 'migrate']);
const env = {
  ...process.env,
  HOST: process.env.HOST ?? '0.0.0.0',
  PORT: process.env.PORT ?? '4310',
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:4310',
};
console.log(`\nNatija: open ${env.PUBLIC_URL}\n`);
try {
  await pnpm(['--filter', '@natija/api', 'run', 'start'], env);
} finally {
  if (server) await server.stop();
}

// pnpm db:start | db:stop | db:status
import { createServer, isRunning, PG_PORT, startServer } from './pg.mjs';

const command = process.argv[2] ?? 'start';

if (command === 'status') {
  console.log((await isRunning()) ? `PostgreSQL is running on port ${PG_PORT}.` : 'PostgreSQL is not running.');
  process.exit(0);
}

if (command === 'stop') {
  if (!(await isRunning())) {
    console.log('PostgreSQL is not running.');
    process.exit(0);
  }
  await createServer().stop();
  console.log('PostgreSQL stopped.');
  process.exit(0);
}

const server = await startServer({ databases: ['natija', 'natija_test'] });
if (!server) {
  console.log(`PostgreSQL is already running on port ${PG_PORT}.`);
  process.exit(0);
}
console.log(`PostgreSQL 18 is running on port ${PG_PORT}. Press Ctrl+C to stop it.`);
const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);

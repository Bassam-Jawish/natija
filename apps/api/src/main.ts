import { config } from './config';
import { appPool } from './db';
import { buildServer } from './server';
import { startOutboxWorker, stopOutboxWorker } from './services/outbox';
import { startBackgroundJobs, stopBackgroundJobs } from './services/jobs';

const app = await buildServer();

try {
  await app.listen({ port: config.port, host: config.host });
  startOutboxWorker();
  startBackgroundJobs();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async () => {
  stopOutboxWorker();
  stopBackgroundJobs();
  await app.close();
  await appPool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

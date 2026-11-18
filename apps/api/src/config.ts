import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, OWNER_URL } from '@natija/db';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const isProd = process.env.NODE_ENV === 'production';
const DEV_SECRET = 'dev-only-secret-change-me-0123456789abcdef0123456789';

export const config = {
  repoRoot,
  isProd,
  port: Number(process.env.PORT ?? 4310),
  host: process.env.HOST ?? '127.0.0.1',
  appDatabaseUrl: APP_URL,
  ownerDatabaseUrl: OWNER_URL,
  secret: process.env.APP_SECRET ?? DEV_SECRET,
  /** Absolute session lifetime and idle timeout. */
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  idleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 120),
  storageDir: process.env.STORAGE_DIR ?? join(repoRoot, 'storage'),
  webDist: join(repoRoot, 'apps', 'web', 'dist'),
  /** Demo mode shows the demo accounts on the sign-in page and labels simulated messages. */
  demoMode: process.env.DEMO_MODE !== 'false',
  /** Address patients use to open their report links. */
  publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  trustProxy: process.env.TRUST_PROXY === 'true',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Sign-in attempts allowed per IP per minute (relaxed in tests). */
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT ?? 10),
};

if (isProd && config.secret === DEV_SECRET) {
  throw new Error('APP_SECRET must be set in production.');
}

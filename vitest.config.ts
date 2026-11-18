import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    // API test files share this run's database; run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Creates a throwaway database per run and sets DATABASE_URL / APP_DATABASE_URL for the workers.
    globalSetup: ['apps/api/test/global-setup.ts'],
    env: {
      DEMO_MODE: 'true',
      LOG_LEVEL: 'silent',
      LOGIN_RATE_LIMIT: '1000',
      NODE_ENV: 'test',
    },
  },
});

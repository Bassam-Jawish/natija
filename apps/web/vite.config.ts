import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Mock mode (the default): the shared seeder hashes passwords with Node's crypto, which the
 * browser doesn't have; the mock accepts any password, so it gets a stub instead.
 */
function mockStubs(): Plugin {
  const stub = fileURLToPath(new URL('./src/mock/core/password-stub.ts', import.meta.url));
  return {
    name: 'natija-mock-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './password' && importer && /seed[\\/]seed-lab\.ts$/.test(importer)) return stub;
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const mock = (process.env.VITE_MOCK ?? env.VITE_MOCK) !== 'false';
  // `pnpm build:offline`: one self-contained HTML file (scripts, styles and fonts inlined) that
  // opens straight from the disk, with hash routes and mock mode.
  const offline = process.env.NATIJA_OFFLINE === '1';
  if (offline) {
    return {
      plugins: [react(), tailwindcss(), mockStubs()],
      base: './',
      resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
      define: { 'import.meta.env.VITE_MOCK': '"true"', 'import.meta.env.VITE_ROUTER': '"hash"' },
      build: {
        outDir: 'dist-offline',
        emptyOutDir: true,
        sourcemap: false,
        cssCodeSplit: false,
        assetsInlineLimit: () => true,
        chunkSizeWarningLimit: 20_000,
        rollupOptions: { output: { codeSplitting: false } },
      },
    };
  }
  return {
    plugins: [react(), tailwindcss(), mockStubs()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      strictPort: true,
      // Only with the real backend (VITE_MOCK=false, `pnpm dev:full`).
      proxy: mock
        ? undefined
        : {
            '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false },
            '/health': { target: 'http://127.0.0.1:4310' },
          },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 4000,
    },
  };
});

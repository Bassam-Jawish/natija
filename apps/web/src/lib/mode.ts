/**
 * Mock mode (the default): the app answers its own API calls inside the browser, from demo data
 * kept in this browser, so it runs with no server, no database and no internet. Build or start
 * with VITE_MOCK=false to use the real API instead (`pnpm dev:full`).
 */
export const MOCK = import.meta.env.VITE_MOCK !== 'false';

/** Hash routes (…/index.html#/orders) for the offline build that opens straight from a file. */
export const HASH_ROUTER = import.meta.env.VITE_ROUTER === 'hash';

type MockModule = typeof import('../mock');
let mock: MockModule | null = null;

/** The mock API, loaded on first use (it stays out of the real-API build). */
export async function loadMock(): Promise<MockModule> {
  mock ??= await import('../mock');
  return mock;
}

/** The mock API if it has been loaded already (for synchronous lookups such as file links). */
export function loadedMock(): MockModule | null {
  return mock;
}

/** Mock mode: save the latest changes before another tab (print page, patient link) reads them. */
export async function persistMock(): Promise<void> {
  if (MOCK) await (await loadMock()).persistNow();
}

/** An in-app path as a URL the browser can open (with hash routes, the path goes after #). */
export function appUrl(path: string): string {
  return HASH_ROUTER ? `${window.location.pathname}${window.location.search}#${path}` : path;
}

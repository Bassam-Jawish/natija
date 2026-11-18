/**
 * Mock mode: the web app answers its own API calls inside the browser, from demo data kept in
 * this browser. No server, no database and no internet are needed. Any lab code, user name and
 * password signs in; the e-signature and the patients' access codes accept anything too.
 *
 * Layout: core/ (store, router, helpers), modules/ (one folder per API area, mirroring
 * apps/api/src/modules), seed/ (the demo labs and their month of history).
 */
import './core/polyfills';
import { setClock, withContext } from './core/context';
import { emptyState, find, replaceState, state, STATE_VERSION } from './core/db';
import { MockFile } from './core/file';
import { beginEvents, flushEvents, publish, resetAuditHeads, subscribe } from './core/lib';
import { clearState, flushSave, hasPendingSave, loadState, onOtherTabSaved, saveState, scheduleSave } from './core/persist';
import { dispatch, type MockResponse } from './core/router';
import { currentAuth, signOut } from './modules/auth';
import { registerAll } from './modules';
import { seedBase } from './seed/base';
import { seedHistory } from './seed/history';

export { MockFile };

let booted: Promise<void> | null = null;

async function createDemoData(onProgress?: (message: string) => void): Promise<void> {
  replaceState(emptyState());
  resetAuditHeads();
  onProgress?.('labs');
  await seedBase();
  onProgress?.('history');
  await seedHistory(onProgress);
  setClock(null);
  state.seededAt = Date.now();
  await saveState(state, true);
}

/** Load the saved demo data, or create it on first use (about a month of work in three labs). */
export function bootMock(onProgress?: (message: string) => void): Promise<void> {
  booted ??= (async () => {
    registerAll();
    onOtherTabSaved(() => void reloadFromOtherTab());
    const saved = await loadState();
    if (saved && saved.version === STATE_VERSION && saved.seededAt) {
      replaceState(saved);
      resetAuditHeads();
      return;
    }
    await createDemoData(onProgress);
  })();
  return booted;
}

/** Another tab (a print page, a patient link) saved changes: take them, unless this tab has its own waiting. */
async function reloadFromOtherTab(): Promise<void> {
  if (hasPendingSave()) return;
  const saved = await loadState();
  if (!saved || saved.version !== STATE_VERSION) return;
  replaceState(saved);
  resetAuditHeads();
  publish({ type: 'mock.synced' });
}

/** Save now (call before opening another tab that should see the latest changes). */
export async function persistNow(): Promise<void> {
  await flushSave();
}

/** Throw away every change and create the demo data again. */
export async function resetMock(onProgress?: (message: string) => void): Promise<void> {
  await bootMock();
  signOut();
  await clearState();
  await createDemoData(onProgress);
}

let chain: Promise<unknown> = Promise.resolve();

/** Answer one API call (path after /api/v1, with its query string). Calls run one at a time. */
export function mockRequest(method: string, path: string, body?: unknown): Promise<MockResponse> {
  const run = async (): Promise<MockResponse> => {
    await bootMock();
    const write = method.toUpperCase() !== 'GET';
    beginEvents();
    let res: MockResponse | undefined;
    try {
      res = await dispatch(method, path, body, currentAuth());
      return res;
    } finally {
      const ok = !!res && res.status < 400;
      flushEvents(ok);
      if (write && ok) scheduleSave(() => state);
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

/** Live updates for the signed-in user (stands in for the server's event stream). */
export function subscribeMock(fn: (type: string, data: unknown) => void): () => void {
  return subscribe((event) => {
    const auth = currentAuth();
    if (!auth) return;
    if (event.labId && event.labId !== auth.labId) return;
    if (event.userIds && !event.userIds.includes(auth.userId)) return;
    fn(event.type, event.data ?? {});
  });
}

/** A data URL for an uploaded patient file, for <img> and links (no server to fetch from). */
export function mockFileUrl(path: string): string | null {
  const m = /^\/patients\/[^/]+\/attachments\/([^/?]+)/.exec(path);
  const auth = currentAuth();
  if (!m || !auth) return null;
  return withContext({ labId: auth.labId, userId: auth.userId, actorName: auth.user.fullNameEn, auth }, () => {
    const row = find('patientAttachments', m[1]);
    return row ? (state.files[row.storageKey] ?? null) : null;
  });
}

/** Run an export route and hand the file to the browser (Excel exports come out as CSV in mock mode). */
export async function mockDownload(path: string): Promise<void> {
  const res = await mockRequest('GET', path);
  if (res.status >= 400) throw Object.assign(new Error((res.data as { title?: string })?.title ?? 'Export failed'), { status: res.status });
  const file = res.data instanceof MockFile ? res.data : new MockFile('export.json', 'application/json', JSON.stringify(res.data, null, 2));
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

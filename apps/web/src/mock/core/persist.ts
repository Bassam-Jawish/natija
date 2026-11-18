/**
 * Keeps the mock data in this browser (IndexedDB), so records added in mock mode survive a reload.
 * Each table is stored per lab under its own key, and a save writes only the parts that changed,
 * so a click doesn't rewrite the whole month of demo data. When the browser refuses storage (some
 * private windows), the data simply lives until the tab is closed.
 */
import { dirtyParts, type StoreState } from './db';

const DB_NAME = 'natija-mock';
const STORE = 'state';
const META = 'meta';
const PART = 'part:';

/** Tables that only ever grow: stored in blocks, so a save writes just the newest block. */
const APPEND_ONLY = new Set(['auditLog', 'resultAttempts', 'sampleEvents']);
const BLOCK = 4000;

type Meta = Omit<StoreState, 'data'> & { parts: string[]; blocks?: Record<string, number> };

/** Rows of each append-only part already saved by this tab (to find the new block). */
const savedLength = new Map<string, number>();

/** Remember what is in the browser's storage now (after loading or saving). */
export function rememberSaved(snapshot: StoreState): void {
  savedLength.clear();
  for (const [table, parts] of Object.entries(snapshot.data)) {
    if (!APPEND_ONLY.has(table)) continue;
    for (const [part, list] of Object.entries(parts)) savedLength.set(`${table}|${part}`, list.length);
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transaction(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => void): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadState(): Promise<StoreState | null> {
  try {
    if (typeof indexedDB === 'undefined') return null;
    const db = await open();
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const meta = (await request(store.get(META))) as Meta | undefined;
      if (!meta) return null;
      type Rows = StoreState['data'][string][string];
      const data: StoreState['data'] = {};
      const lists = await Promise.all(
        meta.parts.map(async (key) => {
          const blocks = meta.blocks?.[key];
          if (blocks === undefined) return ((await request(store.get(PART + key))) as Rows | undefined) ?? [];
          const parts = await Promise.all(Array.from({ length: blocks }, (_, i) => request(store.get(`${PART}${key}#${i}`)) as Promise<Rows | undefined>));
          return parts.flatMap((b) => b ?? []);
        }),
      );
      meta.parts.forEach((key, i) => {
        const [table, part] = key.split('|') as [string, string];
        (data[table] ??= {})[part] = lists[i] ?? [];
      });
      const { parts: _parts, blocks: _blocks, ...rest } = meta;
      const loaded = { ...rest, data };
      rememberSaved(loaded);
      return loaded;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('[mock] could not read saved data', err);
    return null;
  }
}

/** Save the changed table parts (or all of them) and the counters. */
export async function saveState(snapshot: StoreState, all = false): Promise<void> {
  const keys: string[] = [];
  for (const [table, parts] of Object.entries(snapshot.data)) for (const part of Object.keys(parts)) keys.push(`${table}|${part}`);
  const changed = all ? keys : keys.filter((k) => dirtyParts.has(k));
  dirtyParts.clear();
  try {
    if (typeof indexedDB === 'undefined') return;
    const { data, ...rest } = snapshot;
    const blocks: Record<string, number> = {};
    for (const key of keys) {
      const [table, part] = key.split('|') as [string, string];
      if (APPEND_ONLY.has(table)) blocks[key] = Math.ceil((data[table]?.[part]?.length ?? 0) / BLOCK);
    }
    const meta: Meta = { ...rest, parts: keys, blocks };
    await transaction('readwrite', (store) => {
      if (all) store.clear();
      store.put(meta, META);
      for (const key of changed) {
        const [table, part] = key.split('|') as [string, string];
        const rows = data[table]?.[part] ?? [];
        if (!APPEND_ONLY.has(table)) {
          store.put(rows, PART + key);
          continue;
        }
        // Append-only: rewrite from the block holding the first unsaved row (everything if rows were removed).
        const before = all ? 0 : (savedLength.get(key) ?? 0);
        const from = rows.length < before ? 0 : Math.floor(before / BLOCK);
        for (let b = from; b < blocks[key]!; b++) store.put(rows.slice(b * BLOCK, (b + 1) * BLOCK), `${PART}${key}#${b}`);
        savedLength.set(key, rows.length);
      }
    });
  } catch (err) {
    console.warn('[mock] could not save data', err);
  }
}

export async function clearState(): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return;
    await transaction('readwrite', (store) => store.clear());
  } catch (err) {
    console.warn('[mock] could not clear saved data', err);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: (() => StoreState) | null = null;

/** Tells other tabs of this app that the saved data changed (print pages, patient links). */
const TAB_ID = Math.random().toString(36).slice(2);
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('natija-mock');
// In Node (scripts), don't keep the process alive for this channel.
(channel as unknown as { unref?: () => void } | null)?.unref?.();

async function saveAndAnnounce(snapshot: StoreState): Promise<void> {
  await saveState(snapshot);
  channel?.postMessage({ type: 'saved', from: TAB_ID });
}

/** Save shortly after the last change (changes come in bursts). */
export function scheduleSave(snapshot: () => StoreState, delayMs = 400): void {
  pending = snapshot;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const take = pending;
    pending = null;
    if (take) void saveAndAnnounce(take());
  }, delayMs);
}

/** Save now if a save is waiting (before opening another tab that reads the data). */
export async function flushSave(): Promise<void> {
  if (!pending) return;
  if (timer) clearTimeout(timer);
  timer = null;
  const take = pending;
  pending = null;
  await saveAndAnnounce(take());
}

/** Run `fn` when another tab saved its changes. */
export function onOtherTabSaved(fn: () => void): void {
  channel?.addEventListener('message', (ev: MessageEvent<{ type?: string; from?: string }>) => {
    if (ev.data?.type === 'saved' && ev.data.from !== TAB_ID) fn();
  });
}

/** True while this tab has changes not saved yet. */
export function hasPendingSave(): boolean {
  return pending !== null;
}

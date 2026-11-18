import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { createDb, createPool } from '@natija/db';
import { config } from './config';

/** Pool for the natija_app role. Row-level security applies to everything it does. */
export const appPool = createPool(config.appDatabaseUrl, 20);
export const appDb = createDb(appPool);

export type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

export type LabContext = {
  tx: Tx;
  labId: string;
  userId: string | null;
  actorName: string | null;
  ip: string | null;
  userAgent: string | null;
  afterCommit: Array<() => void | Promise<void>>;
};

const storage = new AsyncLocalStorage<LabContext>();

export type ContextMeta = {
  userId?: string | null;
  actorName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Run `fn` inside one transaction scoped to a lab: `app.lab_id` is set for the transaction,
 * so row-level security limits every query to that lab. Nested calls for the same lab reuse
 * the outer transaction. Callbacks registered with afterCommit run once the commit succeeds.
 */
export async function withLab<T>(labId: string, meta: ContextMeta, fn: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  if (current && current.labId === labId) return fn();
  const afterCommit: LabContext['afterCommit'] = [];
  const result = await appDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.lab_id', ${labId}, true)`);
    return storage.run(
      {
        tx,
        labId,
        userId: meta.userId ?? null,
        actorName: meta.actorName ?? null,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        afterCommit,
      },
      fn,
    );
  });
  for (const cb of afterCommit) {
    try {
      await cb();
    } catch (err) {
      console.error('afterCommit callback failed', err);
    }
  }
  return result;
}

/** The current lab context. Throws when called outside withLab(). */
export function ctx(): LabContext {
  const store = storage.getStore();
  if (!store) throw new Error('No lab context: wrap the call in withLab()');
  return store;
}

export function hasCtx(): boolean {
  return storage.getStore() !== undefined;
}

/** The current transaction. */
export function db(): Tx {
  return ctx().tx;
}

/** Run after the surrounding transaction commits (events, emails). Runs at once outside a context. */
export function afterCommit(cb: () => void | Promise<void>): void {
  const store = storage.getStore();
  if (store) store.afterCommit.push(cb);
  else void cb();
}

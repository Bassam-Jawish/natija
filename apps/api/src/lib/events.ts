import { EventEmitter } from 'node:events';
import { afterCommit, ctx, hasCtx } from '../db';

/**
 * Live events pushed to browsers over server-sent events.
 * `userIds` limits delivery to those users; otherwise every signed-in user of the lab gets it.
 * Event types used across modules: notification, results.changed, orders.changed,
 * samples.changed, instruments.changed, integration.message, finance.changed.
 */
export type LabEvent = { type: string; data?: unknown; userIds?: string[] };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function subscribe(labId: string, listener: (event: LabEvent) => void): () => void {
  emitter.on(labId, listener);
  return () => emitter.off(labId, listener);
}

/** Publish once the current transaction commits (immediately when there is no transaction). */
export function publish(event: LabEvent, labId?: string): void {
  const target = labId ?? (hasCtx() ? ctx().labId : undefined);
  if (!target) return;
  afterCommit(() => {
    emitter.emit(target, event);
  });
}

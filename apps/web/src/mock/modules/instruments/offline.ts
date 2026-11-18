/**
 * Silent analyzers go offline (port of apps/api/src/modules/instruments/offline.ts). An analyzer
 * behind a real Lab Agent that has been silent (no heartbeat confirming its link, no message)
 * for 5 minutes is marked offline; analyzers that only get simulated traffic (no agent, or the
 * virtual agent) are left alone. The server runs this as a job every minute; mock mode starts
 * no timers, so the screens that show instrument status run it when they are read.
 */
import { ctx, now, withContext } from '../../core/context';
import { find, rows, update } from '../../core/db';
import { audit, publish } from '../../core/lib';
import { logIntegrationEvent } from './ingest';

export const OFFLINE_AFTER_MS = 5 * 60_000;

/** Run the offline check for the signed-in lab, as the system (no user). */
export function markSilentInstrumentsOffline(): void {
  const cutoff = now().getTime() - OFFLINE_AFTER_MS;
  const silent = rows('instruments').flatMap((inst) => {
    if (inst.status !== 'online' || !inst.isActive || !inst.agentId) return [];
    const agent = find('agents', inst.agentId);
    if (!agent || agent.isVirtual) return [];
    const last = Math.max(inst.lastSeenAt ? new Date(inst.lastSeenAt).getTime() : 0, inst.lastMessageAt ? new Date(inst.lastMessageAt).getTime() : 0);
    return last < cutoff ? [{ inst, agentName: agent.name }] : [];
  });
  if (!silent.length) return;
  withContext({ ...ctx(), userId: null, actorName: 'system' }, () => {
    for (const { inst, agentName } of silent) {
      update('instruments', inst, { status: 'offline' });
      const detail = `No heartbeat or message for ${OFFLINE_AFTER_MS / 60_000} minutes (Lab Agent "${agentName}")`;
      logIntegrationEvent({ instrumentId: inst.id, level: 'warn', event: 'offline', detail });
      audit({ action: 'instrument.offline', entityType: 'instrument', entityId: inst.id, summary: `${inst.code}: ${detail}`, before: { status: 'online' }, after: { status: 'offline' } });
    }
    publish({ type: 'instruments.changed', data: { offline: silent.map((s) => s.inst.id) } });
  });
}

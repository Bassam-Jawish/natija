import { and, eq, sql } from 'drizzle-orm';
import { agents, instruments, labs } from '@natija/db';
import { appDb, db, withLab } from '../../db';
import { audit } from '../../lib/audit';
import { publish } from '../../lib/events';
import { logIntegrationEvent } from '../../services/ingest';

export const OFFLINE_AFTER_MS = 5 * 60_000;

/**
 * Background job: an analyzer behind a real Lab Agent that has been silent (no heartbeat
 * confirming its link, no message) for 5 minutes is marked offline. Instruments that only
 * get simulated traffic (no agent, or the virtual agent) are left alone.
 */
export async function markSilentInstrumentsOffline(): Promise<void> {
  const labRows = await appDb.select({ id: labs.id }).from(labs).where(eq(labs.status, 'active'));
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);
  for (const lab of labRows) {
    await withLab(lab.id, { actorName: 'system' }, async () => {
      const silent = await db()
        .select({ id: instruments.id, code: instruments.code, agentName: agents.name })
        .from(instruments)
        .innerJoin(agents, and(eq(agents.id, instruments.agentId), eq(agents.labId, lab.id)))
        .where(
          and(
            eq(instruments.status, 'online'),
            eq(instruments.isActive, true),
            eq(agents.isVirtual, false),
            sql`coalesce(greatest(${instruments.lastSeenAt}, ${instruments.lastMessageAt}), 'epoch'::timestamptz) < ${cutoff}`,
          ),
        );
      for (const inst of silent) {
        await db().update(instruments).set({ status: 'offline' }).where(and(eq(instruments.id, inst.id), eq(instruments.status, 'online')));
        const detail = `No heartbeat or message for ${OFFLINE_AFTER_MS / 60_000} minutes (Lab Agent "${inst.agentName}")`;
        await logIntegrationEvent({ instrumentId: inst.id, level: 'warn', event: 'offline', detail });
        await audit({ action: 'instrument.offline', entityType: 'instrument', entityId: inst.id, summary: `${inst.code}: ${detail}`, before: { status: 'online' }, after: { status: 'offline' } });
      }
      if (silent.length) publish({ type: 'instruments.changed', data: { offline: silent.map((s) => s.id) } });
    });
  }
}

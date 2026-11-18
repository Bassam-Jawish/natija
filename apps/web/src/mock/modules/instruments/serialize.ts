/**
 * Instrument list items with today's counts, agent references, model profile summaries and the
 * integration event log (port of apps/api/src/modules/instruments/serialize.ts).
 */
import { PROFILES, type InstrumentModel } from '@natija/protocols';
import type { InstrumentAgentRef, InstrumentListItem, InstrumentProfileSummary, IntegrationEventItem } from '@natija/contracts';
import { now } from '../../core/context';
import { by, find, rows, type Row } from '../../core/db';
import { dayRange } from '../../core/lib';
import { byText, newestFirst } from './helpers';
import { iso } from './ingest';

/** An agent counts as online when it sent a heartbeat within this window (heartbeats every 30 s). */
export const AGENT_ONLINE_MS = 90_000;

export function profileSummary(model: string): InstrumentProfileSummary | null {
  if (!Object.hasOwn(PROFILES, model)) return null;
  const p = PROFILES[model as InstrumentModel];
  return {
    model: p.model,
    name: p.name,
    manufacturer: p.manufacturer,
    protocol: p.protocol,
    transport: p.transport,
    defaultPort: p.defaultPort,
    serial: p.serial ?? null,
    bidirectional: p.bidirectional,
    department: p.department,
    confidence: p.confidence,
    specimenIdMax: p.specimenIdMax ?? null,
    note: p.note,
    tests: p.tests.map((t) => ({ code: t.code, analyte: t.analyte, unit: t.unit })),
  };
}

/** Online: the virtual agent while it is active; a real agent with a recent heartbeat (never, in mock mode). */
export function agentOnline(a: { status: string; isVirtual: boolean; lastHeartbeatAt: Date | null }): boolean {
  return a.isVirtual ? a.status === 'active' : !!a.lastHeartbeatAt && now().getTime() - new Date(a.lastHeartbeatAt).getTime() < AGENT_ONLINE_MS;
}

export function agentRef(a: { id: string; name: string; status: 'pending' | 'active' | 'revoked'; isVirtual: boolean; lastHeartbeatAt: Date | null }): InstrumentAgentRef {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    isVirtual: a.isVirtual,
    lastHeartbeatAt: iso(a.lastHeartbeatAt),
    online: agentOnline(a),
  };
}

/** Instruments with their department, agent and today's counts. */
export function listInstruments(opts: { ids?: string[]; includeInactive?: boolean } = {}): InstrumentListItem[] {
  let list: Array<Row<'instruments'>>;
  if (opts.ids) {
    if (!opts.ids.length) return [];
    const ids = new Set(opts.ids);
    list = rows('instruments').filter((i) => ids.has(i.id));
  } else {
    list = rows('instruments').filter((i) => opts.includeInactive || i.isActive);
  }
  if (!list.length) return [];
  list.sort((a, b) => byText(a.code, b.code));

  const { start } = dayRange();
  return list.map((i) => {
    const d = i.departmentId ? find('departments', i.departmentId) : undefined;
    const agent = i.agentId ? find('agents', i.agentId) : undefined;
    const today = by('integrationMessages', 'instrumentId', i.id).filter((m) => m.receivedAt.getTime() >= start.getTime());
    return {
      id: i.id,
      code: i.code,
      name: i.name,
      model: i.model,
      manufacturer: i.manufacturer,
      protocol: i.protocol,
      transport: i.transport,
      host: i.host,
      port: i.port,
      serialPort: i.serialPort,
      baudRate: i.baudRate,
      department: d ? { id: d.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn } : null,
      agent: agent ? agentRef(agent) : null,
      status: i.status,
      integrationLevel: i.integrationLevel,
      isSimulated: i.isSimulated,
      isActive: i.isActive,
      lastMessageAt: iso(i.lastMessageAt),
      lastSeenAt: iso(i.lastSeenAt),
      counts: {
        messagesToday: today.length,
        errorsToday: today.filter((m) => m.status === 'error').length,
        openReview: by('reviewItems', 'instrumentId', i.id).filter((r) => r.status === 'open').length,
        mappings: by('instrumentMappings', 'instrumentId', i.id).filter((m) => m.isActive).length,
      },
    };
  });
}

export function listEvents(filter: { instrumentId?: string; agentId?: string; level?: 'info' | 'warn' | 'error'; limit: number; offset: number }): { items: IntegrationEventItem[]; total: number } {
  const source = filter.instrumentId ? by('integrationEvents', 'instrumentId', filter.instrumentId) : rows('integrationEvents');
  const matching = source.filter((e) => (!filter.agentId || e.agentId === filter.agentId) && (!filter.level || e.level === filter.level));
  const items = newestFirst(matching, (e) => e.at)
    .slice(filter.offset, filter.offset + filter.limit)
    .map((e) => ({
      id: e.id,
      instrumentId: e.instrumentId,
      instrumentCode: (e.instrumentId ? find('instruments', e.instrumentId)?.code : null) ?? null,
      agentId: e.agentId,
      level: e.level,
      event: e.event,
      detail: e.detail,
      at: e.at.toISOString(),
    }));
  return { items, total: matching.length };
}

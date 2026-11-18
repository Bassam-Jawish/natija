import { and, asc, count, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { agents, departments, instrumentMappings, instruments, integrationEvents, integrationMessages, reviewItems } from '@natija/db';
import { PROFILES, type InstrumentModel } from '@natija/protocols';
import type { InstrumentAgentRef, InstrumentListItem, InstrumentProfileSummary, IntegrationEventItem } from '@natija/contracts';
import { ctx, db } from '../../db';
import { dayRange } from '../../lib/http';
import { iso } from '../../services/ingest';

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

export function agentRef(a: { id: string; name: string; status: 'pending' | 'active' | 'revoked'; isVirtual: boolean; lastHeartbeatAt: Date | null }): InstrumentAgentRef {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    isVirtual: a.isVirtual,
    lastHeartbeatAt: iso(a.lastHeartbeatAt),
    online: a.isVirtual ? a.status === 'active' : !!a.lastHeartbeatAt && Date.now() - a.lastHeartbeatAt.getTime() < AGENT_ONLINE_MS,
  };
}

/** Instruments with their department, agent and today's counts. */
export async function listInstruments(opts: { ids?: string[]; includeInactive?: boolean } = {}): Promise<InstrumentListItem[]> {
  const conditions: SQL[] = [];
  if (opts.ids) {
    if (!opts.ids.length) return [];
    conditions.push(inArray(instruments.id, opts.ids));
  }
  if (!opts.includeInactive && !opts.ids) conditions.push(eq(instruments.isActive, true));
  const rows = await db()
    .select({ i: instruments, d: { id: departments.id, code: departments.code, nameAr: departments.nameAr, nameEn: departments.nameEn } })
    .from(instruments)
    .leftJoin(departments, eq(departments.id, instruments.departmentId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(instruments.code));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.i.id);

  const agentIds = [...new Set(rows.map((r) => r.i.agentId).filter((x): x is string => !!x))];
  const agentRows = agentIds.length
    ? await db()
        .select({ id: agents.id, name: agents.name, status: agents.status, isVirtual: agents.isVirtual, lastHeartbeatAt: agents.lastHeartbeatAt })
        .from(agents)
        .where(and(eq(agents.labId, ctx().labId), inArray(agents.id, agentIds)))
    : [];
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  const { start } = await dayRange();
  const messageCounts = await db()
    .select({
      instrumentId: integrationMessages.instrumentId,
      total: count(),
      errors: sql<number>`count(*) filter (where ${integrationMessages.status} = 'error')`.mapWith(Number),
    })
    .from(integrationMessages)
    .where(and(inArray(integrationMessages.instrumentId, ids), gte(integrationMessages.receivedAt, start)))
    .groupBy(integrationMessages.instrumentId);
  const reviewCounts = await db()
    .select({ instrumentId: reviewItems.instrumentId, n: count() })
    .from(reviewItems)
    .where(and(inArray(reviewItems.instrumentId, ids), eq(reviewItems.status, 'open')))
    .groupBy(reviewItems.instrumentId);
  const mappingCounts = await db()
    .select({ instrumentId: instrumentMappings.instrumentId, n: count() })
    .from(instrumentMappings)
    .where(and(inArray(instrumentMappings.instrumentId, ids), eq(instrumentMappings.isActive, true)))
    .groupBy(instrumentMappings.instrumentId);
  const msg = new Map(messageCounts.map((c) => [c.instrumentId, c]));
  const rev = new Map(reviewCounts.map((c) => [c.instrumentId, c.n]));
  const maps = new Map(mappingCounts.map((c) => [c.instrumentId, c.n]));

  return rows.map(({ i, d }) => {
    const agent = i.agentId ? agentById.get(i.agentId) : undefined;
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
      department: d && d.id ? { id: d.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn } : null,
      agent: agent ? agentRef(agent) : null,
      status: i.status,
      integrationLevel: i.integrationLevel,
      isSimulated: i.isSimulated,
      isActive: i.isActive,
      lastMessageAt: iso(i.lastMessageAt),
      lastSeenAt: iso(i.lastSeenAt),
      counts: {
        messagesToday: msg.get(i.id)?.total ?? 0,
        errorsToday: msg.get(i.id)?.errors ?? 0,
        openReview: rev.get(i.id) ?? 0,
        mappings: maps.get(i.id) ?? 0,
      },
    };
  });
}

export async function listEvents(filter: { instrumentId?: string; agentId?: string; level?: 'info' | 'warn' | 'error'; limit: number; offset: number }): Promise<{ items: IntegrationEventItem[]; total: number }> {
  const conditions: SQL[] = [];
  if (filter.instrumentId) conditions.push(eq(integrationEvents.instrumentId, filter.instrumentId));
  if (filter.agentId) conditions.push(eq(integrationEvents.agentId, filter.agentId));
  if (filter.level) conditions.push(eq(integrationEvents.level, filter.level));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db()
    .select({ e: integrationEvents, code: instruments.code })
    .from(integrationEvents)
    .leftJoin(instruments, eq(instruments.id, integrationEvents.instrumentId))
    .where(where)
    .orderBy(desc(integrationEvents.at))
    .limit(filter.limit)
    .offset(filter.offset);
  const [total] = await db().select({ n: count() }).from(integrationEvents).where(where);
  return {
    items: rows.map(({ e, code }) => ({
      id: e.id,
      instrumentId: e.instrumentId,
      instrumentCode: code ?? null,
      agentId: e.agentId,
      level: e.level,
      event: e.event,
      detail: e.detail,
      at: e.at.toISOString(),
    })),
    total: total?.n ?? 0,
  };
}

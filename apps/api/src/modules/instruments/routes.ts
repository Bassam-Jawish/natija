import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, ne, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { agents, analytes, departments, instrumentMappings, instruments, integrationMessages, resultAttempts, results, reviewItems, type Instrument } from '@natija/db';
import { MODELS, PROFILES, type InstrumentModel } from '@natija/protocols';
import {
  faultsFor,
  instrumentCreateBody,
  instrumentListQuery,
  instrumentUpdateBody,
  mappingBody,
  mappingUpdateBody,
  messagesQuery,
  eventsQuery,
  simulateBody,
  type InstrumentDetail,
  type InstrumentFormData,
  type InstrumentListItem,
  type InstrumentMappingItem,
  type InstrumentProfileSummary,
  type IntegrationMessageDetail,
  type IntegrationMessageItem,
  type IntegrationParsed,
  type SimulateResponse,
} from '@natija/contracts';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { assertFound, badRequest, conflict } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange, page, parse } from '../../lib/http';
import { registerJob } from '../../services/jobs';
import { iso } from '../../services/ingest';
import { markSilentInstrumentsOffline } from './offline';
import { listEvents, listInstruments, profileSummary } from './serialize';
import { simulateOnInstrument } from './simulate';

registerJob({ name: 'instruments.offline', everyMs: 60_000, run: markSilentInstrumentsOffline });

const idParams = z.object({ id: z.string().uuid() });
const mappingParams = z.object({ id: z.string().uuid(), mappingId: z.string().uuid() });

async function loadInstrument(id: string): Promise<Instrument> {
  const [row] = await db().select().from(instruments).where(eq(instruments.id, id));
  return assertFound(row, 'instrument_not_found');
}

async function checkRefs(input: { agentId?: string | null; departmentId?: string | null }): Promise<void> {
  if (input.agentId) {
    // agents has no row-level security: always filter by the lab.
    const [agent] = await db()
      .select({ status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.labId, ctx().labId)));
    if (!agent) throw badRequest('agent_not_found');
    if (agent.status === 'revoked') throw badRequest('agent_revoked');
  }
  if (input.departmentId) {
    const [dep] = await db().select({ id: departments.id }).from(departments).where(eq(departments.id, input.departmentId));
    if (!dep) throw badRequest('department_not_found');
  }
}

/** Code mappings from the model's default test menu for analytes the lab has (existing codes are skipped). */
async function createDefaultMappings(inst: Instrument): Promise<number> {
  if (inst.model === 'other') return 0;
  const tests = PROFILES[inst.model].tests;
  const analyteRows = await db()
    .select({ id: analytes.id, code: analytes.code })
    .from(analytes)
    .where(inArray(analytes.code, tests.map((t) => t.analyte)));
  const byCode = new Map(analyteRows.map((a) => [a.code, a.id]));
  const values = tests
    .filter((t) => byCode.has(t.analyte))
    .map((t) => ({ labId: ctx().labId, instrumentId: inst.id, instrumentCode: t.code, analyteId: byCode.get(t.analyte)!, instrumentUnit: t.unit || null, unitFactor: 1 }));
  if (!values.length) return 0;
  const inserted = await db().insert(instrumentMappings).values(values).onConflictDoNothing().returning({ id: instrumentMappings.id });
  return inserted.length;
}

async function detail(inst: Instrument): Promise<InstrumentDetail> {
  const [item] = await listInstruments({ ids: [inst.id] });
  const events = await listEvents({ instrumentId: inst.id, limit: 20, offset: 0 });
  return {
    ...item!,
    notes: inst.notes,
    createdAt: inst.createdAt.toISOString(),
    profile: profileSummary(inst.model),
    faults: faultsFor(inst.protocol),
    recentEvents: events.items,
  };
}

function messageItem(m: typeof integrationMessages.$inferSelect): IntegrationMessageItem {
  return {
    id: m.id,
    instrumentId: m.instrumentId,
    agentId: m.agentId,
    direction: m.direction,
    protocol: m.protocol,
    messageType: m.messageType,
    controlId: m.controlId,
    status: m.status,
    error: m.error,
    sampleBarcode: m.sampleBarcode,
    resultsCount: m.resultsCount,
    isSimulated: m.isSimulated,
    receivedAt: m.receivedAt.toISOString(),
    processedAt: iso(m.processedAt),
  };
}

function mappingItem(m: typeof instrumentMappings.$inferSelect, a: { id: string; code: string; nameEn: string; nameAr: string; unit: string | null }): InstrumentMappingItem {
  return { id: m.id, instrumentId: m.instrumentId, instrumentCode: m.instrumentCode, analyte: a, unitFactor: m.unitFactor, instrumentUnit: m.instrumentUnit, isActive: m.isActive };
}

const CHANGE_FIELDS = [
  'code', 'name', 'model', 'manufacturer', 'protocol', 'transport', 'host', 'port', 'serialPort', 'baudRate',
  'agentId', 'departmentId', 'integrationLevel', 'isSimulated', 'isActive', 'notes',
] as const;

export default async function instrumentRoutes(app: FastifyInstance) {
  app.get('/', { config: { perm: 'instruments.read' } }, async (req): Promise<InstrumentListItem[]> => {
    const q = parse(instrumentListQuery, req.query);
    return listInstruments({ includeInactive: q.includeInactive });
  });

  /** Instrument profiles (models the platform has simulators and dialects for). */
  app.get('/profiles', { config: { perm: 'instruments.read' } }, async (): Promise<InstrumentProfileSummary[]> =>
    MODELS.map((m) => profileSummary(m)!),
  );

  /** Choices for the instrument, code-map and QC forms. */
  app.get('/form-data', { config: { perm: ['instruments.read', 'qc.read'] } }, async (): Promise<InstrumentFormData> => {
    const [deps, agentRows, analyteRows, instRows] = [
      await db().select({ id: departments.id, code: departments.code, nameAr: departments.nameAr, nameEn: departments.nameEn }).from(departments).orderBy(asc(departments.sortOrder)),
      await db()
        .select({ id: agents.id, name: agents.name, status: agents.status, isVirtual: agents.isVirtual })
        .from(agents)
        .where(and(eq(agents.labId, ctx().labId), ne(agents.status, 'revoked')))
        .orderBy(asc(agents.name)),
      await db()
        .select({ id: analytes.id, code: analytes.code, nameAr: analytes.nameAr, nameEn: analytes.nameEn, unit: analytes.unit })
        .from(analytes)
        .where(eq(analytes.isActive, true))
        .orderBy(asc(analytes.code)),
      await db().select({ id: instruments.id, code: instruments.code, name: instruments.name, model: instruments.model }).from(instruments).orderBy(asc(instruments.code)),
    ];
    return { departments: deps, agents: agentRows, analytes: analyteRows, instruments: instRows };
  });

  app.get('/messages/:messageId', { config: { perm: 'instruments.read' } }, async (req): Promise<IntegrationMessageDetail> => {
    const { messageId } = parse(z.object({ messageId: z.string().uuid() }), req.params);
    const [m] = await db().select().from(integrationMessages).where(eq(integrationMessages.id, messageId));
    const message = assertFound(m, 'message_not_found');
    const inst = await loadInstrument(message.instrumentId);
    const reviews = await db()
      .select({ id: reviewItems.id, reason: reviewItems.reason, status: reviewItems.status, instrumentCode: reviewItems.instrumentCode, sampleBarcode: reviewItems.sampleBarcode, valueText: reviewItems.valueText })
      .from(reviewItems)
      .where(eq(reviewItems.messageId, message.id))
      .orderBy(asc(reviewItems.createdAt));
    const attempts = await db()
      .select({ a: resultAttempts, analyteCode: analytes.code })
      .from(resultAttempts)
      .innerJoin(results, eq(results.id, resultAttempts.resultId))
      .innerJoin(analytes, eq(analytes.id, results.analyteId))
      .where(eq(resultAttempts.messageId, message.id))
      .orderBy(asc(resultAttempts.createdAt));
    return {
      ...messageItem(message),
      raw: message.raw,
      parsed: (message.parsed as IntegrationParsed | null) ?? null,
      instrument: { id: inst.id, code: inst.code, name: inst.name, model: inst.model },
      reviewItems: reviews,
      attempts: attempts.map(({ a, analyteCode }) => ({
        id: a.id,
        resultId: a.resultId,
        analyteCode,
        valueNum: a.valueNum,
        valueText: a.valueText,
        unit: a.unit,
        rawFlag: a.rawFlag,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });

  app.get('/:id', { config: { perm: 'instruments.read' } }, async (req): Promise<InstrumentDetail> => {
    const { id } = parse(idParams, req.params);
    return detail(await loadInstrument(id));
  });

  app.post('/', { config: { perm: 'instruments.manage' } }, async (req, reply): Promise<InstrumentDetail> => {
    const body = parse(instrumentCreateBody, req.body);
    const profile = body.model === 'other' ? null : PROFILES[body.model as InstrumentModel];
    const protocol = body.protocol ?? profile?.protocol;
    if (!protocol) throw badRequest('protocol_required', 'Choose the protocol for an instrument without a known model');
    await checkRefs(body);
    const [inst] = await db()
      .insert(instruments)
      .values({
        labId: ctx().labId,
        code: body.code,
        name: body.name,
        model: body.model,
        manufacturer: body.manufacturer ?? profile?.manufacturer ?? null,
        protocol,
        transport: body.transport ?? profile?.transport ?? 'tcp_server',
        host: body.host ?? null,
        port: body.port ?? profile?.defaultPort ?? null,
        serialPort: body.serialPort ?? null,
        baudRate: body.baudRate ?? profile?.serial?.baudRate ?? null,
        agentId: body.agentId ?? null,
        departmentId: body.departmentId ?? null,
        integrationLevel: body.integrationLevel ?? 'L0',
        isSimulated: body.isSimulated ?? true,
        isActive: body.isActive ?? true,
        notes: body.notes ?? profile?.note ?? null,
      })
      .returning();
    const mapped = body.createDefaultMappings ? await createDefaultMappings(inst!) : 0;
    await audit({
      action: 'instrument.create',
      entityType: 'instrument',
      entityId: inst!.id,
      summary: `${inst!.code} ${inst!.name} (${inst!.model}, ${inst!.protocol}, ${inst!.integrationLevel})${mapped ? `, ${mapped} default mapping(s)` : ''}`,
      after: inst,
    });
    publish({ type: 'instruments.changed', data: { instrumentId: inst!.id } });
    reply.status(201);
    return detail(inst!);
  });

  app.patch('/:id', { config: { perm: 'instruments.manage' } }, async (req): Promise<InstrumentDetail> => {
    const { id } = parse(idParams, req.params);
    const body = parse(instrumentUpdateBody, req.body);
    const before = await loadInstrument(id);
    await checkRefs(body);
    const model = body.model ?? before.model;
    const patch: Partial<typeof instruments.$inferInsert> = {};
    for (const key of CHANGE_FIELDS) {
      if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
    }
    if (body.model && body.model !== before.model && !body.protocol && model !== 'other') patch.protocol = PROFILES[model as InstrumentModel].protocol;
    if (!Object.keys(patch).length) return detail(before);
    const [after] = await db().update(instruments).set(patch).where(eq(instruments.id, id)).returning();
    const changed = Object.keys(patch) as Array<keyof Instrument>;
    await audit({
      action: 'instrument.update',
      entityType: 'instrument',
      entityId: id,
      summary: `${after!.code}: ${changed.join(', ')}`,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, after![k]])),
    });
    publish({ type: 'instruments.changed', data: { instrumentId: id } });
    return detail(after!);
  });

  /* ---------------------------------------------------------------- code maps */

  app.get('/:id/mappings', { config: { perm: 'instruments.read' } }, async (req): Promise<InstrumentMappingItem[]> => {
    const { id } = parse(idParams, req.params);
    await loadInstrument(id);
    const rows = await db()
      .select({ m: instrumentMappings, a: { id: analytes.id, code: analytes.code, nameEn: analytes.nameEn, nameAr: analytes.nameAr, unit: analytes.unit } })
      .from(instrumentMappings)
      .innerJoin(analytes, eq(analytes.id, instrumentMappings.analyteId))
      .where(eq(instrumentMappings.instrumentId, id))
      .orderBy(asc(instrumentMappings.instrumentCode));
    return rows.map((r) => mappingItem(r.m, r.a));
  });

  app.post('/:id/mappings', { config: { perm: 'instruments.manage' } }, async (req, reply): Promise<InstrumentMappingItem> => {
    const { id } = parse(idParams, req.params);
    const body = parse(mappingBody, req.body);
    const inst = await loadInstrument(id);
    const [analyte] = await db().select({ id: analytes.id, code: analytes.code, nameEn: analytes.nameEn, nameAr: analytes.nameAr, unit: analytes.unit }).from(analytes).where(eq(analytes.id, body.analyteId));
    if (!analyte) throw badRequest('analyte_not_found');
    const [row] = await db()
      .insert(instrumentMappings)
      .values({
        labId: ctx().labId,
        instrumentId: id,
        instrumentCode: body.instrumentCode,
        analyteId: analyte.id,
        unitFactor: body.unitFactor ?? 1,
        instrumentUnit: body.instrumentUnit ?? null,
        isActive: body.isActive ?? true,
      })
      .returning();
    await audit({ action: 'instrument.mapping_create', entityType: 'instrument_mapping', entityId: row!.id, summary: `${inst.code}: ${row!.instrumentCode} → ${analyte.code} ×${row!.unitFactor}`, after: row });
    publish({ type: 'instruments.changed', data: { instrumentId: id } });
    reply.status(201);
    return mappingItem(row!, analyte);
  });

  app.post('/:id/mappings/defaults', { config: { perm: 'instruments.manage' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const inst = await loadInstrument(id);
    if (inst.model === 'other') throw badRequest('no_default_menu', 'Instruments without a known model have no default test menu');
    const created = await createDefaultMappings(inst);
    await audit({ action: 'instrument.mapping_defaults', entityType: 'instrument', entityId: id, summary: `${inst.code}: ${created} default mapping(s) added` });
    publish({ type: 'instruments.changed', data: { instrumentId: id } });
    return { created };
  });

  app.patch('/:id/mappings/:mappingId', { config: { perm: 'instruments.manage' } }, async (req): Promise<InstrumentMappingItem> => {
    const { id, mappingId } = parse(mappingParams, req.params);
    const body = parse(mappingUpdateBody, req.body);
    const [before] = await db().select().from(instrumentMappings).where(and(eq(instrumentMappings.id, mappingId), eq(instrumentMappings.instrumentId, id)));
    assertFound(before, 'mapping_not_found');
    if (body.analyteId) {
      const [a] = await db().select({ id: analytes.id }).from(analytes).where(eq(analytes.id, body.analyteId));
      if (!a) throw badRequest('analyte_not_found');
    }
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const [after] = Object.keys(patch).length ? await db().update(instrumentMappings).set(patch).where(eq(instrumentMappings.id, mappingId)).returning() : [before!];
    const [analyte] = await db().select({ id: analytes.id, code: analytes.code, nameEn: analytes.nameEn, nameAr: analytes.nameAr, unit: analytes.unit }).from(analytes).where(eq(analytes.id, after!.analyteId));
    await audit({ action: 'instrument.mapping_update', entityType: 'instrument_mapping', entityId: mappingId, summary: `${after!.instrumentCode} → ${analyte!.code} ×${after!.unitFactor}`, before, after });
    publish({ type: 'instruments.changed', data: { instrumentId: id } });
    return mappingItem(after!, analyte!);
  });

  app.delete('/:id/mappings/:mappingId', { config: { perm: 'instruments.manage' } }, async (req) => {
    const { id, mappingId } = parse(mappingParams, req.params);
    const [row] = await db().delete(instrumentMappings).where(and(eq(instrumentMappings.id, mappingId), eq(instrumentMappings.instrumentId, id))).returning();
    assertFound(row, 'mapping_not_found');
    await audit({ action: 'instrument.mapping_delete', entityType: 'instrument_mapping', entityId: mappingId, summary: `${row!.instrumentCode} removed`, before: row });
    publish({ type: 'instruments.changed', data: { instrumentId: id } });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- messages and events */

  app.get('/:id/messages', { config: { perm: 'instruments.read' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(messagesQuery, req.query);
    await loadInstrument(id);
    const conditions: SQL[] = [eq(integrationMessages.instrumentId, id)];
    if (q.status) conditions.push(eq(integrationMessages.status, q.status));
    if (q.barcode) conditions.push(ilike(integrationMessages.sampleBarcode, `${q.barcode.replace(/[%_]/g, '')}%`));
    if (q.simulated !== undefined) conditions.push(eq(integrationMessages.isSimulated, q.simulated));
    if (q.from || q.to) {
      const { start, end } = await dayRange(q.from, q.to);
      conditions.push(gte(integrationMessages.receivedAt, start), lt(integrationMessages.receivedAt, end));
    }
    const where = and(...conditions);
    const rows = await db().select().from(integrationMessages).where(where).orderBy(desc(integrationMessages.receivedAt)).limit(q.limit).offset(q.offset);
    const [total] = await db().select({ n: count() }).from(integrationMessages).where(where);
    return page(rows.map(messageItem), total?.n ?? 0);
  });

  app.get('/:id/events', { config: { perm: 'instruments.read' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(eventsQuery, req.query);
    await loadInstrument(id);
    return listEvents({ instrumentId: id, level: q.level, agentId: q.agentId, limit: q.limit, offset: q.offset });
  });

  /* ---------------------------------------------------------------- simulation */

  app.post(
    '/:id/simulate',
    { config: { perm: ['instruments.manage', 'results.enter'], rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req): Promise<SimulateResponse> => {
      const { id } = parse(idParams, req.params);
      const body = parse(simulateBody, req.body);
      const inst = await loadInstrument(id);
      if (!inst.isActive) throw conflict('instrument_inactive');
      return simulateOnInstrument(inst, body);
    },
  );
}

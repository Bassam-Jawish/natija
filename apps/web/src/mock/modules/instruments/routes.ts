/**
 * /instruments routes (port of apps/api/src/modules/instruments/routes.ts): the analyzer list and
 * detail, model profiles, form choices, code maps, received messages, the event log and the
 * simulator.
 *
 * Mock-mode rules: the readiness level and the "simulated" flag can be edited as on the server
 * (no real analyzer ever connects in mock mode); a code or name the server would refuse for its
 * format is taken as typed.
 */
import { MODELS, PROFILES, type InstrumentModel } from '@natija/protocols';
import {
  eventsQuery,
  faultsFor,
  instrumentCreateBody,
  instrumentListQuery,
  instrumentUpdateBody,
  mappingBody,
  mappingUpdateBody,
  messagesQuery,
  simulateBody,
  type InstrumentDetail,
  type InstrumentFormData,
  type InstrumentMappingItem,
  type IntegrationMessageDetail,
  type IntegrationMessageItem,
  type IntegrationParsed,
} from '@natija/contracts';
import { badRequest, conflict, ctx, notFound, now } from '../../core/context';
import { by, find, get, insert, remove, rows, update, type Row } from '../../core/db';
import { audit, dayRange, page, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { byText, duplicate, newestFirst, typedText } from './helpers';
import { iso } from './ingest';
import { markSilentInstrumentsOffline } from './offline';
import { listEvents, listInstruments, profileSummary } from './serialize';
import { simulateOnInstrument } from './simulate';

type AnalyteRef = { id: string; code: string; nameEn: string; nameAr: string; unit: string | null };

function loadInstrument(id: string | undefined): Row<'instruments'> {
  return get('instruments', id, 'instrument_not_found');
}

function analyteRef(a: Row<'analytes'>): AnalyteRef {
  return { id: a.id, code: a.code, nameEn: a.nameEn, nameAr: a.nameAr, unit: a.unit };
}

function checkRefs(input: { agentId?: string | null; departmentId?: string | null }): void {
  if (input.agentId) {
    const agent = find('agents', input.agentId);
    if (!agent) throw badRequest('agent_not_found');
    if (agent.status === 'revoked') throw badRequest('agent_revoked');
  }
  if (input.departmentId && !find('departments', input.departmentId)) throw badRequest('department_not_found');
}

function codeTaken(code: string, exceptId?: string): boolean {
  return rows('instruments').some((i) => i.code === code && i.id !== exceptId);
}

/** Code mappings from the model's default test menu for analytes the lab has (existing codes are skipped). */
function createDefaultMappings(inst: Row<'instruments'>): number {
  if (inst.model === 'other') return 0;
  const taken = new Set(by('instrumentMappings', 'instrumentId', inst.id).map((m) => m.instrumentCode));
  let created = 0;
  for (const t of PROFILES[inst.model].tests) {
    const analyte = by('analytes', 'code', t.analyte)[0];
    if (!analyte || taken.has(t.code)) continue;
    taken.add(t.code);
    insert('instrumentMappings', { labId: ctx().labId, instrumentId: inst.id, instrumentCode: t.code, analyteId: analyte.id, instrumentUnit: t.unit || null, unitFactor: 1 });
    created++;
  }
  return created;
}

function detail(inst: Row<'instruments'>): InstrumentDetail {
  const [item] = listInstruments({ ids: [inst.id] });
  const events = listEvents({ instrumentId: inst.id, limit: 20, offset: 0 });
  return {
    ...item!,
    notes: inst.notes,
    createdAt: inst.createdAt.toISOString(),
    profile: profileSummary(inst.model),
    faults: faultsFor(inst.protocol),
    recentEvents: events.items,
  };
}

function messageItem(m: Row<'integrationMessages'>): IntegrationMessageItem {
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

function mappingItem(m: Row<'instrumentMappings'>, a: AnalyteRef): InstrumentMappingItem {
  return { id: m.id, instrumentId: m.instrumentId, instrumentCode: m.instrumentCode, analyte: a, unitFactor: m.unitFactor, instrumentUnit: m.instrumentUnit, isActive: m.isActive };
}

/** Fields an update may change (the same as the server's). */
const CHANGE_FIELDS = [
  'code', 'name', 'model', 'manufacturer', 'protocol', 'transport', 'host', 'port', 'serialPort', 'baudRate',
  'agentId', 'departmentId', 'integrationLevel', 'isSimulated', 'isActive', 'notes',
] as const;

export function registerInstrumentRoutes(): void {
  route('GET', '/instruments', { perm: 'instruments.read' }, (req) => {
    const q = parse(instrumentListQuery, req.query);
    markSilentInstrumentsOffline();
    return listInstruments({ includeInactive: q.includeInactive });
  });

  /** Instrument profiles (models the platform has simulators and dialects for). */
  route('GET', '/instruments/profiles', { perm: 'instruments.read' }, () => MODELS.map((m) => profileSummary(m)!));

  /** Choices for the instrument, code-map and QC forms. */
  route('GET', '/instruments/form-data', { perm: ['instruments.read', 'qc.read'] }, (): InstrumentFormData => ({
    departments: [...rows('departments')].sort((a, b) => a.sortOrder - b.sortOrder).map((d) => ({ id: d.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn })),
    agents: rows('agents')
      .filter((a) => a.status !== 'revoked')
      .sort((a, b) => byText(a.name, b.name))
      .map((a) => ({ id: a.id, name: a.name, status: a.status, isVirtual: a.isVirtual })),
    analytes: rows('analytes')
      .filter((a) => a.isActive)
      .sort((a, b) => byText(a.code, b.code))
      .map((a) => ({ id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, unit: a.unit })),
    instruments: [...rows('instruments')].sort((a, b) => byText(a.code, b.code)).map((i) => ({ id: i.id, code: i.code, name: i.name, model: i.model })),
  }));

  route('GET', '/instruments/messages/:messageId', { perm: 'instruments.read' }, (req): IntegrationMessageDetail => {
    const message = get('integrationMessages', req.params.messageId, 'message_not_found');
    const inst = loadInstrument(message.instrumentId);
    const reviews = by('reviewItems', 'messageId', message.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({ id: r.id, reason: r.reason, status: r.status, instrumentCode: r.instrumentCode, sampleBarcode: r.sampleBarcode, valueText: r.valueText }));
    const attempts = by('resultAttempts', 'messageId', message.id)
      .flatMap((a) => {
        const result = find('results', a.resultId);
        const analyte = result ? find('analytes', result.analyteId) : undefined;
        return analyte ? [{ a, analyteCode: analyte.code }] : [];
      })
      .sort((x, y) => x.a.createdAt.getTime() - y.a.createdAt.getTime());
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

  route('GET', '/instruments/:id', { perm: 'instruments.read' }, (req): InstrumentDetail => {
    const inst = loadInstrument(req.params.id);
    markSilentInstrumentsOffline();
    return detail(inst);
  });

  route('POST', '/instruments', { perm: 'instruments.manage' }, (req): InstrumentDetail => {
    const body = parse(instrumentCreateBody, req.body);
    const model = body.model ?? 'other';
    const profile = model === 'other' ? null : PROFILES[model as InstrumentModel];
    const protocol = body.protocol ?? profile?.protocol;
    if (!protocol) throw badRequest('protocol_required', 'Choose the protocol for an instrument without a known model');
    checkRefs(body);
    const code = body.code ?? typedText(req.body, 'code') ?? '';
    if (codeTaken(code)) throw duplicate('instruments_code_uq');
    const inst = insert('instruments', {
      labId: ctx().labId,
      code,
      name: body.name ?? typedText(req.body, 'name') ?? code,
      model,
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
      createdAt: now(),
    });
    const mapped = body.createDefaultMappings ? createDefaultMappings(inst) : 0;
    audit({
      action: 'instrument.create',
      entityType: 'instrument',
      entityId: inst.id,
      summary: `${inst.code} ${inst.name} (${inst.model}, ${inst.protocol}, ${inst.integrationLevel})${mapped ? `, ${mapped} default mapping(s)` : ''}`,
      after: { ...inst },
    });
    publish({ type: 'instruments.changed', data: { instrumentId: inst.id } });
    return detail(inst);
  });

  route('PATCH', '/instruments/:id', { perm: 'instruments.manage' }, (req): InstrumentDetail => {
    const body = parse(instrumentUpdateBody, req.body);
    const inst = loadInstrument(req.params.id);
    const before = { ...inst };
    checkRefs(body);
    const model = body.model ?? before.model;
    const patch: Partial<Row<'instruments'>> = {};
    for (const key of CHANGE_FIELDS) {
      if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
    }
    if (body.code === undefined && typedText(req.body, 'code')) patch.code = typedText(req.body, 'code');
    if (body.name === undefined && typedText(req.body, 'name')) patch.name = typedText(req.body, 'name');
    if (body.model && body.model !== before.model && !body.protocol && model !== 'other') patch.protocol = PROFILES[model as InstrumentModel].protocol;
    if (!Object.keys(patch).length) return detail(inst);
    if (patch.code !== undefined && patch.code !== before.code && codeTaken(patch.code, inst.id)) throw duplicate('instruments_code_uq');
    update('instruments', inst, patch);
    const changed = Object.keys(patch) as Array<keyof Row<'instruments'>>;
    audit({
      action: 'instrument.update',
      entityType: 'instrument',
      entityId: inst.id,
      summary: `${inst.code}: ${changed.join(', ')}`,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, inst[k]])),
    });
    publish({ type: 'instruments.changed', data: { instrumentId: inst.id } });
    return detail(inst);
  });

  /* ---------------------------------------------------------------- code maps */

  route('GET', '/instruments/:id/mappings', { perm: 'instruments.read' }, (req): InstrumentMappingItem[] => {
    const inst = loadInstrument(req.params.id);
    return by('instrumentMappings', 'instrumentId', inst.id)
      .flatMap((m) => {
        const a = find('analytes', m.analyteId);
        return a ? [mappingItem(m, analyteRef(a))] : [];
      })
      .sort((a, b) => byText(a.instrumentCode, b.instrumentCode));
  });

  route('POST', '/instruments/:id/mappings', { perm: 'instruments.manage' }, (req): InstrumentMappingItem => {
    const body = parse(mappingBody, req.body);
    const inst = loadInstrument(req.params.id);
    const analyte = find('analytes', body.analyteId);
    if (!analyte) throw badRequest('analyte_not_found');
    const instrumentCode = body.instrumentCode ?? typedText(req.body, 'instrumentCode') ?? '';
    if (by('instrumentMappings', 'instrumentId', inst.id).some((m) => m.instrumentCode === instrumentCode)) throw duplicate('instrument_mappings_uq');
    const row = insert('instrumentMappings', {
      labId: ctx().labId,
      instrumentId: inst.id,
      instrumentCode,
      analyteId: analyte.id,
      unitFactor: body.unitFactor ?? 1,
      instrumentUnit: body.instrumentUnit ?? null,
      isActive: body.isActive ?? true,
    });
    audit({ action: 'instrument.mapping_create', entityType: 'instrument_mapping', entityId: row.id, summary: `${inst.code}: ${row.instrumentCode} → ${analyte.code} ×${row.unitFactor}`, after: { ...row } });
    publish({ type: 'instruments.changed', data: { instrumentId: inst.id } });
    return mappingItem(row, analyteRef(analyte));
  });

  route('POST', '/instruments/:id/mappings/defaults', { perm: 'instruments.manage' }, (req) => {
    const inst = loadInstrument(req.params.id);
    if (inst.model === 'other') throw badRequest('no_default_menu', 'Instruments without a known model have no default test menu');
    const created = createDefaultMappings(inst);
    audit({ action: 'instrument.mapping_defaults', entityType: 'instrument', entityId: inst.id, summary: `${inst.code}: ${created} default mapping(s) added` });
    publish({ type: 'instruments.changed', data: { instrumentId: inst.id } });
    return { created };
  });

  route('PATCH', '/instruments/:id/mappings/:mappingId', { perm: 'instruments.manage' }, (req): InstrumentMappingItem => {
    const { id, mappingId } = req.params;
    const body = parse(mappingUpdateBody, req.body);
    const row = find('instrumentMappings', mappingId);
    if (!row || row.instrumentId !== id) throw notFound('mapping_not_found');
    const before = { ...row };
    if (body.analyteId && !find('analytes', body.analyteId)) throw badRequest('analyte_not_found');
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<Row<'instrumentMappings'>>;
    if (patch.instrumentCode !== undefined && patch.instrumentCode !== before.instrumentCode) {
      if (by('instrumentMappings', 'instrumentId', row.instrumentId).some((m) => m.id !== row.id && m.instrumentCode === patch.instrumentCode)) throw duplicate('instrument_mappings_uq');
    }
    if (Object.keys(patch).length) update('instrumentMappings', row, patch);
    const analyte = get('analytes', row.analyteId, 'analyte_not_found');
    audit({ action: 'instrument.mapping_update', entityType: 'instrument_mapping', entityId: row.id, summary: `${row.instrumentCode} → ${analyte.code} ×${row.unitFactor}`, before, after: { ...row } });
    publish({ type: 'instruments.changed', data: { instrumentId: id } });
    return mappingItem(row, analyteRef(analyte));
  });

  route('DELETE', '/instruments/:id/mappings/:mappingId', { perm: 'instruments.manage' }, (req) => {
    const { id, mappingId } = req.params;
    const row = find('instrumentMappings', mappingId);
    if (!row || row.instrumentId !== id) throw notFound('mapping_not_found');
    const before = { ...row };
    remove('instrumentMappings', (m) => m.id === row.id);
    audit({ action: 'instrument.mapping_delete', entityType: 'instrument_mapping', entityId: row.id, summary: `${before.instrumentCode} removed`, before });
    publish({ type: 'instruments.changed', data: { instrumentId: id } });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- messages and events */

  route('GET', '/instruments/:id/messages', { perm: 'instruments.read' }, (req) => {
    const q = parse(messagesQuery, req.query);
    const inst = loadInstrument(req.params.id);
    // ilike 'prefix%' on the barcode: case-insensitive, never matches a message without one.
    const prefix = q.barcode ? q.barcode.replace(/[%_]/g, '').toLowerCase() : null;
    const barcodeMatches = (b: string | null) => prefix === null || (b !== null && b.toLowerCase().startsWith(prefix));
    const range = q.from || q.to ? dayRange(q.from, q.to) : null;
    const matching = by('integrationMessages', 'instrumentId', inst.id).filter(
      (m) =>
        (!q.status || m.status === q.status) &&
        barcodeMatches(m.sampleBarcode) &&
        (q.simulated === undefined || m.isSimulated === q.simulated) &&
        (!range || (m.receivedAt >= range.start && m.receivedAt < range.end)),
    );
    const items = newestFirst(matching, (m) => m.receivedAt).slice(q.offset, q.offset + q.limit);
    return page(items.map(messageItem), matching.length);
  });

  route('GET', '/instruments/:id/events', { perm: 'instruments.read' }, (req) => {
    const q = parse(eventsQuery, req.query);
    const inst = loadInstrument(req.params.id);
    return listEvents({ instrumentId: inst.id, level: q.level, agentId: q.agentId, limit: q.limit, offset: q.offset });
  });

  /* ---------------------------------------------------------------- simulation */

  route('POST', '/instruments/:id/simulate', { perm: ['instruments.manage', 'results.enter'] }, (req) => {
    const body = parse(simulateBody, req.body);
    const inst = loadInstrument(req.params.id);
    if (!inst.isActive) throw conflict('instrument_inactive');
    return simulateOnInstrument(inst, body);
  });
}

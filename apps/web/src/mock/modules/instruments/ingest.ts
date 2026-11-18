/**
 * Ingest pipeline for analyzer messages (port of apps/api/src/services/ingest.ts). Every message
 * takes this path, whatever produced it (in mock mode: the simulator):
 *  1. store it (a content hash; the same content twice is a duplicate, logged only),
 *  2. parse it with the instrument model's dialect (unreadable → status error),
 *  3. per specimen: find the tube by barcode, map each instrument code to an analyte (with the
 *     code map's unit factor) and write the value through the shared results engine,
 *  4. anything that cannot be applied safely goes to the review queue, never silently away,
 *  5. QC specimens become QC runs for the matching material,
 *  6. refresh order statuses, mark the tube in analysis and the instrument online, publish.
 *
 * Mock-mode differences: the content hash is a stable string hash instead of SHA-256 (no
 * synchronous sha256 in the browser), and there is no savepoint, so a processing error marks the
 * message as error without undoing what was already written.
 */
import { parseNumericValue } from '@natija/domain';
import { normalize, ProtocolError, resolveTimestamp, type InstrumentMessage, type NormalizedResult, type NormalizedSpecimen } from '@natija/protocols';
import type { IngestItem, IngestOutcome, IngestStatus, IntegrationParsed, ReviewReason } from '@natija/contracts';
import { ctx, notFound, now } from '../../core/context';
import { by, find, insert, update, type Row } from '../../core/db';
import { audit, labTimezone, notifyPermission, publish } from '../../core/lib';
import { refreshOrderStatus } from '../shared/order-status';
import { applyResultValue } from '../shared/results-engine';
import { asJson, contentHash } from './helpers';
import { recordQcRun } from './qc-runs';

export type IngestInput = {
  instrumentId: string;
  agentId: string | null;
  raw: string;
  receivedAt?: Date;
  isSimulated: boolean;
  /** The link dropped before the message ended: store it for review, never apply it. */
  incomplete?: boolean;
  note?: string | null;
};

/* ------------------------------------------------------------------ small shared helpers */

export function iso(d: Date): string;
export function iso(d: Date | null | undefined): string | null;
export function iso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

/** Append to the integration log (shown on the instrument and agent screens). */
export function logIntegrationEvent(e: {
  instrumentId?: string | null;
  agentId?: string | null;
  level?: 'info' | 'warn' | 'error';
  event: string;
  detail?: string | null;
}): void {
  insert('integrationEvents', {
    labId: ctx().labId,
    instrumentId: e.instrumentId ?? null,
    agentId: e.agentId ?? null,
    level: e.level ?? 'info',
    event: e.event,
    detail: e.detail ?? null,
    at: now(),
  });
}

/** Apply the code map's unit factor to a value, keeping a < or > qualifier. Text passes through. */
export function convertValue(value: string, factor: number): string {
  const v = value.trim();
  if (factor === 1) return v;
  const parsed = parseNumericValue(v);
  if (parsed.value === null) return v;
  return `${parsed.qualifier ?? ''}${Number((parsed.value * factor).toPrecision(10))}`;
}

function normUnit(unit: string): string {
  return unit
    .toLowerCase()
    .replace(/[µμ]/g, 'u')
    .replace(/³/g, '*3')
    .replace(/⁶/g, '*6')
    .replace(/\^/g, '*')
    .replace(/\s+/g, '');
}

/** True when both units are known and differ (a safety stop: never convert silently). */
export function unitMismatch(expected: string | null | undefined, received: string | null | undefined): boolean {
  if (!expected?.trim() || !received?.trim()) return false;
  return normUnit(expected) !== normUnit(received);
}

/** Received/collected tubes on an analyzer are "in analysis" (with a tube history entry). */
export function markTubeInAnalysis(sample: { id: string; status: string }, instrumentCode: string): boolean {
  if (sample.status !== 'received' && sample.status !== 'collected') return false;
  const row = find('samples', sample.id);
  if (!row || (row.status !== 'received' && row.status !== 'collected')) return false;
  update('samples', row, { status: 'in_analysis' });
  insert('sampleEvents', { labId: ctx().labId, sampleId: sample.id, type: 'in_analysis', note: `Results received from analyzer ${instrumentCode}`, at: now() });
  publish({ type: 'samples.changed', data: { sampleId: sample.id, status: 'in_analysis' } });
  return true;
}

/* ------------------------------------------------------------------ the pipeline */

type MappingRow = { m: Row<'instrumentMappings'>; a: Row<'analytes'> };

type Work = {
  inst: Row<'instruments'>;
  messageId: string;
  receivedAt: Date;
  timeZone: string;
  items: IngestItem[];
  notes: string[];
  applied: number;
  review: number;
  orderIds: Set<string>;
  tubesMarked: Set<string>;
};

function item(spec: NormalizedSpecimen, r: NormalizedResult, extra: Partial<IngestItem>): IngestItem {
  return {
    sampleId: spec.sampleId,
    code: r.code,
    value: r.value,
    unit: r.unit,
    flags: r.flags,
    isQc: spec.isQc,
    outcome: 'skipped',
    reason: null,
    analyteCode: null,
    convertedValue: null,
    resultId: null,
    orderId: null,
    reviewItemId: null,
    flag: null,
    isCritical: false,
    qcRunId: null,
    qcStatus: null,
    ...extra,
  };
}

function addReview(w: Work, spec: NormalizedSpecimen, r: NormalizedResult, reason: ReviewReason, note: string | null, extra: Partial<IngestItem> = {}): void {
  const row = insert('reviewItems', {
    labId: ctx().labId,
    instrumentId: w.inst.id,
    messageId: w.messageId,
    sampleBarcode: spec.sampleId || null,
    instrumentCode: r.code,
    valueText: r.value,
    unit: r.unit,
    flags: r.flags,
    reason,
    note,
    createdAt: now(),
  });
  w.review++;
  w.items.push(item(spec, r, { outcome: 'review', reason: extra.reason ?? reason, reviewItemId: row.id, ...extra }));
}

/**
 * The result rows of the tube's order for an analyte: lines on this tube first, then lines
 * without a tube. A line planned on another tube is not used (it goes to review): a value
 * measured in one tube must not land on a test planned for a different specimen.
 */
function targetResults(sample: { id: string; orderId: string }, analyteId: string): { targets: Array<{ id: string }>; elsewhere: boolean } {
  const list: Array<{ id: string; itemSampleId: string | null }> = [];
  for (const r of by('results', 'orderId', sample.orderId)) {
    if (r.analyteId !== analyteId) continue;
    const line = find('orderItems', r.orderItemId);
    if (!line || line.status === 'cancelled') continue;
    list.push({ id: r.id, itemSampleId: line.sampleId });
  }
  const sameTube = list.filter((r) => r.itemSampleId === sample.id);
  if (sameTube.length) return { targets: sameTube, elsewhere: false };
  const noTube = list.filter((r) => r.itemSampleId === null);
  return { targets: noTube, elsewhere: !noTube.length && list.length > 0 };
}

function applyPatientSpecimen(w: Work, spec: NormalizedSpecimen, byCode: (code: string) => MappingRow | undefined): void {
  const barcode = spec.sampleId.trim();
  const tube = barcode ? by('samples', 'barcode', barcode)[0] : undefined;
  // Read once per specimen, as the server does (the live row changes when the tube goes in analysis).
  const sample = tube ? { id: tube.id, status: tube.status, orderId: tube.orderId } : undefined;
  for (const r of spec.results) {
    if (!r.value.trim()) {
      w.items.push(item(spec, r, { reason: 'no_value' }));
      continue;
    }
    if (r.status?.trim().toUpperCase() === 'X') {
      // ASTM R.9 / HL7 OBX-11 "X": the analyzer could not produce a result; the test stays pending.
      w.items.push(item(spec, r, { reason: 'not_done' }));
      continue;
    }
    if (!sample) {
      addReview(w, spec, r, 'unknown_sample', barcode ? `No tube with barcode ${barcode}` : 'The analyzer sent no sample ID');
      continue;
    }
    if (sample.status === 'rejected') {
      addReview(w, spec, r, 'sample_rejected', 'The tube was rejected; the result was not applied');
      continue;
    }
    const map = byCode(r.code);
    if (!map) {
      addReview(w, spec, r, 'unknown_code', `No active code mapping for "${r.code}" on this analyzer`);
      continue;
    }
    if (unitMismatch(map.m.instrumentUnit, r.unit)) {
      addReview(w, spec, r, 'unit_mismatch', `The code map expects ${map.m.instrumentUnit}, the analyzer sent ${r.unit}`, { analyteCode: map.a.code });
      continue;
    }
    const { targets, elsewhere } = targetResults(sample, map.a.id);
    if (!targets.length) {
      const why = elsewhere ? `${map.a.code} is ordered on another tube of this order` : `${map.a.code} is not ordered for this tube`;
      addReview(w, spec, r, 'no_order_item', why, { analyteCode: map.a.code });
      continue;
    }
    const converted = convertValue(r.value, map.m.unitFactor);
    const measuredAt = resolveTimestamp(r.measuredAt, w.timeZone) ?? w.receivedAt;
    for (const target of targets) {
      const out = applyResultValue({
        resultId: target.id,
        value: converted,
        source: 'instrument',
        instrumentId: w.inst.id,
        messageId: w.messageId,
        measuredAt,
        rawFlag: r.flags,
        dilution: r.dilution,
        skipRefresh: true,
      });
      w.orderIds.add(out.orderId);
      const extra = { analyteCode: map.a.code, convertedValue: converted, resultId: out.resultId, orderId: out.orderId, flag: out.flag, isCritical: out.isCritical };
      if (out.locked) {
        addReview(w, spec, r, 'result_locked', 'The result was already validated; the new value was kept as an attempt only', { ...extra, outcome: 'locked' });
        continue;
      }
      w.applied++;
      w.items.push(item(spec, r, { outcome: 'applied', ...extra }));
      if (!w.tubesMarked.has(sample.id)) {
        w.tubesMarked.add(sample.id);
        markTubeInAnalysis(sample, w.inst.code);
      }
    }
  }
}

function applyQcSpecimen(w: Work, spec: NormalizedSpecimen, byCode: (code: string) => MappingRow | undefined): void {
  const label = spec.sampleId.toUpperCase();
  for (const r of spec.results) {
    const map = byCode(r.code);
    if (!map) {
      w.items.push(item(spec, r, { reason: 'unknown_code' }));
      logIntegrationEvent({ instrumentId: w.inst.id, level: 'warn', event: 'qc_unknown_code', detail: `QC result for unmapped code "${r.code}" (${spec.sampleId}) ignored` });
      continue;
    }
    const converted = convertValue(r.value, map.m.unitFactor);
    const value = parseNumericValue(converted).value;
    if (value === null) {
      w.items.push(item(spec, r, { reason: 'no_value', analyteCode: map.a.code }));
      continue;
    }
    const materials = by('qcMaterials', 'analyteId', map.a.id).filter((m) => m.isActive && (m.instrumentId === w.inst.id || m.instrumentId === null));
    // Prefer this analyzer's material whose lot, level or name appears in the control ID.
    const score = (m: Row<'qcMaterials'>) =>
      (m.instrumentId === w.inst.id ? 4 : 0) +
      (label.includes(m.lot.toUpperCase()) ? 3 : 0) +
      (m.level && label.includes(m.level.toUpperCase()) ? 2 : 0) +
      (label.includes(m.name.toUpperCase()) ? 1 : 0);
    const material = materials.sort((a, b) => score(b) - score(a))[0];
    if (!material) {
      w.items.push(item(spec, r, { reason: 'qc_no_material', analyteCode: map.a.code }));
      logIntegrationEvent({ instrumentId: w.inst.id, level: 'warn', event: 'qc_no_material', detail: `QC result ${map.a.code} = ${r.value} (${spec.sampleId}): no active QC material for this analyte` });
      continue;
    }
    const run = recordQcRun({
      material,
      value,
      runAt: resolveTimestamp(r.measuredAt, w.timeZone) ?? w.receivedAt,
      source: 'instrument',
      note: `From ${w.inst.code} (${spec.sampleId})`,
    });
    w.applied++;
    w.items.push(item(spec, r, { outcome: 'qc', analyteCode: map.a.code, convertedValue: String(value), qcRunId: run.id, qcStatus: run.status }));
  }
}

function applyMessage(w: Work, message: InstrumentMessage): void {
  if (message.kind === 'query') {
    const ids = message.queries.flatMap((q) => (q.all ? ['ALL'] : q.sampleIds));
    w.notes.push(`Host query for ${ids.join(', ') || 'no sample'}; the Lab Agent answers it from its worklist cache.`);
    logIntegrationEvent({ instrumentId: w.inst.id, level: 'info', event: 'host_query', detail: `Analyzer asked for work: ${ids.join(', ')}` });
    return;
  }
  const mappings: MappingRow[] = [];
  for (const m of by('instrumentMappings', 'instrumentId', w.inst.id)) {
    if (!m.isActive) continue;
    const a = find('analytes', m.analyteId);
    if (a) mappings.push({ m, a });
  }
  const exact = new Map(mappings.map((r) => [r.m.instrumentCode, r]));
  const loose = new Map(mappings.map((r) => [r.m.instrumentCode.toLowerCase(), r]));
  const byCode = (code: string) => exact.get(code) ?? loose.get(code.toLowerCase());

  for (const spec of message.specimens) {
    if (!spec.results.length) continue;
    if (spec.isQc) applyQcSpecimen(w, spec, byCode);
    else applyPatientSpecimen(w, spec, byCode);
  }
  for (const orderId of w.orderIds) refreshOrderStatus(orderId);
  for (const warning of message.warnings) w.notes.push(warning);
}

function finalStatus(w: Work): IngestStatus {
  if (!w.items.length) return 'processed';
  if (w.applied === 0) return 'unmatched';
  return w.review > 0 ? 'partial' : 'processed';
}

function barcodeSummary(message: InstrumentMessage | null): string | null {
  if (!message) return null;
  const ids = [...new Set([...message.specimens.map((s) => s.sampleId), ...message.queries.flatMap((q) => q.sampleIds)].filter(Boolean))];
  if (!ids.length) return null;
  return ids.length === 1 ? ids[0]! : `${ids[0]} +${ids.length - 1}`;
}

function touchInstrument(inst: Row<'instruments'>, at: Date, message = true): void {
  // The row is live: read the status before changing it.
  const wasOnline = inst.status === 'online';
  update('instruments', inst, message ? { lastMessageAt: at, lastSeenAt: now(), status: 'online' } : { lastSeenAt: now() });
  if (message && !wasOnline) {
    logIntegrationEvent({ instrumentId: inst.id, level: 'info', event: 'online', detail: 'Messages are arriving from this analyzer' });
    publish({ type: 'instruments.changed', data: { instrumentId: inst.id, status: 'online' } });
  }
}

function outcome(messageId: string | null, status: IngestStatus, extra: Partial<IngestOutcome> = {}): IngestOutcome {
  return { messageId, status, duplicateOf: null, kind: null, messageType: null, resultsCount: 0, reviewCount: 0, error: null, items: [], ...extra };
}

/** Store, parse and apply one raw message for the signed-in lab. */
export function ingestMessage(input: IngestInput): IngestOutcome {
  const { labId } = ctx();
  const inst = find('instruments', input.instrumentId);
  if (!inst) throw notFound('instrument_not_found');
  const receivedAt = input.receivedAt ?? now();
  const rawHash = contentHash(input.raw);

  // The server's unique (lab, instrument, hash) index: the same content again is a duplicate.
  const first = by('integrationMessages', 'rawHash', rawHash).find((m) => m.instrumentId === inst.id && m.raw === input.raw);
  if (first) {
    const detail = `Same content as message ${first.id} received ${iso(first.receivedAt)}; not applied again`;
    logIntegrationEvent({ instrumentId: inst.id, agentId: input.agentId, level: 'warn', event: 'duplicate', detail });
    audit({ action: 'integration.duplicate', entityType: 'integration_message', entityId: first.id, summary: `${inst.code}: duplicate message ignored` });
    touchInstrument(inst, receivedAt, false);
    publish({ type: 'integration.message', data: { instrumentId: inst.id, messageId: first.id, status: 'duplicate', isSimulated: input.isSimulated } });
    return outcome(first.id, 'duplicate', { duplicateOf: first.id, error: detail });
  }

  const row = insert('integrationMessages', {
    labId,
    instrumentId: inst.id,
    agentId: input.agentId,
    direction: 'in',
    protocol: inst.protocol,
    raw: input.raw,
    rawHash,
    status: 'received',
    isSimulated: input.isSimulated,
    receivedAt,
  });
  const messageId = row.id;

  const fail = (event: string, error: string, normalized: InstrumentMessage | null): IngestOutcome => {
    const parsed: IntegrationParsed = { normalized, items: [], notes: [] };
    update('integrationMessages', row, {
      status: 'error',
      error,
      parsed: asJson(parsed),
      messageType: normalized?.messageType ?? null,
      controlId: normalized?.controlId ?? null,
      sampleBarcode: barcodeSummary(normalized),
      processedAt: now(),
    });
    logIntegrationEvent({ instrumentId: inst.id, agentId: input.agentId, level: 'error', event, detail: error });
    audit({ action: 'integration.message', entityType: 'integration_message', entityId: messageId, summary: `${inst.code}: ${error}`, after: { status: 'error' } });
    touchInstrument(inst, receivedAt);
    publish({ type: 'integration.message', data: { instrumentId: inst.id, messageId, status: 'error', isSimulated: input.isSimulated } });
    return outcome(messageId, 'error', { error, kind: normalized?.kind ?? null, messageType: normalized?.messageType ?? null });
  };

  if (input.incomplete) {
    return fail('incomplete_message', `Incomplete message (${input.note ?? 'the link dropped before it ended'}); stored for review, not applied`, null);
  }

  let message: InstrumentMessage;
  try {
    message = normalize(inst.model, input.raw, inst.protocol);
  } catch (err) {
    const error = err instanceof ProtocolError ? err.message : `parser failed: ${err instanceof Error ? err.message : String(err)}`;
    return fail('parse_error', `Unreadable message: ${error}`, null);
  }

  const w: Work = {
    inst,
    messageId,
    receivedAt,
    timeZone: labTimezone(labId),
    items: [],
    notes: [],
    applied: 0,
    review: 0,
    orderIds: new Set(),
    tubesMarked: new Set(),
  };
  try {
    applyMessage(w, message);
  } catch (err) {
    return fail('processing_error', `Processing failed: ${err instanceof Error ? err.message : String(err)}`, message);
  }

  const status = finalStatus(w);
  const parsed: IntegrationParsed = { normalized: message, items: w.items, notes: w.notes };
  update('integrationMessages', row, {
    status,
    error: null,
    parsed: asJson(parsed),
    messageType: message.messageType,
    controlId: message.controlId,
    sampleBarcode: barcodeSummary(message),
    resultsCount: w.applied,
    processedAt: now(),
  });
  touchInstrument(inst, receivedAt);
  const summary = `${inst.code} ${message.messageType}: ${w.applied} applied, ${w.review} to review${input.isSimulated ? ' (simulated)' : ''}`;
  logIntegrationEvent({ instrumentId: inst.id, agentId: input.agentId, level: w.review ? 'warn' : 'info', event: 'message', detail: summary });
  audit({
    action: 'integration.message',
    entityType: 'integration_message',
    entityId: messageId,
    summary,
    after: { status, applied: w.applied, review: w.review, simulated: input.isSimulated, kind: message.kind },
  });
  if (w.review > 0 && !input.isSimulated) {
    notifyPermission('integration.review', {
      kind: 'instrument',
      severity: 'warning',
      titleAr: `نتائج من ${inst.name} تحتاج مراجعة`,
      titleEn: `Results from ${inst.name} need review`,
      bodyAr: `${w.review} قيمة لم تُطابق تلقائياً`,
      bodyEn: `${w.review} value(s) could not be matched automatically`,
      link: '/integration/review',
      entityType: 'integration_message',
      entityId: messageId,
    });
  }
  publish({
    type: 'integration.message',
    data: { instrumentId: inst.id, messageId, status, resultsCount: w.applied, reviewCount: w.review, isSimulated: input.isSimulated },
  });
  return outcome(messageId, status, {
    kind: message.kind,
    messageType: message.messageType,
    resultsCount: w.applied,
    reviewCount: w.review,
    items: w.items,
  });
}

/**
 * Ingest pipeline: one raw analyzer message → stored, parsed, matched and applied.
 *
 * Every message takes this path, whether a Lab Agent uploaded it or the in-platform
 * simulator produced it:
 *  1. store it (sha256 of the raw text; the same content twice is a duplicate, logged only),
 *  2. parse it with the instrument model's dialect (unreadable → status error),
 *  3. per specimen: find the tube by barcode, map each instrument code to an analyte,
 *     find the pending result in the tube's order and write the value through
 *     applyResultValue() (flags, ranges, delta, criticals, audit),
 *  4. anything that cannot be applied safely goes to the review queue, never silently away,
 *  5. QC specimens become QC runs for the matching material,
 *  6. refresh order statuses, mark the instrument online, publish a live event.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  analytes,
  instrumentMappings,
  instruments,
  integrationEvents,
  integrationMessages,
  orderItems,
  qcMaterials,
  results,
  reviewItems,
  sampleEvents,
  samples,
  type Instrument,
} from '@natija/db';
import { parseNumericValue } from '@natija/domain';
import { normalize, ProtocolError, resolveTimestamp, type InstrumentMessage, type NormalizedResult, type NormalizedSpecimen } from '@natija/protocols';
import type { IngestItem, IngestOutcome, IngestStatus, IntegrationParsed, ReviewReason } from '@natija/contracts';
import { ctx, db } from '../db';
import { audit } from '../lib/audit';
import { sha256 } from '../lib/crypto';
import { notFound } from '../lib/errors';
import { publish } from '../lib/events';
import { labTimezone } from '../lib/lab';
import { notifyPermission } from '../lib/notify';
import { recordQcRun } from '../modules/qc/runs';
import { refreshOrderStatus } from './order-status';
import { applyResultValue } from './results-engine';

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
  return d ? d.toISOString() : null;
}

/** Append to the integration log (shown on the instrument and agent screens). */
export async function logIntegrationEvent(e: {
  instrumentId?: string | null;
  agentId?: string | null;
  level?: 'info' | 'warn' | 'error';
  event: string;
  detail?: string | null;
}): Promise<void> {
  await db()
    .insert(integrationEvents)
    .values({ labId: ctx().labId, instrumentId: e.instrumentId ?? null, agentId: e.agentId ?? null, level: e.level ?? 'info', event: e.event, detail: e.detail ?? null });
}

/** Run `fn` inside a savepoint: if it throws, only its own changes are undone. */
export async function withSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const name = `sp_${randomUUID().replace(/-/g, '')}`;
  await db().execute(sql.raw(`savepoint ${name}`));
  try {
    const out = await fn();
    await db().execute(sql.raw(`release savepoint ${name}`));
    return out;
  } catch (err) {
    await db().execute(sql.raw(`rollback to savepoint ${name}`));
    throw err;
  }
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
export async function markTubeInAnalysis(sample: { id: string; status: string }, instrumentCode: string): Promise<boolean> {
  if (sample.status !== 'received' && sample.status !== 'collected') return false;
  const updated = await db()
    .update(samples)
    .set({ status: 'in_analysis' })
    .where(and(eq(samples.id, sample.id), inArray(samples.status, ['received', 'collected'])))
    .returning({ id: samples.id });
  if (!updated.length) return false;
  await db().insert(sampleEvents).values({ labId: ctx().labId, sampleId: sample.id, type: 'in_analysis', note: `Results received from analyzer ${instrumentCode}` });
  publish({ type: 'samples.changed', data: { sampleId: sample.id, status: 'in_analysis' } });
  return true;
}

/* ------------------------------------------------------------------ the pipeline */

type MappingRow = { m: typeof instrumentMappings.$inferSelect; a: typeof analytes.$inferSelect };

type Work = {
  inst: Instrument;
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

async function addReview(w: Work, spec: NormalizedSpecimen, r: NormalizedResult, reason: ReviewReason, note: string | null, extra: Partial<IngestItem> = {}): Promise<void> {
  const [row] = await db()
    .insert(reviewItems)
    .values({
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
    })
    .returning({ id: reviewItems.id });
  w.review++;
  w.items.push(item(spec, r, { outcome: 'review', reason: extra.reason ?? reason, reviewItemId: row!.id, ...extra }));
}

/**
 * The result rows of the tube's order for an analyte: lines on this tube first, then lines
 * without a tube. A line planned on another tube is not used (it goes to review): a value
 * measured in one tube must not land on a test planned for a different specimen.
 */
async function targetResults(sample: { id: string; orderId: string }, analyteId: string): Promise<{ targets: Array<{ id: string }>; elsewhere: boolean }> {
  const rows = await db()
    .select({ id: results.id, itemSampleId: orderItems.sampleId })
    .from(results)
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .where(and(eq(results.orderId, sample.orderId), eq(results.analyteId, analyteId), sql`${orderItems.status} <> 'cancelled'`));
  const sameTube = rows.filter((r) => r.itemSampleId === sample.id);
  if (sameTube.length) return { targets: sameTube, elsewhere: false };
  const noTube = rows.filter((r) => r.itemSampleId === null);
  return { targets: noTube, elsewhere: !noTube.length && rows.length > 0 };
}

async function applyPatientSpecimen(w: Work, spec: NormalizedSpecimen, byCode: (code: string) => MappingRow | undefined): Promise<void> {
  const barcode = spec.sampleId.trim();
  const [sample] = barcode
    ? await db().select({ id: samples.id, status: samples.status, orderId: samples.orderId }).from(samples).where(eq(samples.barcode, barcode))
    : [];
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
      await addReview(w, spec, r, 'unknown_sample', barcode ? `No tube with barcode ${barcode}` : 'The analyzer sent no sample ID');
      continue;
    }
    if (sample.status === 'rejected') {
      await addReview(w, spec, r, 'sample_rejected', 'The tube was rejected; the result was not applied');
      continue;
    }
    const map = byCode(r.code);
    if (!map) {
      await addReview(w, spec, r, 'unknown_code', `No active code mapping for "${r.code}" on this analyzer`);
      continue;
    }
    if (unitMismatch(map.m.instrumentUnit, r.unit)) {
      await addReview(w, spec, r, 'unit_mismatch', `The code map expects ${map.m.instrumentUnit}, the analyzer sent ${r.unit}`, { analyteCode: map.a.code });
      continue;
    }
    const { targets, elsewhere } = await targetResults(sample, map.a.id);
    if (!targets.length) {
      const why = elsewhere ? `${map.a.code} is ordered on another tube of this order` : `${map.a.code} is not ordered for this tube`;
      await addReview(w, spec, r, 'no_order_item', why, { analyteCode: map.a.code });
      continue;
    }
    const converted = convertValue(r.value, map.m.unitFactor);
    const measuredAt = resolveTimestamp(r.measuredAt, w.timeZone) ?? w.receivedAt;
    for (const target of targets) {
      const out = await applyResultValue({
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
        await addReview(w, spec, r, 'result_locked', 'The result was already validated; the new value was kept as an attempt only', { ...extra, outcome: 'locked' });
        continue;
      }
      w.applied++;
      w.items.push(item(spec, r, { outcome: 'applied', ...extra }));
      if (!w.tubesMarked.has(sample.id)) {
        w.tubesMarked.add(sample.id);
        await markTubeInAnalysis(sample, w.inst.code);
      }
    }
  }
}

async function applyQcSpecimen(w: Work, spec: NormalizedSpecimen, byCode: (code: string) => MappingRow | undefined): Promise<void> {
  const label = spec.sampleId.toUpperCase();
  for (const r of spec.results) {
    const map = byCode(r.code);
    if (!map) {
      w.items.push(item(spec, r, { reason: 'unknown_code' }));
      await logIntegrationEvent({ instrumentId: w.inst.id, level: 'warn', event: 'qc_unknown_code', detail: `QC result for unmapped code "${r.code}" (${spec.sampleId}) ignored` });
      continue;
    }
    const converted = convertValue(r.value, map.m.unitFactor);
    const value = parseNumericValue(converted).value;
    if (value === null) {
      w.items.push(item(spec, r, { reason: 'no_value', analyteCode: map.a.code }));
      continue;
    }
    const materials = await db()
      .select()
      .from(qcMaterials)
      .where(
        and(
          eq(qcMaterials.analyteId, map.a.id),
          eq(qcMaterials.isActive, true),
          or(eq(qcMaterials.instrumentId, w.inst.id), isNull(qcMaterials.instrumentId)),
        ),
      );
    // Prefer this analyzer's material whose lot, level or name appears in the control ID.
    const score = (m: typeof qcMaterials.$inferSelect) =>
      (m.instrumentId === w.inst.id ? 4 : 0) +
      (label.includes(m.lot.toUpperCase()) ? 3 : 0) +
      (m.level && label.includes(m.level.toUpperCase()) ? 2 : 0) +
      (label.includes(m.name.toUpperCase()) ? 1 : 0);
    const material = materials.sort((a, b) => score(b) - score(a))[0];
    if (!material) {
      w.items.push(item(spec, r, { reason: 'qc_no_material', analyteCode: map.a.code }));
      await logIntegrationEvent({ instrumentId: w.inst.id, level: 'warn', event: 'qc_no_material', detail: `QC result ${map.a.code} = ${r.value} (${spec.sampleId}): no active QC material for this analyte` });
      continue;
    }
    const run = await recordQcRun({
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

async function applyMessage(w: Work, message: InstrumentMessage): Promise<void> {
  if (message.kind === 'query') {
    const ids = message.queries.flatMap((q) => (q.all ? ['ALL'] : q.sampleIds));
    w.notes.push(`Host query for ${ids.join(', ') || 'no sample'}; the Lab Agent answers it from its worklist cache.`);
    await logIntegrationEvent({ instrumentId: w.inst.id, level: 'info', event: 'host_query', detail: `Analyzer asked for work: ${ids.join(', ')}` });
    return;
  }
  const mappings: MappingRow[] = await db()
    .select({ m: instrumentMappings, a: analytes })
    .from(instrumentMappings)
    .innerJoin(analytes, eq(analytes.id, instrumentMappings.analyteId))
    .where(and(eq(instrumentMappings.instrumentId, w.inst.id), eq(instrumentMappings.isActive, true)));
  const exact = new Map(mappings.map((r) => [r.m.instrumentCode, r]));
  const loose = new Map(mappings.map((r) => [r.m.instrumentCode.toLowerCase(), r]));
  const byCode = (code: string) => exact.get(code) ?? loose.get(code.toLowerCase());

  for (const spec of message.specimens) {
    if (!spec.results.length) continue;
    if (spec.isQc) await applyQcSpecimen(w, spec, byCode);
    else await applyPatientSpecimen(w, spec, byCode);
  }
  for (const orderId of w.orderIds) await refreshOrderStatus(orderId);
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

async function touchInstrument(inst: Instrument, at: Date, message = true): Promise<void> {
  await db()
    .update(instruments)
    .set(message ? { lastMessageAt: at, lastSeenAt: new Date(), status: 'online' } : { lastSeenAt: new Date() })
    .where(eq(instruments.id, inst.id));
  if (message && inst.status !== 'online') {
    await logIntegrationEvent({ instrumentId: inst.id, level: 'info', event: 'online', detail: 'Messages are arriving from this analyzer' });
    publish({ type: 'instruments.changed', data: { instrumentId: inst.id, status: 'online' } });
  }
}

function outcome(messageId: string | null, status: IngestStatus, extra: Partial<IngestOutcome> = {}): IngestOutcome {
  return { messageId, status, duplicateOf: null, kind: null, messageType: null, resultsCount: 0, reviewCount: 0, error: null, items: [], ...extra };
}

/** Store, parse and apply one raw message. Runs inside the caller's lab transaction. */
export async function ingestMessage(input: IngestInput): Promise<IngestOutcome> {
  const { labId } = ctx();
  const tx = db();
  const [inst] = await tx.select().from(instruments).where(eq(instruments.id, input.instrumentId));
  if (!inst) throw notFound('instrument_not_found');
  const receivedAt = input.receivedAt ?? new Date();
  const rawHash = sha256(input.raw);

  const [row] = await tx
    .insert(integrationMessages)
    .values({
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
    })
    .onConflictDoNothing({ target: [integrationMessages.labId, integrationMessages.instrumentId, integrationMessages.rawHash] })
    .returning({ id: integrationMessages.id });

  if (!row) {
    const [first] = await tx
      .select({ id: integrationMessages.id, receivedAt: integrationMessages.receivedAt })
      .from(integrationMessages)
      .where(and(eq(integrationMessages.instrumentId, inst.id), eq(integrationMessages.rawHash, rawHash)));
    const detail = `Same content as message ${first?.id ?? '?'} received ${iso(first?.receivedAt) ?? '?'}; not applied again`;
    await logIntegrationEvent({ instrumentId: inst.id, agentId: input.agentId, level: 'warn', event: 'duplicate', detail });
    await audit({ action: 'integration.duplicate', entityType: 'integration_message', entityId: first?.id ?? null, summary: `${inst.code}: duplicate message ignored` });
    await touchInstrument(inst, receivedAt, false);
    publish({ type: 'integration.message', data: { instrumentId: inst.id, messageId: first?.id ?? null, status: 'duplicate', isSimulated: input.isSimulated } });
    return outcome(first?.id ?? null, 'duplicate', { duplicateOf: first?.id ?? null, error: detail });
  }

  const messageId = row.id;
  const fail = async (event: string, error: string, normalized: InstrumentMessage | null): Promise<IngestOutcome> => {
    const parsed: IntegrationParsed = { normalized, items: [], notes: [] };
    await tx
      .update(integrationMessages)
      .set({ status: 'error', error, parsed, messageType: normalized?.messageType ?? null, controlId: normalized?.controlId ?? null, sampleBarcode: barcodeSummary(normalized), processedAt: new Date() })
      .where(eq(integrationMessages.id, messageId));
    await logIntegrationEvent({ instrumentId: inst.id, agentId: input.agentId, level: 'error', event, detail: error });
    await audit({ action: 'integration.message', entityType: 'integration_message', entityId: messageId, summary: `${inst.code}: ${error}`, after: { status: 'error' } });
    await touchInstrument(inst, receivedAt);
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
    timeZone: await labTimezone(labId),
    items: [],
    notes: [],
    applied: 0,
    review: 0,
    orderIds: new Set(),
    tubesMarked: new Set(),
  };
  try {
    await withSavepoint(() => applyMessage(w, message));
  } catch (err) {
    return fail('processing_error', `Processing failed: ${err instanceof Error ? err.message : String(err)}`, message);
  }

  const status = finalStatus(w);
  const parsed: IntegrationParsed = { normalized: message, items: w.items, notes: w.notes };
  await tx
    .update(integrationMessages)
    .set({
      status,
      error: null,
      parsed,
      messageType: message.messageType,
      controlId: message.controlId,
      sampleBarcode: barcodeSummary(message),
      resultsCount: w.applied,
      processedAt: new Date(),
    })
    .where(eq(integrationMessages.id, messageId));
  await touchInstrument(inst, receivedAt);
  const summary = `${inst.code} ${message.messageType}: ${w.applied} applied, ${w.review} to review${input.isSimulated ? ' (simulated)' : ''}`;
  await logIntegrationEvent({ instrumentId: inst.id, agentId: input.agentId, level: w.review ? 'warn' : 'info', event: 'message', detail: summary });
  await audit({
    action: 'integration.message',
    entityType: 'integration_message',
    entityId: messageId,
    summary,
    after: { status, applied: w.applied, review: w.review, simulated: input.isSimulated, kind: message.kind },
  });
  if (w.review > 0 && !input.isSimulated) {
    await notifyPermission('integration.review', {
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

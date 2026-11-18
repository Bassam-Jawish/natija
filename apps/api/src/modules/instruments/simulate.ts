/**
 * "Simulate" for an instrument: build realistic raw messages for its model, push them
 * through the real link layer (ENQ/ACK frames with checksums, MLLP + HL7 acknowledgements,
 * raw text) between a simulated analyzer and the host, then ingest what the host received
 * exactly as agent traffic is ingested. Everything is marked simulated (readiness L0).
 */
import { randomInt } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { agents, instrumentMappings, orders, patients, qcMaterials, samples, analytes, type Instrument } from '@natija/db';
import {
  corruptChecksum,
  normalize,
  PROFILES,
  runExchange,
  seededRandom,
  simulateResults,
  unmappedCodeFor,
  type InstrumentMessage,
  type SessionOptions,
  type SimSpecimen,
} from '@natija/protocols';
import { faultsFor, type IngestOutcome, type SimulateBody, type SimulateResponse, type WireFrame } from '@natija/contracts';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { badRequest, conflict } from '../../lib/errors';
import { publish } from '../../lib/events';
import { labTimezone } from '../../lib/lab';
import { ingestMessage, logIntegrationEvent } from '../../services/ingest';
import { pendingWork, testCodes } from '../agent-api/worklist';

export const VIRTUAL_AGENT_NAME = 'Virtual Lab Agent (demo)';

/** The lab's built-in agent that carries simulated traffic (created on first use). */
export async function ensureVirtualAgent(): Promise<{ id: string; name: string }> {
  const { labId } = ctx();
  const find = () =>
    db()
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.labId, labId), eq(agents.isVirtual, true)))
      .limit(1);
  const [existing] = await find();
  if (existing) return existing;
  await db().execute(sql`select pg_advisory_xact_lock(hashtext(${`virtual-agent:${labId}`}))`);
  const [again] = await find();
  if (again) return again;
  const [row] = await db()
    .insert(agents)
    .values({
      labId,
      name: VIRTUAL_AGENT_NAME,
      status: 'active',
      isVirtual: true,
      version: 'built-in',
      hostInfo: { note: 'Runs inside the platform; carries simulated analyzer traffic only.' },
    })
    .returning({ id: agents.id, name: agents.name });
  await audit({ action: 'agent.create', entityType: 'agent', entityId: row!.id, summary: `${VIRTUAL_AGENT_NAME} created for simulated traffic` });
  return row!;
}

/** A barcode that cannot exist (fault injection: unknown_sample). At most 22 characters for the e 411. */
function unknownBarcode(rnd: () => number): string {
  return `999999-${String(Math.floor(rnd() * 9000) + 1000)}-99`;
}

/** Break the HL7 encoding characters so the receiver cannot parse the message (HL7 has no checksum). */
function corruptHl7(message: string): string {
  return message.replace(/^MSH\|\^~\\&/, 'MSH|^^\\&');
}

function tryNormalize(inst: Instrument, raw: string): InstrumentMessage | null {
  try {
    return normalize(inst.model, raw, inst.protocol);
  } catch {
    return null;
  }
}

async function buildSpecimens(inst: Instrument, body: SimulateBody, rnd: () => number, mappedCodes: string[]): Promise<SimSpecimen[]> {
  if (body.qc) {
    const rows = await db()
      .select({ m: qcMaterials, code: instrumentMappings.instrumentCode, unitFactor: instrumentMappings.unitFactor })
      .from(qcMaterials)
      .innerJoin(
        instrumentMappings,
        and(eq(instrumentMappings.analyteId, qcMaterials.analyteId), eq(instrumentMappings.instrumentId, inst.id), eq(instrumentMappings.isActive, true)),
      )
      .where(and(eq(qcMaterials.isActive, true), or(eq(qcMaterials.instrumentId, inst.id), isNull(qcMaterials.instrumentId))));
    if (!rows.length) throw conflict('no_qc_materials', 'No active QC material is set up for the analytes this analyzer reports');
    const byLevel = new Map<string, SimSpecimen>();
    for (const r of rows) {
      const spec = byLevel.get(r.m.level) ?? { sampleId: `QC-${r.m.level}`, isQc: true, tests: [], qcTargets: {} };
      if (!spec.tests!.includes(r.code)) {
        spec.tests!.push(r.code);
        // Targets are in the lab's unit; the analyzer reports in its own unit.
        spec.qcTargets![r.code] = { mean: r.m.targetMean / r.unitFactor, sd: r.m.targetSd / r.unitFactor };
      }
      byLevel.set(r.m.level, spec);
    }
    return [...byLevel.values()].slice(0, 5);
  }

  if (body.fault === 'unknown_sample') {
    return [{ sampleId: unknownBarcode(rnd), tests: mappedCodes.slice(0, 4) }];
  }

  if (body.barcodes?.length) {
    const work = await pendingWork(inst.id, { barcodes: body.barcodes, limit: 5 });
    const people = await db()
      .select({ barcode: samples.barcode, sex: patients.sex, birthDate: patients.birthDate })
      .from(samples)
      .innerJoin(orders, eq(orders.id, samples.orderId))
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .where(inArray(samples.barcode, body.barcodes));
    return body.barcodes.map((barcode) => {
      const tube = work.find((t) => t.barcode === barcode);
      const person = people.find((p) => p.barcode === barcode);
      return {
        sampleId: barcode,
        tests: tube ? testCodes(tube) : mappedCodes.slice(0, 3),
        sex: person?.sex ?? null,
        birthDate: person?.birthDate ?? null,
      };
    });
  }

  const work = await pendingWork(inst.id, { limit: 5 });
  if (!work.length) {
    throw conflict('no_pending_samples', 'No tubes are waiting for this analyzer. Register an order with tests mapped to it and collect the tube first, or pass barcodes.');
  }
  return work.map((t) => ({ sampleId: t.barcode, tests: testCodes(t), sex: t.sex, birthDate: t.birthDate }));
}

export async function simulateOnInstrument(inst: Instrument, body: SimulateBody): Promise<SimulateResponse> {
  if (inst.model === 'other') throw badRequest('simulation_unsupported', 'There is no simulator for instruments without a known model');
  const profile = PROFILES[inst.model];
  if (inst.protocol !== profile.protocol) {
    throw badRequest('protocol_mismatch', `The ${profile.name} simulator speaks ${profile.protocol}; this instrument is set to ${inst.protocol}`);
  }
  if (!faultsFor(inst.protocol).includes(body.fault)) {
    throw badRequest('fault_not_applicable', `${body.fault} does not apply to ${inst.protocol}: it has no checksum or acknowledgement`);
  }
  const seed = body.seed ?? randomInt(0, 2_147_483_647);
  const rnd = seededRandom(seed);
  const timeZone = await labTimezone(ctx().labId);

  const mappingRows = await db()
    .select({ code: instrumentMappings.instrumentCode, analyteCode: analytes.code })
    .from(instrumentMappings)
    .innerJoin(analytes, eq(analytes.id, instrumentMappings.analyteId))
    .where(and(eq(instrumentMappings.instrumentId, inst.id), eq(instrumentMappings.isActive, true)));
  const mappedCodes = mappingRows.map((m) => m.code);
  if (!mappedCodes.length && body.fault !== 'unknown_code') throw conflict('no_mappings', 'This analyzer has no code mappings yet');

  const specimens = await buildSpecimens(inst, body, rnd, mappedCodes);
  if (profile.specimenIdMax) {
    const tooLong = specimens.find((s) => s.sampleId.length > profile.specimenIdMax!);
    if (tooLong) throw badRequest('specimen_id_too_long', `${profile.name} accepts specimen IDs up to ${profile.specimenIdMax} characters`);
  }

  let extraCodes: string[] = [];
  if (body.fault === 'unknown_code') {
    let code = unmappedCodeFor(inst.model, rnd);
    for (let i = 0; mappedCodes.includes(code) && i < 10; i++) code = `${unmappedCodeFor(inst.model, rnd)}${i}`;
    extraCodes = [code];
  }

  const agent = await ensureVirtualAgent();
  const sims = simulateResults({ model: inst.model, specimens, mode: body.mode, seed, now: new Date(), timeZone, extraCodes });
  const transmissions = sims.map((s) => s.raw);
  if (body.fault === 'duplicate' && transmissions.length) transmissions.splice(1, 0, transmissions[0]!);

  const frames: WireFrame[] = [];
  const parsed: SimulateResponse['parsed'] = [];
  const messages: Array<IngestOutcome | null> = [];
  const notes: string[] = [];
  let delivered = 0;
  let refused = 0;

  for (const [index, raw] of transmissions.entries()) {
    const corrupt = body.fault === 'bad_checksum' && index === 0;
    let instrumentSide: Pick<SessionOptions, 'astm' | 'hl7'> | undefined;
    if (corrupt && inst.protocol === 'astm') {
      // Every attempt of frame 2 fails its checksum: NAK, retransmit ... until the analyzer gives up.
      instrumentSide = { astm: { mutateFrame: (f, info) => (info.index === 1 ? corruptChecksum(f) : f) } };
    } else if (corrupt) {
      instrumentSide = { hl7: { mutateOutgoing: corruptHl7 } };
    }
    const ex = await runExchange({ protocol: inst.protocol, messages: [raw], instrument: instrumentSide, timeZone });
    for (const t of ex.trace) if (t.dir !== 'rx') frames.push({ exchange: index, t: t.t, side: t.side, dir: t.dir, kind: t.kind, text: t.text, ...(t.ok === undefined ? {} : { ok: t.ok }) });
    parsed.push(tryNormalize(inst, raw));

    if (!ex.received.length) {
      refused++;
      messages.push(null);
      const nakCount = ex.trace.filter((t) => t.side === 'host' && t.text === '<NAK>').length;
      const detail =
        inst.protocol === 'astm'
          ? `Frame 2 failed its checksum ${nakCount} time(s); the host answered NAK each time and the analyzer gave up (EOT). Nothing was applied.`
          : `The host could not read the message and refused it (${ex.sendResults[0]?.error ?? 'no acknowledgement'}). Nothing was applied.`;
      await logIntegrationEvent({ instrumentId: inst.id, agentId: agent.id, level: 'error', event: inst.protocol === 'astm' ? 'checksum_error' : 'message_refused', detail: `${detail} (simulated)` });
      notes.push(detail);
    }
    for (const partial of ex.incomplete) {
      await ingestMessage({ instrumentId: inst.id, agentId: agent.id, raw: partial.text, isSimulated: true, incomplete: true, note: partial.reason });
      notes.push(`The partial message (${partial.reason}) was stored with status error for review.`);
    }
    for (const text of ex.received) {
      delivered++;
      const out = await ingestMessage({ instrumentId: inst.id, agentId: agent.id, raw: text, isSimulated: true });
      messages.push(out);
      if (corrupt && out.status === 'error') {
        notes.push(`The host answered AR (application reject) and stored the unreadable message with status error: ${out.error}`);
      }
    }
  }

  const done = messages.filter((m): m is IngestOutcome => !!m);
  const summary = {
    sent: transmissions.length,
    delivered,
    applied: done.reduce((n, m) => n + m.resultsCount, 0),
    review: done.reduce((n, m) => n + m.reviewCount, 0),
    duplicates: done.filter((m) => m.status === 'duplicate').length,
    refused,
  };
  if (summary.duplicates) notes.push('The repeated message had the same content (same SHA-256): it was recognised as a duplicate and not applied twice.');
  if (inst.model === 'ichroma3') notes.push('ichroma III traffic uses an INVENTED demo format: Boditech publishes no host-interface specification.');
  if (inst.model === 'medica_easystat') notes.push('The Medica printout layout is an assumption until checked against a real EasyStat printout.');
  notes.push('Simulated traffic (readiness L0): no real analyzer took part.');

  await audit({
    action: 'instrument.simulate',
    entityType: 'instrument',
    entityId: inst.id,
    summary: `${inst.code}: simulated ${body.mode} run${body.fault !== 'none' ? ` with fault ${body.fault}` : ''}${body.qc ? ' (QC)' : ''}, ${specimens.length} specimen(s), ${summary.applied} value(s) applied, ${summary.review} to review`,
    after: { seed, mode: body.mode, fault: body.fault, qc: !!body.qc, specimens: specimens.map((s) => s.sampleId), summary },
  });
  publish({ type: 'instruments.changed', data: { instrumentId: inst.id } });

  return {
    instrument: { id: inst.id, code: inst.code, name: inst.name, model: inst.model, protocol: inst.protocol, integrationLevel: inst.integrationLevel },
    mode: body.mode,
    fault: body.fault,
    seed,
    specimens: specimens.map((s) => ({ sampleId: s.sampleId, tests: [...(s.tests ?? []), ...(s === specimens[0] ? extraCodes : [])], isQc: !!s.isQc })),
    frames,
    raw: transmissions,
    parsed,
    outcome: { messages, summary, notes },
  };
}

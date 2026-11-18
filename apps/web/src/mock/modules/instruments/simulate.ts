/**
 * "Simulate" for an instrument (port of apps/api/src/modules/instruments/simulate.ts): build
 * realistic raw messages for its model, push them through the real link layer of
 * @natija/protocols (ENQ/ACK frames with checksums, MLLP + HL7 acknowledgements, raw text)
 * between a simulated analyzer and the host, then ingest what the host received exactly as
 * agent traffic is ingested. Everything is marked simulated (readiness L0).
 *
 * Mock-mode difference: runExchange waits for macrotasks with setImmediate, which browsers lack;
 * core/polyfills.ts installs a stand-in.
 */
import {
  corruptChecksum,
  normalize,
  PROFILES,
  runExchange,
  seededRandom,
  simulateResults,
  unmappedCodeFor,
  type InstrumentMessage,
  type InstrumentModel,
  type SessionOptions,
  type SimSpecimen,
} from '@natija/protocols';
import { faultsFor, type IngestOutcome, type SimulateBody, type SimulateResponse, type WireFrame } from '@natija/contracts';
import { badRequest, conflict, ctx, now } from '../../core/context';
import { by, find, first, insert, rows, type Row } from '../../core/db';
import { audit, labTimezone, publish } from '../../core/lib';
import { ingestMessage, logIntegrationEvent } from './ingest';
import { pendingWork, testCodes } from './worklist';

export const VIRTUAL_AGENT_NAME = 'Virtual Lab Agent (demo)';

/** The lab's built-in agent that carries simulated traffic (created on first use). */
export function ensureVirtualAgent(): { id: string; name: string } {
  const existing = first('agents', (a) => a.isVirtual);
  if (existing) return { id: existing.id, name: existing.name };
  const row = insert('agents', {
    labId: ctx().labId,
    name: VIRTUAL_AGENT_NAME,
    status: 'active',
    isVirtual: true,
    version: 'built-in',
    hostInfo: { note: 'Runs inside the platform; carries simulated analyzer traffic only.' },
    createdAt: now(),
  });
  audit({ action: 'agent.create', entityType: 'agent', entityId: row.id, summary: `${VIRTUAL_AGENT_NAME} created for simulated traffic` });
  return { id: row.id, name: row.name };
}


/** A barcode that cannot exist (fault injection: unknown_sample). At most 22 characters for the e 411. */
function unknownBarcode(rnd: () => number): string {
  return `999999-${String(Math.floor(rnd() * 9000) + 1000)}-99`;
}

/** Break the HL7 encoding characters so the receiver cannot parse the message (HL7 has no checksum). */
function corruptHl7(message: string): string {
  return message.replace(/^MSH\|\^~\\&/, 'MSH|^^\\&');
}

function tryNormalize(inst: Row<'instruments'>, raw: string): InstrumentMessage | null {
  try {
    return normalize(inst.model, raw, inst.protocol);
  } catch {
    return null;
  }
}

function buildSpecimens(inst: Row<'instruments'>, body: SimulateBody, rnd: () => number, mappedCodes: string[]): SimSpecimen[] {
  if (body.qc) {
    const maps = by('instrumentMappings', 'instrumentId', inst.id).filter((m) => m.isActive);
    const found: Array<{ m: Row<'qcMaterials'>; code: string; unitFactor: number }> = [];
    for (const m of rows('qcMaterials')) {
      if (!m.isActive || (m.instrumentId !== inst.id && m.instrumentId !== null)) continue;
      for (const map of maps) if (map.analyteId === m.analyteId) found.push({ m, code: map.instrumentCode, unitFactor: map.unitFactor });
    }
    if (!found.length) throw conflict('no_qc_materials', 'No active QC material is set up for the analytes this analyzer reports');
    const byLevel = new Map<string, SimSpecimen>();
    for (const r of found) {
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
    const work = pendingWork(inst.id, { barcodes: body.barcodes, limit: 5 });
    return body.barcodes.map((barcode) => {
      const tube = work.find((t) => t.barcode === barcode);
      const sample = by('samples', 'barcode', barcode)[0];
      const order = sample ? find('orders', sample.orderId) : undefined;
      const person = order ? find('patients', order.patientId) : undefined;
      return {
        sampleId: barcode,
        tests: tube ? testCodes(tube) : mappedCodes.slice(0, 3),
        sex: person?.sex ?? null,
        birthDate: person?.birthDate ?? null,
      };
    });
  }

  const work = pendingWork(inst.id, { limit: 5 });
  if (!work.length) {
    throw conflict('no_pending_samples', 'No tubes are waiting for this analyzer. Register an order with tests mapped to it and collect the tube first, or pass barcodes.');
  }
  return work.map((t) => ({ sampleId: t.barcode, tests: testCodes(t), sex: t.sex, birthDate: t.birthDate }));
}

export async function simulateOnInstrument(inst: Row<'instruments'>, input: Partial<SimulateBody>): Promise<SimulateResponse> {
  const body: SimulateBody = { ...input, mode: input.mode ?? 'normal', fault: input.fault ?? 'none' };
  const model = inst.model;
  if (model === 'other') throw badRequest('simulation_unsupported', 'There is no simulator for instruments without a known model');
  const profile = PROFILES[model as InstrumentModel];
  if (inst.protocol !== profile.protocol) {
    throw badRequest('protocol_mismatch', `The ${profile.name} simulator speaks ${profile.protocol}; this instrument is set to ${inst.protocol}`);
  }
  if (!faultsFor(inst.protocol).includes(body.fault)) {
    throw badRequest('fault_not_applicable', `${body.fault} does not apply to ${inst.protocol}: it has no checksum or acknowledgement`);
  }
  const seed = body.seed ?? Math.floor(Math.random() * 2_147_483_647);
  const rnd = seededRandom(seed);
  const timeZone = labTimezone(ctx().labId);

  const mappedCodes = by('instrumentMappings', 'instrumentId', inst.id)
    .filter((m) => m.isActive && !!find('analytes', m.analyteId))
    .map((m) => m.instrumentCode);
  if (!mappedCodes.length && body.fault !== 'unknown_code') throw conflict('no_mappings', 'This analyzer has no code mappings yet');

  const specimens = buildSpecimens(inst, body, rnd, mappedCodes);
  if (profile.specimenIdMax) {
    const tooLong = specimens.find((s) => s.sampleId.length > profile.specimenIdMax!);
    if (tooLong) throw badRequest('specimen_id_too_long', `${profile.name} accepts specimen IDs up to ${profile.specimenIdMax} characters`);
  }

  let extraCodes: string[] = [];
  if (body.fault === 'unknown_code') {
    let code = unmappedCodeFor(model, rnd);
    for (let i = 0; mappedCodes.includes(code) && i < 10; i++) code = `${unmappedCodeFor(model, rnd)}${i}`;
    extraCodes = [code];
  }

  const agent = ensureVirtualAgent();
  const sims = simulateResults({ model, specimens, mode: body.mode, seed, now: now(), timeZone, extraCodes });
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
      logIntegrationEvent({ instrumentId: inst.id, agentId: agent.id, level: 'error', event: inst.protocol === 'astm' ? 'checksum_error' : 'message_refused', detail: `${detail} (simulated)` });
      notes.push(detail);
    }
    for (const partial of ex.incomplete) {
      ingestMessage({ instrumentId: inst.id, agentId: agent.id, raw: partial.text, isSimulated: true, incomplete: true, note: partial.reason });
      notes.push(`The partial message (${partial.reason}) was stored with status error for review.`);
    }
    for (const text of ex.received) {
      delivered++;
      const out = ingestMessage({ instrumentId: inst.id, agentId: agent.id, raw: text, isSimulated: true });
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
  if (model === 'ichroma3') notes.push('ichroma III traffic uses an INVENTED demo format: Boditech publishes no host-interface specification.');
  if (model === 'medica_easystat') notes.push('The Medica printout layout is an assumption until checked against a real EasyStat printout.');
  notes.push('Simulated traffic (readiness L0): no real analyzer took part.');

  audit({
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

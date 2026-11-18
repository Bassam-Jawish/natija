import { describe, expect, it } from 'vitest';
import { MODELS, PROFILES, type InstrumentModel } from './profiles';
import { normalize, ProtocolError } from './normalize';
import { buildHostReply, parseHostOrders, simulateQuery, simulateResults } from './simulate';
import { runExchange } from './exchange';
import { corruptChecksum } from './astm-link';
import { buildAstm } from './astm';

const NOW = new Date('2026-11-17T08:15:30Z');
const BARCODE = '261117-0042-01';

function tests(model: InstrumentModel, n = 4): string[] {
  return PROFILES[model].tests.slice(0, n).map((t) => t.code);
}

describe('normalize() golden round trip for every model', () => {
  for (const model of MODELS) {
    for (const mode of ['normal', 'abnormal', 'critical'] as const) {
      it(`${model} ${mode}: simulate → link layer → normalize gives back the same values`, async () => {
        const [sim] = simulateResults({ model, mode, seed: 7, now: NOW, timeZone: 'Asia/Damascus', specimens: [{ sampleId: BARCODE, tests: tests(model), sex: 'male', birthDate: '1980-02-03' }] });
        const ex = await runExchange({ protocol: PROFILES[model].protocol, messages: [sim!.raw] });
        expect(ex.sendResults.every((r) => r.ok)).toBe(true);
        expect(ex.received).toHaveLength(1);
        const n = normalize(model, ex.received[0]!);
        expect(n.kind).toBe('results');
        expect(n.protocol).toBe(PROFILES[model].protocol);
        expect(n.specimens).toHaveLength(1);
        const spec = n.specimens[0]!;
        expect(spec.sampleId).toBe(BARCODE);
        expect(spec.isQc).toBe(false);
        expect(spec.results.map((r) => [r.code, r.value])).toEqual(sim!.values.map((v) => [v.code, v.value]));
        for (const r of spec.results) {
          const v = sim!.values.find((x) => x.code === r.code)!;
          expect(r.unit ?? '').toBe(v.unit);
          expect(r.measuredAt?.startsWith('2026-11-17T11:15')).toBe(true);
        }
        expect(n.records.length).toBeGreaterThan(0);
      });
    }
  }

  it('Sysmex graph references are kept apart from results', () => {
    const [sim] = simulateResults({ model: 'sysmex_xn', mode: 'normal', seed: 1, now: NOW, specimens: [{ sampleId: BARCODE, tests: ['WBC'] }] });
    const spec = normalize('sysmex_xn', sim!.raw).specimens[0]!;
    expect(spec.results.map((r) => r.code)).toEqual(['WBC']);
    expect(spec.graphs.map((g) => g.code)).toEqual(['WDF_SCATTERGRAM', 'PLT_HISTOGRAM']);
    expect(spec.graphs[0]!.ref).toBe(`PNG\\20261117\\${BARCODE}_WDF.PNG`);
  });

  it('e 411 reads ^^^ACN^dilution, flags and the RSUPL header', () => {
    const [sim] = simulateResults({ model: 'cobas_e411', mode: 'abnormal', seed: 3, now: NOW, specimens: [{ sampleId: BARCODE, tests: ['1010'] }] });
    const n = normalize('cobas_e411', sim!.raw);
    expect(n.messageType).toBe('ASTM RSUPL^REAL');
    expect(n.sender).toBe('cobas-e411^1');
    expect(n.specimens[0]!.results[0]).toMatchObject({ code: '1010', dilution: 1, status: 'F', flags: 'H' });
  });

  it('critical mode produces the profile critical values', () => {
    const [sim] = simulateResults({ model: 'cobas_pure', mode: 'critical', seed: 5, now: NOW, specimens: [{ sampleId: BARCODE, tests: ['K'] }] });
    expect(['2.3', '6.9']).toContain(sim!.values[0]!.value);
  });

  it('is deterministic for a seed', () => {
    const a = simulateResults({ model: 'mindray_bs430', mode: 'abnormal', seed: 11, now: NOW, specimens: [{ sampleId: BARCODE }] });
    const b = simulateResults({ model: 'mindray_bs430', mode: 'abnormal', seed: 11, now: NOW, specimens: [{ sampleId: BARCODE }] });
    expect(a).toEqual(b);
  });

  it('marks QC results (ASTM action code Q, LAW SPM-11 Q, Mindray MSH-16 2)', () => {
    for (const model of ['cobas_e411', 'sysmex_xn', 'cobas_pure', 'mindray_bs430'] as const) {
      const code = PROFILES[model].tests[0]!.code;
      const [sim] = simulateResults({ model, mode: 'normal', seed: 2, now: NOW, specimens: [{ sampleId: 'QC-L1', isQc: true, tests: [code], qcTargets: { [code]: { mean: 10, sd: 0.5 } } }] });
      const n = normalize(model, sim!.raw);
      expect(n.kind).toBe('qc');
      expect(n.specimens[0]!.isQc).toBe(true);
      const v = Number(n.specimens[0]!.results[0]!.value);
      expect(Math.abs(v - 10)).toBeLessThanOrEqual(0.75);
    }
  });

  it('includes unknown codes the lab has not mapped', () => {
    const [sim] = simulateResults({ model: 'cobas_e411', mode: 'normal', seed: 2, now: NOW, specimens: [{ sampleId: BARCODE, tests: ['1010'] }], extraCodes: ['9901'] });
    expect(normalize('cobas_e411', sim!.raw).specimens[0]!.results.map((r) => r.code)).toEqual(['1010', '9901']);
  });

  it('throws ProtocolError for unreadable input', () => {
    expect(() => normalize('cobas_pure', 'PID|1\r')).toThrow(ProtocolError);
    expect(() => normalize('sysmex_xn', 'H|\\^&\r1R|x\r')).toThrow(ProtocolError);
    expect(() => normalize('medica_easystat', 'hello\r\n')).toThrow(ProtocolError);
    expect(() => normalize('ichroma3', 'nothing here')).toThrow(ProtocolError);
    expect(() => normalize('other', 'x')).toThrow(ProtocolError);
  });

  it('reads generic ASTM for instruments without a profile', () => {
    const raw = buildAstm(['H|\\^&|||ACME', 'O|1|S-9||^^^GLU', 'R|1|^^^GLU|5.4|mmol/L||N||F', 'L|1|N']);
    const n = normalize('other', raw, 'astm');
    expect(n.specimens[0]!.results[0]).toMatchObject({ code: 'GLU', value: '5.4', unit: 'mmol/L' });
  });
});

describe('host queries', () => {
  for (const model of ['cobas_e411', 'sysmex_xn', 'cobas_pure', 'mindray_bs430'] as const) {
    it(`${model}: query → host reply → orders, through the link layer`, async () => {
      const query = simulateQuery({ model, sampleIds: [BARCODE], now: NOW });
      const q = normalize(model, query);
      expect(q.kind).toBe('query');
      expect(q.queries[0]!.sampleIds).toEqual([BARCODE]);
      const wanted = tests(model, 2);
      const fromHost: string[] = [];
      const ex = await runExchange({
        protocol: PROFILES[model].protocol,
        messages: [query],
        onHostMessage: (m) => ({ reply: buildHostReply({ model, query: m.text, now: NOW, orders: [{ sampleId: BARCODE, found: true, tests: wanted, priority: 'stat', sex: 'female', birthDate: '1990-01-01' }] }) }),
        onInstrumentMessage: (m) => {
          fromHost.push(m.text);
        },
      });
      expect(ex.received).toEqual([query]);
      const orders = fromHost.flatMap((t) => parseHostOrders(model, t)).filter((o) => o.found);
      expect(orders).toEqual([{ sampleId: BARCODE, found: true, tests: wanted, priority: 'stat' }]);
    });

    it(`${model}: unknown sample gets a "no work" answer`, () => {
      const query = simulateQuery({ model, sampleIds: ['NOPE-1'], now: NOW });
      const replies = buildHostReply({ model, query, now: NOW, orders: [{ sampleId: 'NOPE-1', found: false, tests: [] }] });
      const orders = replies.flatMap((r) => parseHostOrders(model, r));
      expect(orders.every((o) => !o.found)).toBe(true);
    });
  }

  it('results-only instruments refuse to build queries', () => {
    expect(() => simulateQuery({ model: 'medica_easystat', sampleIds: ['x'] })).toThrow(/results only/);
  });
});

describe('faults across the in-memory link', () => {
  it('a persistently bad checksum is NAKed and nothing reaches the host', async () => {
    const [sim] = simulateResults({ model: 'cobas_e411', mode: 'normal', seed: 1, now: NOW, specimens: [{ sampleId: BARCODE, tests: ['1010'] }] });
    const ex = await runExchange({ protocol: 'astm', messages: [sim!.raw], instrument: { astm: { mutateFrame: (f, i) => (i.index === 2 ? corruptChecksum(f) : f) } } });
    expect(ex.sendResults[0]!.ok).toBe(false);
    expect(ex.received).toEqual([]);
    expect(ex.trace.filter((t) => t.side === 'host' && t.text === '<NAK>')).toHaveLength(7);
    // The two frames accepted before the bad one are reported as an incomplete message, never applied.
    expect(ex.incomplete).toHaveLength(1);
    expect(ex.incomplete[0]!.text.startsWith('H|')).toBe(true);
  });

  it('an HL7 message with broken delimiters is answered AR and not delivered as readable', async () => {
    const [sim] = simulateResults({ model: 'cobas_pure', mode: 'normal', seed: 1, now: NOW, specimens: [{ sampleId: BARCODE, tests: ['GLUC3'] }] });
    const ex = await runExchange({ protocol: 'hl7', messages: [sim!.raw], instrument: { hl7: { mutateOutgoing: (m) => m.replace('MSH|^~\\&', 'MSH|^^\\&') } } });
    expect(ex.sendResults[0]).toMatchObject({ ok: false });
    expect(ex.sendResults[0]!.error).toMatch(/^AR/);
  });

  it('the same message sent twice arrives twice; dropping duplicates is the server\'s job', async () => {
    const [sim] = simulateResults({ model: 'mindray_bs430', mode: 'normal', seed: 1, now: NOW, specimens: [{ sampleId: BARCODE, tests: ['GLU'] }] });
    const ex = await runExchange({ protocol: 'hl7', messages: [sim!.raw, sim!.raw] });
    expect(ex.received).toEqual([sim!.raw, sim!.raw]);
    expect(normalize('mindray_bs430', ex.received[0]!)).toEqual(normalize('mindray_bs430', ex.received[1]!));
  });
});

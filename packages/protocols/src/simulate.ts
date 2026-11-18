/**
 * Simulated analyzer traffic for each instrument model, built from the profile test menus.
 *
 * Every message produced here is SIMULATED (readiness level L0). Layouts follow the
 * protocol research in docs/analyzers.md; vendor-specific field contents that are not
 * verified are marked in comments. Output is deterministic for a given seed and clock.
 */
import { PROFILES, type InstrumentModel, type ProfileTest } from './profiles';
import { astmGet, astmRecord, astmRepeats, buildAstm, parseAstm } from './astm';
import { buildHl7, hl7Get, hl7Segment, parseHl7, type Hl7Message } from './hl7';
import { buildMedicaPrintout } from './medica';
import { buildIchromaDemo } from './ichroma';
import { pick, seededRandom, seedFrom } from './random';
import { compactTimestamp, localIso } from './time';

export type SimMode = 'normal' | 'abnormal' | 'critical';

export type SimSpecimen = {
  /** Tube barcode (or a control ID for QC). */
  sampleId: string;
  /** Instrument test codes to report; defaults to the whole profile menu. */
  tests?: string[];
  isQc?: boolean;
  /** QC target per test code: values are drawn around the mean (normal ±1.5 SD, abnormal ~2.5 SD, critical ~3.5 SD). */
  qcTargets?: Record<string, { mean: number; sd: number }>;
  patientId?: string | null;
  sex?: 'male' | 'female' | null;
  birthDate?: string | null;
};

export type SimValue = { code: string; value: string; unit: string; flag: 'L' | 'H' | 'N'; known: boolean };

export type SimulatedMessage = {
  raw: string;
  sampleId: string;
  isQc: boolean;
  controlId: string;
  values: SimValue[];
};

export type SimulateOptions = {
  model: InstrumentModel;
  specimens: SimSpecimen[];
  mode: SimMode;
  seed?: number;
  now?: Date;
  /** Zone of the analyzer's clock (timestamps are local, without offset). */
  timeZone?: string;
  /** Codes the instrument reports but the lab has not mapped (fault injection). */
  extraCodes?: string[];
};

export function profileTest(model: InstrumentModel, code: string): ProfileTest | undefined {
  return PROFILES[model].tests.find((t) => t.code === code);
}

function round(value: number, decimals: number): string {
  return value.toFixed(Math.max(0, Math.min(6, decimals)));
}

function generateValue(test: ProfileTest, mode: SimMode, rnd: () => number): number {
  const within = ([a, b]: [number, number]) => a + (b - a) * rnd();
  if (mode === 'critical' && test.critical) {
    const [lo, hi] = test.critical;
    const low = lo < test.normal[0];
    const high = hi > test.normal[1];
    if (low && high) return rnd() < 0.5 ? lo : hi;
    return high ? hi : lo;
  }
  if (mode !== 'normal' && test.abnormal) return within(test.abnormal);
  return within(test.normal);
}

function flagFor(value: number, test: ProfileTest): 'L' | 'H' | 'N' {
  if (value < test.normal[0]) return 'L';
  if (value > test.normal[1]) return 'H';
  return 'N';
}

/** Values for one specimen. */
export function simulateValues(model: InstrumentModel, spec: SimSpecimen, mode: SimMode, rnd: () => number, extraCodes: string[] = []): SimValue[] {
  const codes = spec.tests?.length ? spec.tests : PROFILES[model].tests.map((t) => t.code);
  const out: SimValue[] = [];
  for (const code of [...codes, ...extraCodes]) {
    const test = profileTest(model, code);
    const target = spec.qcTargets?.[code];
    if (target && test) {
      const k = mode === 'normal' ? (rnd() * 3 - 1.5) : mode === 'abnormal' ? 2.5 + rnd() * 0.3 : 3.5 + rnd() * 0.3;
      const v = target.mean + k * target.sd;
      out.push({ code, value: round(v, test.decimals + 1), unit: test.unit, flag: 'N', known: true });
      continue;
    }
    if (!test) {
      out.push({ code, value: round(10 + rnd() * 90, 1), unit: '', flag: 'N', known: false });
      continue;
    }
    const v = generateValue(test, mode, rnd);
    out.push({ code, value: round(v, test.decimals), unit: test.unit, flag: flagFor(Number(round(v, test.decimals)), test), known: true });
  }
  if (model === 'sysmex_xn' && !spec.isQc && !spec.qcTargets) harmonizeCbc(out);
  return out;
}

/**
 * Make a simulated blood count agree with itself, as a real analyzer's does: the differential
 * adds up to 100 %, the absolute counts follow the WBC, and HCT, RBC and MCH follow from HGB,
 * MCV and MCHC. The drawn values keep their story (a high NEUT% stays high).
 */
function harmonizeCbc(out: SimValue[]): void {
  const get = (code: string) => out.find((v) => v.code === code && v.known);
  const num = (code: string) => {
    const v = get(code);
    return v ? Number(v.value) : null;
  };
  const set = (code: string, value: number) => {
    const v = get(code);
    const test = profileTest('sysmex_xn', code);
    if (!v || !test) return;
    v.value = round(value, test.decimals);
    v.flag = flagFor(Number(v.value), test);
  };

  const wbc = num('WBC');
  const neut = num('NEUT%');
  const mono = num('MONO%');
  const eo = num('EO%');
  const baso = num('BASO%');
  if (neut !== null && mono !== null && eo !== null && baso !== null) {
    const shares: Record<string, number> = { 'NEUT%': neut, 'LYMPH%': Math.max(3, 100 - neut - mono - eo - baso), 'MONO%': mono, 'EO%': eo, 'BASO%': baso };
    const total = Object.values(shares).reduce((a, b) => a + b, 0);
    for (const [code, value] of Object.entries(shares)) {
      const pct = (value * 100) / total;
      set(code, pct);
      if (wbc !== null) set(code.replace('%', '#'), (wbc * pct) / 100);
    }
  }

  const hgb = num('HGB');
  const mcv = num('MCV');
  const mchc = num('MCHC');
  if (hgb !== null && mcv !== null && mchc !== null && mchc > 0 && mcv > 0) {
    const hct = (hgb / mchc) * 100;
    const rbc = (hct / mcv) * 10;
    set('HCT', hct);
    set('RBC', rbc);
    set('MCH', (hgb / rbc) * 10);
  }
}

const SEX_CODE = { male: 'M', female: 'F' } as const;

function sexCode(sex: SimSpecimen['sex']): string {
  return sex ? SEX_CODE[sex] : 'U';
}

function compactDate(iso: string | null | undefined): string {
  return iso ? iso.replace(/-/g, '').slice(0, 8) : '';
}

/** Build simulated result messages (one message per specimen, as the analyzers do). */
export function simulateResults(opts: SimulateOptions): SimulatedMessage[] {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone ?? 'UTC';
  const seed = opts.seed ?? seedFrom(`${opts.model}:${now.toISOString()}`);
  const rnd = seededRandom(seed);
  return opts.specimens.map((spec, i) => {
    const values = simulateValues(opts.model, spec, opts.mode, rnd, i === 0 ? opts.extraCodes ?? [] : []);
    const at = new Date(now.getTime() + i * 1000);
    const controlId = `SIM${(seed % 100000).toString().padStart(5, '0')}${String(i + 1).padStart(3, '0')}`;
    return { raw: BUILDERS[opts.model]({ spec, values, at, tz, controlId, rnd }), sampleId: spec.sampleId, isQc: !!spec.isQc, controlId, values };
  });
}

type BuildInput = { spec: SimSpecimen; values: SimValue[]; at: Date; tz: string; controlId: string; rnd: () => number };

const BUILDERS: Record<InstrumentModel, (b: BuildInput) => string> = {
  sysmex_xn: sysmexResults,
  cobas_e411: e411Results,
  cobas_pure: cobasPureResults,
  mindray_bs430: mindrayResults,
  medica_easystat: medicaResults,
  ichroma3: ichromaResults,
};

/* ------------------------------------------------------------------ Sysmex XN (ASTM, likely) */

const SYSMEX_SENDER = ['XN-550', '00-26', 'SIM0001', '', '', '', 'SIM0001'];

function sysmexResults({ spec, values, at, tz, controlId }: BuildInput): string {
  const ts = compactTimestamp(at, tz);
  const day = ts.slice(0, 8);
  const records = [
    astmRecord('H', { 3: controlId, 5: SYSMEX_SENDER, 13: 'E1394-97', 14: ts }),
    astmRecord('P', { 2: 1, 4: spec.patientId ?? '', 8: compactDate(spec.birthDate), 9: sexCode(spec.sex) }),
    // Results carry the sample number in O.4 (rack^position^sample no^B = read from barcode).
    astmRecord('O', { 2: 1, 4: ['', '', spec.sampleId, 'B'], 5: values.map((v) => ['', '', '', '', v.code]), 12: spec.isQc ? 'Q' : 'N', 26: 'F' }),
    ...values.map((v, i) => astmRecord('R', { 2: i + 1, 3: ['', '', '', '', v.code, '1'], 4: v.value, 5: v.unit, 7: v.flag, 13: ts })),
    // Graph references (Sysmex sends file references for scattergrams/histograms; layout likely, not verified).
    astmRecord('R', { 2: values.length + 1, 3: ['', '', '', '', 'WDF_SCATTERGRAM', '1'], 4: `PNG\\${day}\\${spec.sampleId}_WDF.PNG`, 13: ts }),
    astmRecord('R', { 2: values.length + 2, 3: ['', '', '', '', 'PLT_HISTOGRAM', '1'], 4: `PNG\\${day}\\${spec.sampleId}_PLT.PNG`, 13: ts }),
    astmRecord('L', { 2: 1, 3: 'N' }),
  ];
  return buildAstm(records);
}

/* ------------------------------------------------------------------ cobas e 411 (ASTM, verified protocol) */

const E411_SENDER = ['cobas-e411', '1'];

function e411Results({ spec, values, at, tz, controlId }: BuildInput): string {
  const ts = compactTimestamp(at, tz);
  if (spec.sampleId.length > 22) throw new Error('cobas e 411 specimen IDs are at most 22 characters');
  const records = [
    astmRecord('H', { 3: controlId, 5: E411_SENDER, 10: 'host', 11: ['RSUPL', 'REAL'], 12: 'P', 13: '1', 14: ts }),
    astmRecord('P', { 2: 1 }),
    // O.4 instrument specimen ID: sequence^rack^position^^sample type^container (Roche layout, confirm on site).
    astmRecord('O', { 2: 1, 3: spec.sampleId, 4: ['1', '50001', '1', '', 'S1', 'SC'], 5: values.map((v) => ['', '', '', v.code, '1']), 6: 'R', 12: spec.isQc ? 'Q' : 'N', 26: 'F' }),
    ...values.map((v, i) => astmRecord('R', { 2: i + 1, 3: ['', '', '', v.code, '1'], 4: v.value, 5: v.unit, 7: v.flag, 9: 'F', 13: ts, 14: 'e411' })),
    astmRecord('L', { 2: 1, 3: 'N' }),
  ];
  return buildAstm(records);
}

/* ------------------------------------------------------------------ cobas pure (HL7 v2.5 IHE LAW, verified) */

function lawMsh(type: string[], controlId: string, ts: string, profile: string, fromInstrument: boolean): string {
  const [app, facility] = fromInstrument ? ['cobas pure', 'SIM'] : ['Natija', 'LIS'];
  const [toApp, toFacility] = fromInstrument ? ['Natija', 'LIS'] : ['cobas pure', 'SIM'];
  return hl7Segment('MSH', { 3: app, 4: facility, 5: toApp, 6: toFacility, 7: ts, 9: type, 10: controlId, 11: 'P', 12: '2.5', 15: 'NE', 16: type[0] === 'RSP' ? 'NE' : 'AL', 18: 'UNICODE UTF-8', 21: [profile, 'IHE'] });
}

function cobasPureResults({ spec, values, at, tz, controlId }: BuildInput): string {
  const ts = compactTimestamp(at, tz);
  const segments = [
    lawMsh(['OUL', 'R22', 'OUL_R22'], controlId, ts, 'LAB-29', true),
    hl7Segment('SPM', { 1: 1, 2: [[spec.sampleId]], 4: ['S1', 'Serum/Plasma', '99ROC'], 11: spec.isQc ? 'Q' : 'P' }),
    hl7Segment('SAC', { 3: spec.sampleId }),
  ];
  values.forEach((v, i) => {
    segments.push(
      hl7Segment('OBR', { 1: i + 1, 2: `${spec.sampleId}-${i + 1}`, 4: [v.code, '', '99ROC'] }),
      hl7Segment('ORC', { 1: 'SC', 2: `${spec.sampleId}-${i + 1}`, 5: 'CM' }),
      hl7Segment('OBX', { 1: 1, 2: 'NM', 3: [v.code, '', '99ROC'], 4: 1, 5: v.value, 6: v.unit ? [v.unit, '', 'UCUM'] : '', 8: v.flag, 11: 'F', 16: 'SIM', 18: ['cobas pure', 'SIM0001'], 19: ts }),
    );
  });
  return buildHl7(segments);
}

/* ------------------------------------------------------------------ Mindray BS-430 (HL7 v2.3.1, likely) */

function mindrayMsh(type: string[], controlId: string, ts: string, fromInstrument: boolean, resultType = '0'): string {
  return hl7Segment('MSH', {
    3: fromInstrument ? 'Mindray' : 'Natija',
    4: fromInstrument ? 'BS-430' : 'LIS',
    5: fromInstrument ? '' : 'Mindray',
    6: fromInstrument ? '' : 'BS-430',
    7: ts,
    9: type,
    10: controlId,
    11: 'P',
    12: '2.3.1',
    // Mindray uses MSH-16 for the result type: 0 sample, 1 calibration, 2 QC (secondary sources).
    16: type[0] === 'ORU' ? resultType : undefined,
    18: 'ASCII',
  });
}

function mindrayResults({ spec, values, at, tz, controlId }: BuildInput): string {
  const ts = compactTimestamp(at, tz);
  const menu = PROFILES.mindray_bs430.tests;
  const segments = [
    mindrayMsh(['ORU', 'R01'], controlId, ts, true, spec.isQc ? '2' : '0'),
    hl7Segment('PID', { 1: 1, 3: spec.patientId ?? '', 7: compactDate(spec.birthDate), 8: sexCode(spec.sex) }),
    hl7Segment('OBR', { 1: 1, 2: spec.sampleId, 3: '1', 4: ['Mindray', 'BS-430'], 5: 'N', 7: ts, 15: 'serum' }),
    // Test number in OBX-3, test name in OBX-4 (Mindray convention per secondary sources).
    ...values.map((v, i) => {
      const t = menu.find((m) => m.code === v.code);
      const range = t ? `${t.normal[0]}-${t.normal[1]}` : '';
      const channel = t ? menu.indexOf(t) + 1 : 900 + i;
      return hl7Segment('OBX', { 1: i + 1, 2: 'NM', 3: channel, 4: v.code, 5: v.value, 6: v.unit, 7: range, 8: v.flag, 11: 'F', 13: v.value, 14: ts });
    }),
  ];
  return buildHl7(segments);
}

/* ------------------------------------------------------------------ Medica EasyStat (printout, layout assumed) */

function medicaResults({ spec, values, at, tz }: BuildInput): string {
  return buildMedicaPrintout({
    sampleId: spec.sampleId,
    at: localIso(at, tz),
    results: values.map((v) => ({ code: v.code, value: v.value, unit: v.unit || null, flag: v.flag === 'N' ? null : v.flag })),
  });
}

/* ------------------------------------------------------------------ ichroma III (INVENTED demo format) */

function ichromaResults({ spec, values, at, tz }: BuildInput): string {
  const time = localIso(at, tz);
  return buildIchromaDemo(values.map((v) => ({ sampleId: spec.sampleId, test: v.code, value: v.value, unit: v.unit, time })));
}

/* ================================================================== host queries */

export type QueryOptions = { model: InstrumentModel; sampleIds: string[]; now?: Date; timeZone?: string; controlId?: string };

/** The analyzer asking the host for its work: ASTM Q record, QBP^Q11 (cobas pure) or QRY^Q02 (Mindray). */
export function simulateQuery(opts: QueryOptions): string {
  const ts = compactTimestamp(opts.now ?? new Date(), opts.timeZone ?? 'UTC');
  const ctrl = opts.controlId ?? `Q${ts.slice(8)}`;
  const ids = opts.sampleIds;
  switch (opts.model) {
    case 'cobas_e411':
      return buildAstm([
        astmRecord('H', { 3: ctrl, 5: E411_SENDER, 10: 'host', 11: ['TSREQ', 'REAL'], 12: 'P', 13: '1', 14: ts }),
        // Q.3 starting range: ^sample ID^sequence^rack^position^^sample type^container (confirm with the Roche manual).
        ...ids.map((id, i) => astmRecord('Q', { 2: i + 1, 3: ['', id, String(i + 1).padStart(4, '0'), '50001', String(i + 1), '', 'S1', 'SC'], 5: 'ALL', 13: 'O' })),
        astmRecord('L', { 2: 1, 3: 'N' }),
      ]);
    case 'sysmex_xn':
      return buildAstm([
        astmRecord('H', { 3: ctrl, 5: SYSMEX_SENDER, 13: 'E1394-97', 14: ts }),
        ...ids.map((id, i) => astmRecord('Q', { 2: i + 1, 3: ['', '', id, 'B'], 5: 'ALL', 7: ts, 13: 'O' })),
        astmRecord('L', { 2: 1, 3: 'N' }),
      ]);
    case 'cobas_pure':
      return buildHl7([
        lawMsh(['QBP', 'Q11', 'QBP_Q11'], ctrl, ts, 'LAB-27', true),
        hl7Segment('QPD', { 1: ['LAB-27', 'Query For AWOS', 'IHE_LABTF'], 2: `T${ctrl}`, 3: ids[0] ?? '' }),
        hl7Segment('RCP', { 1: 'I', 3: 'R' }),
      ]);
    case 'mindray_bs430':
      return buildHl7([
        mindrayMsh(['QRY', 'Q02'], ctrl, ts, true),
        hl7Segment('QRD', { 1: ts, 2: 'R', 3: 'D', 4: ctrl, 7: 'RD', 8: { repeat: ids }, 9: 'OTH', 12: 'T' }),
        hl7Segment('QRF', { 1: 'BS-430', 6: 'RCT', 7: 'COR', 8: 'ALL' }),
      ]);
    default:
      throw new Error(`${PROFILES[opts.model].name} does not query the host (results only)`);
  }
}

export type HostOrder = {
  sampleId: string;
  /** False when the host has no pending work for this sample. */
  found: boolean;
  tests: string[];
  priority?: 'routine' | 'urgent' | 'stat';
  sex?: 'male' | 'female' | null;
  birthDate?: string | null;
};

export type HostReplyOptions = {
  model: InstrumentModel;
  /** The query message as received from the analyzer. */
  query: string;
  orders: HostOrder[];
  now?: Date;
  timeZone?: string;
  /** Control ID for the first reply message (others add a suffix). */
  controlId?: string;
};

function astmPriority(p: HostOrder['priority']): string {
  return p === 'stat' ? 'S' : p === 'urgent' ? 'A' : 'R';
}

/**
 * The host's answer to a query: an ASTM order message (Roche TSDWN^REPLY style for the
 * e 411, O records for Sysmex), RSP^K11 then OML^O33 for the cobas pure, QCK^Q02 then
 * DSR^Q03 for the Mindray. Patient names are never sent.
 */
export function buildHostReply(opts: HostReplyOptions): string[] {
  const now = opts.now ?? new Date();
  const ts = compactTimestamp(now, opts.timeZone ?? 'UTC');
  const ctrl = opts.controlId ?? `H${ts.slice(6)}`;
  switch (opts.model) {
    case 'cobas_e411':
    case 'sysmex_xn':
      return [astmHostReply(opts, ts, ctrl)];
    case 'cobas_pure':
      return lawHostReply(opts, ts, ctrl);
    case 'mindray_bs430':
      return mindrayHostReply(opts, ts, ctrl);
    default:
      throw new Error(`${PROFILES[opts.model].name} does not query the host (results only)`);
  }
}

function astmHostReply(opts: HostReplyOptions, ts: string, ctrl: string): string {
  const e411 = opts.model === 'cobas_e411';
  // Echo the instrument's sample position info from the query (e 411: Q.3 components 3-9).
  const echo = new Map<string, string[]>();
  try {
    const q = parseAstm(opts.query);
    for (const r of q.records.filter((x) => x.type === 'Q')) {
      for (const comps of astmRepeats(r, 3, q.delimiters)) {
        const id = e411 ? comps[1] ?? '' : comps[2] ?? '';
        if (id) echo.set(id.trim(), comps);
      }
    }
  } catch {
    // An unreadable query still gets an answer for the IDs the caller resolved.
  }
  const records = [
    e411
      ? astmRecord('H', { 3: ctrl, 5: 'host', 10: E411_SENDER, 11: ['TSDWN', 'REPLY'], 12: 'P', 13: '1', 14: ts })
      : astmRecord('H', { 3: ctrl, 5: ['Natija', 'LIS'], 13: 'E1394-97', 14: ts }),
  ];
  opts.orders.forEach((o, i) => {
    records.push(astmRecord('P', { 2: i + 1, 8: compactDate(o.birthDate), 9: sexCode(o.sex) }));
    const comps = echo.get(o.sampleId);
    const tests = o.tests.map((code) => (e411 ? ['', '', '', code, '1'] : ['', '', '', '', code]));
    if (e411) {
      const position = comps ? [comps[2] ?? '', comps[3] ?? '', comps[4] ?? '', '', comps[6] ?? 'S1', comps[7] ?? 'SC'] : ['', '', '', '', 'S1', 'SC'];
      records.push(astmRecord('O', { 2: 1, 3: o.sampleId, 4: position, 5: o.found ? tests : '', 6: astmPriority(o.priority), 7: ts, 12: 'N', 26: o.found ? 'Q' : 'Y' }));
    } else {
      records.push(astmRecord('O', { 2: 1, 3: ['', '', o.sampleId, 'B'], 5: o.found ? tests : '', 6: astmPriority(o.priority), 7: ts, 12: 'N', 26: o.found ? 'Q' : 'Y' }));
    }
  });
  records.push(astmRecord('L', { 2: 1, 3: 'N' }));
  return buildAstm(records);
}

function safeParseHl7(text: string): Hl7Message | null {
  try {
    return parseHl7(text);
  } catch {
    return null;
  }
}

function lawHostReply(opts: HostReplyOptions, ts: string, ctrl: string): string[] {
  const q = safeParseHl7(opts.query);
  const qpd = q?.segments.find((s) => s.name === 'QPD');
  const tag = qpd && q ? hl7Get(qpd, 2, q.delimiters) : ctrl;
  const order = opts.orders[0];
  const found = !!order?.found && order.tests.length > 0;
  const rsp = buildHl7([
    lawMsh(['RSP', 'K11', 'RSP_K11'], ctrl, ts, 'LAB-27R', false),
    hl7Segment('MSA', { 1: 'AA', 2: q?.controlId ?? '' }),
    hl7Segment('QAK', { 1: tag, 2: found ? 'OK' : 'NF', 3: ['LAB-27', 'Query For AWOS', 'IHE_LABTF'] }),
    hl7Segment('QPD', { 1: ['LAB-27', 'Query For AWOS', 'IHE_LABTF'], 2: tag, 3: order?.sampleId ?? '' }),
  ]);
  if (!found || !order) return [rsp];
  const segments = [
    lawMsh(['OML', 'O33', 'OML_O33'], `${ctrl}-1`, ts, 'LAB-28', false),
    // PID-5 (name) is left empty on purpose: patient names never leave the platform.
    hl7Segment('PID', { 1: 1, 7: compactDate(order.birthDate), 8: sexCode(order.sex) }),
    hl7Segment('SPM', { 1: 1, 2: [[order.sampleId]], 4: ['S1', 'Serum/Plasma', '99ROC'], 11: 'P' }),
    hl7Segment('SAC', { 3: order.sampleId }),
  ];
  order.tests.forEach((code, i) => {
    segments.push(
      hl7Segment('ORC', { 1: 'NW', 2: `${order.sampleId}-${i + 1}` }),
      hl7Segment('TQ1', { 1: i + 1, 9: order.priority === 'stat' ? 'S' : 'R' }),
      hl7Segment('OBR', { 1: i + 1, 2: `${order.sampleId}-${i + 1}`, 4: [code, '', '99ROC'] }),
    );
  });
  return [rsp, buildHl7(segments)];
}

function mindrayHostReply(opts: HostReplyOptions, ts: string, ctrl: string): string[] {
  const q = safeParseHl7(opts.query);
  const order = opts.orders[0];
  const found = !!order?.found && order.tests.length > 0;
  const qrd = q?.segments.find((s) => s.name === 'QRD');
  const qrf = q?.segments.find((s) => s.name === 'QRF');
  const echo = (seg: typeof qrd, name: string) => (seg ? seg.fields.join('|') : name);
  const qck = buildHl7([
    mindrayMsh(['QCK', 'Q02'], ctrl, ts, false),
    hl7Segment('MSA', { 1: 'AA', 2: q?.controlId ?? '', 3: 'Message accepted', 6: '0' }),
    hl7Segment('ERR', { 1: '0' }),
    hl7Segment('QAK', { 1: 'SR', 2: found ? 'OK' : 'NF' }),
  ]);
  if (!found || !order) return [qck];
  // DSP line numbers follow secondary descriptions of Mindray's chemistry interface
  // (21 barcode, 24 STAT, 26 sample type, 29+ tests). Confirm with the BS-430 manual.
  const dsp = new Map<number, string>([
    [4, order.birthDate ? `${compactDate(order.birthDate)}000000` : ''],
    [5, sexCode(order.sex)],
    [21, order.sampleId],
    [22, '1'],
    [23, ts],
    [24, order.priority === 'stat' || order.priority === 'urgent' ? 'Y' : 'N'],
    [26, 'serum'],
  ]);
  order.tests.forEach((code, i) => dsp.set(29 + i, `${code}^^^`));
  const last = 28 + order.tests.length;
  const lines: string[] = [];
  for (let n = 1; n <= last; n++) lines.push(`DSP|${n}||${dsp.get(n) ?? ''}|||`);
  return [
    qck,
    buildHl7([
      mindrayMsh(['DSR', 'Q03'], `${ctrl}-1`, ts, false),
      hl7Segment('MSA', { 1: 'AA', 2: q?.controlId ?? '', 3: 'Message accepted', 6: '0' }),
      hl7Segment('ERR', { 1: '0' }),
      hl7Segment('QAK', { 1: 'SR', 2: 'OK' }),
      echo(qrd, `QRD|${ts}|R|D|${ctrl}|||RD|${order.sampleId}|OTH|||T|`),
      echo(qrf, 'QRF|BS-430|||||RCT|COR|ALL||'),
      ...lines,
      'DSC||',
    ]),
  ];
}

/**
 * Instrument side: read an order download from the host (ASTM order message, OML^O33,
 * DSR^Q03, or a "not found" RSP^K11 / QCK^Q02). Returns the work the host asked for.
 */
export function parseHostOrders(model: InstrumentModel, raw: string): HostOrder[] {
  if (model === 'cobas_e411' || model === 'sysmex_xn') {
    const msg = parseAstm(raw);
    const d = msg.delimiters;
    const first = (...values: string[]) => values.map((v) => v.trim()).find(Boolean) ?? '';
    return msg.records
      .filter((r) => r.type === 'O')
      .map((r) => {
        const sampleId =
          model === 'sysmex_xn' ? first(astmGet(r, 3, d, 3), astmGet(r, 4, d, 3), astmGet(r, 3, d, 1)) : first(astmGet(r, 3, d, 1), astmGet(r, 4, d, 1));
        const tests = astmRepeats(r, 5, d)
          .map((c) => (model === 'sysmex_xn' ? c[4] ?? '' : (c[3] ?? '').split('/')[0] ?? ''))
          .filter(Boolean);
        const p = astmGet(r, 6, d);
        return { sampleId, found: astmGet(r, 26, d) !== 'Y' && tests.length > 0, tests, priority: p === 'S' ? 'stat' : p === 'A' ? 'urgent' : 'routine' };
      });
  }
  if (model === 'cobas_pure' || model === 'mindray_bs430') {
    const msg = parseHl7(raw);
    const d = msg.delimiters;
    if (msg.type === 'OML') {
      const spm = msg.segments.find((s) => s.name === 'SPM');
      const tests = msg.segments.filter((s) => s.name === 'OBR').map((s) => hl7Get(s, 4, d, 1)).filter(Boolean);
      const stat = msg.segments.some((s) => s.name === 'TQ1' && hl7Get(s, 9, d) === 'S');
      return [{ sampleId: spm ? hl7Get(spm, 2, d, 1, 1, 1) : '', found: tests.length > 0, tests, priority: stat ? 'stat' : 'routine' }];
    }
    if (msg.type === 'DSR') {
      const dsp = new Map(msg.segments.filter((s) => s.name === 'DSP').map((s) => [Number(hl7Get(s, 1, d)), s] as const));
      const line = (n: number) => {
        const s = dsp.get(n);
        return s ? hl7Get(s, 3, d) : '';
      };
      const tests: string[] = [];
      for (let n = 29; dsp.has(n); n++) {
        const s = dsp.get(n)!;
        const code = hl7Get(s, 3, d, 1);
        if (code) tests.push(code);
      }
      return [{ sampleId: line(21), found: tests.length > 0, tests, priority: line(24) === 'Y' ? 'stat' : 'routine' }];
    }
    if (msg.type === 'RSP' || msg.type === 'QCK') {
      const qak = msg.segments.find((s) => s.name === 'QAK');
      const qpd = msg.segments.find((s) => s.name === 'QPD');
      const status = qak ? hl7Get(qak, 2, d) : '';
      if (status === 'NF') return [{ sampleId: qpd ? hl7Get(qpd, 3, d) : '', found: false, tests: [] }];
      return [];
    }
    return [];
  }
  return [];
}

/** Codes a lab would never have mapped, per model (fault injection: unknown_code). */
export function unmappedCodeFor(model: InstrumentModel, rnd: () => number = Math.random): string {
  const options: Record<InstrumentModel, string[]> = {
    sysmex_xn: ['RET%', 'IRF', 'IG%'],
    cobas_e411: ['9901', '9902'],
    cobas_pure: ['LIP', 'AMMO'],
    mindray_bs430: ['LIP', 'NH3'],
    medica_easystat: ['Lac', 'Glu'],
    ichroma3: ['NTPRO', 'CKMB'],
  };
  return pick(rnd, options[model]);
}


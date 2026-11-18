/**
 * One canonical shape for every analyzer dialect, so the server's ingest pipeline does not
 * care whether a result came as an ASTM R record, an HL7 OBX segment, a printout line or
 * the invented ichroma demo format.
 *
 * Dialects (see docs/analyzers.md for the confidence of each):
 *  - Sysmex XN (ASTM, likely): test ID "^^^^WBC^1" (parameter in component 5, dilution in
 *    component 6); specimen in O.4 "^^<sample no>^B".
 *  - Roche cobas e 411 (ASTM, verified): test ID "^^^ACN^dilution"; specimen in O.3; QC
 *    results carry action code Q in O.12; host query = Q record.
 *  - Roche cobas pure (HL7 v2.5 IHE LAW, verified): OUL^R22 results with SPM (specimen,
 *    SPM-11 role Q = control), OBR/OBX (OBX-3 code, OBX-5 value, OBX-6 unit, OBX-8 flags);
 *    QBP^Q11 query by container ID (QPD-3).
 *  - Mindray BS-430 (HL7 v2.3.1, likely): ORU^R01 with the sample barcode in OBR-2, test
 *    number in OBX-3 and test name in OBX-4, MSH-16 = 2 for QC; QRY^Q02 query (QRD-8).
 *  - Medica EasyStat (printout text, layout assumed): see medica.ts.
 *  - Boditech ichroma III: INVENTED demo format, see ichroma.ts.
 */
import { PROFILES, type InstrumentModel, type ProtocolFamily } from './profiles';
import { astmGet, astmRecordView, astmRepeats, parseAstm, type AstmDelimiters, type AstmRecord } from './astm';
import { hl7Components, hl7Get, hl7Label, hl7RepeatCount, hl7SegmentView, parseHl7, type Hl7Message, type Hl7Segment } from './hl7';
import { parseMedicaPrintout } from './medica';
import { ICHROMA_DEMO_NOTICE, parseIchromaDemo } from './ichroma';
import { parseCompactTimestamp } from './time';

export type NormalizedResult = {
  /** Code the instrument used for the test (what instrument_mappings is keyed on). */
  code: string;
  name: string | null;
  /** Value exactly as sent ("5.4", "<0.01", "Positive"). */
  value: string;
  unit: string | null;
  /** Abnormal flags as sent (H, L, N, A, HH, LL ...). */
  flags: string | null;
  referenceRange: string | null;
  /** Local 'YYYY-MM-DDTHH:MM:SS' (or with an offset) when the message said when. */
  measuredAt: string | null;
  /** Result status as sent (F final, P preliminary, C correction, X cannot be done ...). */
  status: string | null;
  dilution: number | null;
  isQc: boolean;
};

export type NormalizedSpecimen = {
  /** Tube barcode / sample ID / control ID as sent. */
  sampleId: string;
  isQc: boolean;
  results: NormalizedResult[];
  /** Histograms, scattergrams and other graph references (not results). */
  graphs: Array<{ code: string; ref: string }>;
  comments: string[];
};

export type NormalizedQuery = { sampleIds: string[]; all: boolean };

export type RecordView = { type: string; fields: Array<{ ref: string; value: string }> };

export type InstrumentMessage = {
  model: InstrumentModel | 'other';
  protocol: ProtocolFamily;
  kind: 'results' | 'query' | 'qc' | 'other';
  /** e.g. "OUL^R22", "ASTM RSUPL^REAL", "MEDICA PRINTOUT". */
  messageType: string;
  controlId: string | null;
  sender: string | null;
  sentAt: string | null;
  specimens: NormalizedSpecimen[];
  queries: NormalizedQuery[];
  warnings: string[];
  /** Every record/segment with its non-empty fields, for display. */
  records: RecordView[];
};

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export type NormalizeModel = InstrumentModel | 'other';

/** Parse a raw message from `model` into the canonical shape. Throws ProtocolError when it cannot be parsed. */
export function normalize(model: NormalizeModel, raw: string, protocol?: ProtocolFamily): InstrumentMessage {
  const family = protocol ?? (model === 'other' ? undefined : PROFILES[model].protocol);
  if (!family) throw new ProtocolError('the protocol of this instrument is not set');
  if (!raw.trim()) throw new ProtocolError('empty message');
  switch (family) {
    case 'astm':
      return normalizeAstm(model, raw);
    case 'hl7':
      return normalizeHl7(model, raw);
    case 'medica_text':
      return normalizeMedica(model, raw);
    case 'ichroma_invented':
      return normalizeIchroma(model, raw);
  }
}

function kindOf(specimens: NormalizedSpecimen[], queries: NormalizedQuery[]): InstrumentMessage['kind'] {
  if (queries.length) return 'query';
  const withResults = specimens.filter((s) => s.results.length);
  if (!withResults.length) return 'other';
  return withResults.every((s) => s.isQc) ? 'qc' : 'results';
}

function num(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ------------------------------------------------------------------ ASTM */

type AstmDialect = {
  test(components: string[]): { code: string; name: string | null; dilution: number | null };
  orderSpecimen(rec: AstmRecord, d: AstmDelimiters): string;
  querySpecimens(rec: AstmRecord, d: AstmDelimiters): string[];
};

const firstNonEmpty = (...values: Array<string | undefined>) => values.map((v) => (v ?? '').trim()).find((v) => v !== '') ?? '';

const ASTM_DIALECTS: Record<'sysmex_xn' | 'cobas_e411' | 'generic', AstmDialect> = {
  sysmex_xn: {
    test: (c) => ({ code: firstNonEmpty(c[4], c[3], c[0]), name: null, dilution: num(c[5]) }),
    orderSpecimen: (r, d) => firstNonEmpty(astmGet(r, 4, d, 3), astmGet(r, 3, d, 3), astmGet(r, 3, d, 1), astmGet(r, 4, d, 1)),
    querySpecimens: (r, d) => astmRepeats(r, 3, d).map((c) => firstNonEmpty(c[2], c[1], c[0])).filter(Boolean),
  },
  cobas_e411: {
    test: (c) => {
      // "^^^ACN^dilution"; some documents show "ACN/dilution" in one component.
      const [acn, dil] = (c[3] ?? '').split('/');
      return { code: firstNonEmpty(acn, c[0]), name: null, dilution: num(c[4]) ?? num(dil) };
    },
    orderSpecimen: (r, d) => firstNonEmpty(astmGet(r, 3, d, 1), astmGet(r, 4, d, 1)),
    querySpecimens: (r, d) => astmRepeats(r, 3, d).map((c) => firstNonEmpty(c[1], c[2], c[0])).filter(Boolean),
  },
  generic: {
    test: (c) => ({ code: firstNonEmpty(c[3], c[0], c[4]), name: (c[1] ?? '').trim() || null, dilution: null }),
    orderSpecimen: (r, d) => firstNonEmpty(astmGet(r, 3, d, 1), astmGet(r, 3, d, 3), astmGet(r, 4, d, 1)),
    querySpecimens: (r, d) => astmRepeats(r, 3, d).map((c) => firstNonEmpty(c[1], c[0], c[2])).filter(Boolean),
  },
};

/** Sysmex sends graph references (histograms, scattergrams) as R records; they are not results. */
function isGraph(code: string, value: string): boolean {
  return /(scattergram|histogram|distribution|_dist|_scat|_hist)/i.test(code) || /^(png|bmp|jpe?g)[\\/]/i.test(value.trim());
}

function astmDialect(model: NormalizeModel): AstmDialect {
  return model === 'sysmex_xn' ? ASTM_DIALECTS.sysmex_xn : model === 'cobas_e411' ? ASTM_DIALECTS.cobas_e411 : ASTM_DIALECTS.generic;
}

function normalizeAstm(model: NormalizeModel, raw: string): InstrumentMessage {
  let msg;
  try {
    msg = parseAstm(raw);
  } catch (err) {
    throw new ProtocolError(`ASTM: ${err instanceof Error ? err.message : String(err)}`);
  }
  const d = msg.delimiters;
  const dialect = astmDialect(model);
  const warnings: string[] = [];
  const header = msg.records.find((r) => r.type === 'H');
  if (!header) warnings.push('no header (H) record');
  if (!msg.records.some((r) => r.type === 'L')) warnings.push('no terminator (L) record');
  const sentAt = header ? parseCompactTimestamp(astmGet(header, 14, d)) : null;
  const special = header ? (astmRepeats(header, 11, d)[0] ?? []).filter(Boolean).join('^') : '';

  const specimens: NormalizedSpecimen[] = [];
  const queries: NormalizedQuery[] = [];
  let current: NormalizedSpecimen | null = null;

  for (const r of msg.records) {
    if (r.type === 'O') {
      const sampleId = dialect.orderSpecimen(r, d);
      if (!sampleId) warnings.push('order record without a specimen ID');
      current = { sampleId, isQc: astmGet(r, 12, d).trim().toUpperCase() === 'Q', results: [], graphs: [], comments: [] };
      specimens.push(current);
    } else if (r.type === 'R') {
      if (!current) {
        warnings.push('result record before any order record');
        current = { sampleId: '', isQc: false, results: [], graphs: [], comments: [] };
        specimens.push(current);
      }
      const test = dialect.test(astmRepeats(r, 3, d)[0] ?? []);
      const value = (astmRepeats(r, 4, d)[0] ?? []).join(d.component).trim();
      if (!test.code) {
        warnings.push(`result record ${astmGet(r, 2, d)} without a test code`);
        continue;
      }
      if (isGraph(test.code, value)) {
        current.graphs.push({ code: test.code, ref: value });
        continue;
      }
      const range = (astmRepeats(r, 6, d)[0] ?? []).filter(Boolean);
      current.results.push({
        code: test.code,
        name: test.name,
        value,
        unit: astmGet(r, 5, d).trim() || null,
        flags: astmRepeats(r, 7, d).map((c) => c.join('')).filter(Boolean).join(' ') || null,
        referenceRange: range.length ? range.join(' - ') : null,
        status: astmGet(r, 9, d).trim() || null,
        measuredAt: parseCompactTimestamp(astmGet(r, 13, d)) ?? parseCompactTimestamp(astmGet(r, 12, d)) ?? sentAt,
        dilution: test.dilution,
        isQc: current.isQc,
      });
    } else if (r.type === 'C') {
      const text = astmRepeats(r, 4, d)
        .map((c) => c.filter(Boolean).join(' '))
        .filter(Boolean)
        .join('; ');
      if (text) (current ? current.comments : warnings).push(`comment: ${text}`);
    } else if (r.type === 'Q') {
      const ids = dialect.querySpecimens(r, d);
      const all = ids.some((x) => x.toUpperCase() === 'ALL');
      queries.push({ sampleIds: ids.filter((x) => x.toUpperCase() !== 'ALL'), all: all || !ids.length });
    } else if (!['H', 'P', 'L', 'M', 'S'].includes(r.type)) {
      warnings.push(`unknown record type ${r.type}`);
    }
  }

  let messageType = special ? `ASTM ${special}` : '';
  if (!messageType) {
    if (queries.length) messageType = 'ASTM query (Q)';
    else if (specimens.some((s) => s.results.length)) messageType = 'ASTM results (R)';
    else if (specimens.length) messageType = 'ASTM orders (O)';
    else messageType = 'ASTM';
  }
  return {
    model,
    protocol: 'astm',
    kind: kindOf(specimens, queries),
    messageType,
    controlId: header ? astmGet(header, 3, d) || null : null,
    sender: header ? (astmRepeats(header, 5, d)[0] ?? []).filter(Boolean).join('^') || null : null,
    sentAt,
    specimens,
    queries,
    warnings,
    records: astmRecordView(msg),
  };
}

/* ------------------------------------------------------------------ HL7 */

function obxValue(seg: Hl7Segment, msg: Hl7Message): string {
  const d = msg.delimiters;
  const type = hl7Get(seg, 2, d).toUpperCase();
  const comps = hl7Components(seg, 5, d);
  if (type === 'SN') return `${comps[0] ?? ''}${comps[1] ?? ''}${comps[2] ? `${comps[2]}${comps[3] ?? ''}` : ''}`.trim();
  if (type === 'CE' || type === 'CWE') return (comps[1] || comps[0] || '').trim();
  const reps = hl7RepeatCount(seg, 5, d);
  if (reps > 1) return Array.from({ length: reps }, (_, i) => hl7Components(seg, 5, d, i + 1).join(d.component)).join(' ').trim();
  return comps.join(d.component).trim();
}

function obxFlags(seg: Hl7Segment, msg: Hl7Message): string | null {
  const d = msg.delimiters;
  const n = hl7RepeatCount(seg, 8, d);
  const flags = Array.from({ length: n }, (_, i) => hl7Get(seg, 8, d, 1, i + 1)).filter(Boolean);
  return flags.length ? flags.join(' ') : null;
}

function hl7Base(model: NormalizeModel, msg: Hl7Message, warnings: string[]) {
  return {
    model,
    protocol: 'hl7' as const,
    messageType: hl7Label(msg) || 'HL7',
    controlId: msg.controlId || null,
    sender: [msg.sendingApp, msg.sendingFacility].filter(Boolean).join('^') || null,
    sentAt: parseCompactTimestamp(msg.timestamp),
    warnings,
    records: hl7SegmentView(msg),
  };
}

function normalizeHl7(model: NormalizeModel, raw: string): InstrumentMessage {
  let msg: Hl7Message;
  try {
    msg = parseHl7(raw);
  } catch (err) {
    throw new ProtocolError(`HL7: ${err instanceof Error ? err.message : String(err)}`);
  }
  const d = msg.delimiters;
  const warnings: string[] = [];
  const base = hl7Base(model, msg, warnings);
  const specimens: NormalizedSpecimen[] = [];
  const queries: NormalizedQuery[] = [];
  const label = `${msg.type}^${msg.trigger}`;
  const sentAt = base.sentAt;

  if (label === 'OUL^R22' || label === 'OUL^R21' || label === 'OUL^R24') {
    // IHE LAW / LAB: SPM opens a specimen, OBR opens an order step, OBX after OBR are results.
    let spec: NormalizedSpecimen | null = null;
    let inOrder = false;
    let last: NormalizedResult | null = null;
    for (const s of msg.segments) {
      if (s.name === 'SPM') {
        const id = hl7Get(s, 2, d, 1, 1, 1) || hl7Get(s, 2, d, 2, 1, 1);
        spec = { sampleId: id.trim(), isQc: hl7Get(s, 11, d).toUpperCase() === 'Q', results: [], graphs: [], comments: [] };
        specimens.push(spec);
        inOrder = false;
        last = null;
      } else if (s.name === 'SAC') {
        if (spec && !spec.sampleId) spec.sampleId = hl7Get(s, 3, d).trim();
      } else if (s.name === 'OBR') {
        inOrder = true;
        last = null;
      } else if (s.name === 'OBX') {
        if (!spec) {
          warnings.push('OBX before any SPM segment');
          spec = { sampleId: '', isQc: false, results: [], graphs: [], comments: [] };
          specimens.push(spec);
        }
        if (!inOrder) {
          spec.comments.push(`specimen observation ${hl7Get(s, 3, d)} = ${obxValue(s, msg)}`);
          continue;
        }
        const code = hl7Get(s, 3, d, 1).trim();
        if (!code) {
          warnings.push('OBX without an observation identifier');
          continue;
        }
        last = {
          code,
          name: hl7Get(s, 3, d, 2) || null,
          value: obxValue(s, msg),
          unit: hl7Get(s, 6, d, 1).trim() || null,
          flags: obxFlags(s, msg),
          referenceRange: hl7Get(s, 7, d) || null,
          status: hl7Get(s, 11, d) || null,
          measuredAt: parseCompactTimestamp(hl7Get(s, 19, d)) ?? parseCompactTimestamp(hl7Get(s, 14, d)) ?? sentAt,
          dilution: null,
          isQc: spec.isQc,
        };
        spec.results.push(last);
      } else if (s.name === 'TCD' && last) {
        // TCD-2 auto-dilution factor (SN), e.g. "^1^:^5" → 5.
        const c = hl7Components(s, 2, d);
        last.dilution = num(c[3]) ?? num(c[1]);
      } else if (s.name === 'NTE' && spec) {
        const text = hl7Get(s, 3, d);
        if (text) spec.comments.push(text);
      }
    }
  } else if (label === 'ORU^R01') {
    const mindray = model === 'mindray_bs430';
    // Mindray: MSH-16 carries the result type (0 sample, 1 calibration, 2 QC) per secondary sources.
    const isQc = mindray && hl7Get(msg.segments[0]!, 16, d) === '2';
    let spec: NormalizedSpecimen | null = null;
    for (const s of msg.segments) {
      if (s.name === 'OBR') {
        const id = mindray ? firstNonEmpty(hl7Get(s, 2, d), hl7Get(s, 3, d)) : firstNonEmpty(hl7Get(s, 3, d), hl7Get(s, 2, d));
        spec = { sampleId: id, isQc, results: [], graphs: [], comments: [] };
        specimens.push(spec);
      } else if (s.name === 'OBX') {
        if (!spec) {
          warnings.push('OBX before any OBR segment');
          spec = { sampleId: '', isQc, results: [], graphs: [], comments: [] };
          specimens.push(spec);
        }
        const name = mindray ? hl7Get(s, 4, d).trim() : hl7Get(s, 3, d, 2).trim();
        const code = mindray ? firstNonEmpty(name, hl7Get(s, 3, d, 1)) : hl7Get(s, 3, d, 1).trim();
        if (!code) {
          warnings.push('OBX without a test code');
          continue;
        }
        spec.results.push({
          code,
          name: name || null,
          value: obxValue(s, msg),
          unit: hl7Get(s, 6, d, 1).trim() || null,
          flags: obxFlags(s, msg),
          referenceRange: hl7Get(s, 7, d) || null,
          status: hl7Get(s, 11, d) || null,
          measuredAt: parseCompactTimestamp(hl7Get(s, 14, d)) ?? sentAt,
          dilution: null,
          isQc,
        });
      } else if (s.name === 'NTE' && spec) {
        const text = hl7Get(s, 3, d);
        if (text) spec.comments.push(text);
      }
    }
  } else if (label === 'QBP^Q11') {
    const qpd = msg.segments.find((s) => s.name === 'QPD');
    const ids = qpd ? [hl7Get(qpd, 3, d, 1)].filter(Boolean) : [];
    if (!ids.length) warnings.push('query without a container/specimen ID in QPD-3');
    queries.push({ sampleIds: ids, all: false });
  } else if (label === 'QRY^Q02') {
    const qrd = msg.segments.find((s) => s.name === 'QRD');
    const ids = qrd ? Array.from({ length: hl7RepeatCount(qrd, 8, d) }, (_, i) => hl7Get(qrd, 8, d, 1, i + 1)).filter(Boolean) : [];
    if (!ids.length) warnings.push('query without a sample barcode in QRD-8');
    queries.push({ sampleIds: ids, all: false });
  }
  return { ...base, kind: kindOf(specimens, queries), specimens, queries };
}

/* ------------------------------------------------------------------ text formats */

function lineRecords(raw: string, type: string): RecordView[] {
  return raw
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim())
    .map((l, i) => ({ type, fields: [{ ref: `line ${i + 1}`, value: l.trimEnd() }] }));
}

function normalizeMedica(model: NormalizeModel, raw: string): InstrumentMessage {
  const parsed = parseMedicaPrintout(raw);
  const specimens: NormalizedSpecimen[] = parsed.blocks.map((b) => ({
    sampleId: b.sampleId ?? '',
    isQc: false,
    results: b.results.map((r) => ({
      code: r.code,
      name: null,
      value: r.value,
      unit: r.unit,
      flags: r.flag,
      referenceRange: null,
      measuredAt: b.measuredAt,
      status: 'F',
      dilution: null,
      isQc: false,
    })),
    graphs: [],
    comments: Object.entries(b.meta).map(([k, v]) => `${k} ${v}`),
  }));
  if (!specimens.some((s) => s.results.length)) throw new ProtocolError(`Medica printout: ${parsed.warnings[0] ?? 'no results found'}`);
  return {
    model,
    protocol: 'medica_text',
    kind: kindOf(specimens, []),
    messageType: 'MEDICA PRINTOUT',
    controlId: null,
    sender: 'Medica EasyStat',
    sentAt: parsed.blocks[0]?.measuredAt ?? null,
    specimens,
    queries: [],
    warnings: ['printout layout is an assumption to confirm against Medica documentation', ...parsed.warnings],
    records: lineRecords(raw, 'LINE'),
  };
}

function normalizeIchroma(model: NormalizeModel, raw: string): InstrumentMessage {
  const parsed = parseIchromaDemo(raw);
  if (!parsed.lines.length) throw new ProtocolError(`ichroma demo format: ${parsed.warnings[0] ?? 'no result lines'}`);
  const bySample = new Map<string, NormalizedSpecimen>();
  for (const l of parsed.lines) {
    let spec = bySample.get(l.sampleId);
    if (!spec) {
      spec = { sampleId: l.sampleId, isQc: false, results: [], graphs: [], comments: [] };
      bySample.set(l.sampleId, spec);
    }
    spec.results.push({
      code: l.test,
      name: null,
      value: l.value,
      unit: l.unit || null,
      flags: null,
      referenceRange: null,
      measuredAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(l.time) ? l.time : null,
      status: 'F',
      dilution: null,
      isQc: false,
    });
  }
  const specimens = [...bySample.values()];
  return {
    model,
    protocol: 'ichroma_invented',
    kind: kindOf(specimens, []),
    messageType: 'ICHROMA-DEMO (invented format)',
    controlId: null,
    sender: 'ichroma III (simulated)',
    sentAt: specimens[0]?.results[0]?.measuredAt ?? null,
    specimens,
    queries: [],
    warnings: [ICHROMA_DEMO_NOTICE, ...parsed.warnings],
    records: raw
      .split(/\r\n|\r|\n/)
      .filter((l) => l.trim())
      .map((l) => {
        const parts = l.split('|');
        return { type: parts[0] ?? '', fields: parts.slice(1).map((value, i) => ({ ref: ['sample', 'test', 'value', 'unit', 'time'][i] ?? `f${i + 1}`, value })) };
      }),
  };
}

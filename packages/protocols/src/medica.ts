/**
 * Medica EasyStat / EasyBloodGas printout capture.
 *
 * Verified: these analyzers send their PRINTOUT as plain ASCII over RS-232 (2400 baud,
 * 8N1, Medica cable), results only ("not ASTM or LIS enabled"), with no framing and no
 * acknowledgement. Staff key the sample ID on the analyzer.
 *
 * ASSUMPTION (to confirm against Medica's manual and a real printout): the exact layout.
 * We expect a sample ID line, a date/time line and one line per analyte such as
 * "pH 7.412" or "pCO2 39.5 mmHg", optionally followed by an H/L flag. The parser is
 * deliberately tolerant (label spellings, date formats, spacing); the builder below is what
 * the simulator prints and is NOT a copy of a real Medica printout.
 */

export type MedicaResultLine = { code: string; value: string; unit: string | null; flag: string | null };

export type MedicaBlock = {
  sampleId: string | null;
  /** Local 'YYYY-MM-DDTHH:MM:SS' when a date and time were found. */
  measuredAt: string | null;
  sampleType: string | null;
  results: MedicaResultLine[];
  /** Instrument conditions printed with the result (temperature, barometric pressure). */
  meta: Record<string, string>;
  lines: string[];
};

export type MedicaParsed = { blocks: MedicaBlock[]; warnings: string[] };

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};
const MONTH_NAMES = Object.keys(MONTHS);

/** Lines that look like analytes but describe measuring conditions. */
const META_NAMES = new Set(['temp', 'temperature', 'baro', 'bp', 'fio2', 'hb']);
const FLAG_TOKENS = new Set(['H', 'L', 'HH', 'LL', '*', '↑', '↓']);

const SAMPLE_ID_RE = /^\s*(?:sample\s*(?:id|no\.?|#|number)|id\s*(?:#|no\.?)|specimen\s*id)\s*[:#=]?\s*(.+?)\s*$/i;
const PATIENT_ID_RE = /^\s*patient\s*(?:id|#|no\.?)\s*[:#=]?\s*(.+?)\s*$/i;
const SAMPLE_TYPE_RE = /^\s*sample(?:\s*type)?\s*[:=]\s*([A-Za-z][A-Za-z ]*?)\s*$/i;
const RESULT_RE = /^\s*([A-Za-z][A-Za-z0-9]*(?:\+\+|\+|-)?)\s+([<>]?\s*-?\d+(?:[.,]\d+)?)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/;
const HEADER_RE = /^\s*(?:medica\s+)?easy\s*(?:stat|blood\s*gas|lyte)\b/i;

function pad(n: string | number): string {
  return String(n).padStart(2, '0');
}

function fullYear(y: string): string {
  return y.length === 2 ? `20${y}` : y;
}

/** Find a date and a time anywhere on a line. */
function parseDateTime(line: string): { date: string | null; time: string | null } {
  let date: string | null = null;
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(line);
  if (m) date = `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`;
  if (!date) {
    m = new RegExp(`(\\d{1,2})[-/ ]+(${MONTH_NAMES.join('|')})[A-Z]*[-/ ]+(\\d{2,4})`, 'i').exec(line);
    if (m) date = `${fullYear(m[3]!)}-${MONTHS[m[2]!.toUpperCase().slice(0, 3)]}-${pad(m[1]!)}`;
  }
  if (!date) {
    // US style M/D/Y (Medica is a US manufacturer).
    m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(line);
    if (m) date = `${fullYear(m[3]!)}-${pad(m[1]!)}-${pad(m[2]!)}`;
  }
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(line);
  const time = t ? `${pad(t[1]!)}:${t[2]}:${t[3] ?? '00'}` : null;
  return { date, time };
}

function emptyBlock(): MedicaBlock {
  return { sampleId: null, measuredAt: null, sampleType: null, results: [], meta: {}, lines: [] };
}

/** Parse one or more printouts. Each printout becomes a block. */
export function parseMedicaPrintout(text: string): MedicaParsed {
  const warnings: string[] = [];
  const blocks: MedicaBlock[] = [];
  let block = emptyBlock();
  let patientId: string | null = null;
  let date: string | null = null;
  let time: string | null = null;

  const close = () => {
    if (!block.results.length && !block.sampleId) return;
    if (!block.sampleId && patientId) block.sampleId = patientId;
    if (date) block.measuredAt = `${date}T${time ?? '00:00:00'}`;
    blocks.push(block);
    block = emptyBlock();
    patientId = null;
    date = null;
    time = null;
  };

  for (const rawLine of text.split(/\r\n|\r|\n|\f/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (HEADER_RE.test(line) && (block.results.length || block.sampleId)) close();
    block.lines.push(line);
    if (/^[\s=*_-]+$/.test(line)) continue;

    const sid = SAMPLE_ID_RE.exec(line);
    if (sid) {
      if (block.results.length) close();
      block.sampleId = sid[1]!.trim();
      continue;
    }
    const pid = PATIENT_ID_RE.exec(line);
    if (pid) {
      patientId = pid[1]!.trim() || null;
      continue;
    }
    const st = SAMPLE_TYPE_RE.exec(line);
    if (st && !/\d/.test(line)) {
      block.sampleType = st[1]!.trim();
      continue;
    }
    const r = RESULT_RE.exec(line);
    if (r) {
      const code = r[1]!;
      let unit: string | null = r[3] ?? null;
      let flag: string | null = r[4] ?? null;
      if (unit && FLAG_TOKENS.has(unit.toUpperCase()) && !flag) {
        flag = unit;
        unit = null;
      }
      if (flag && !FLAG_TOKENS.has(flag.toUpperCase())) flag = null;
      const value = r[2]!.replace(/\s+/g, '').replace(',', '.');
      if (META_NAMES.has(code.toLowerCase())) block.meta[code] = `${value}${unit ? ` ${unit}` : ''}`;
      else block.results.push({ code, value, unit, flag: flag ? flag.toUpperCase().replace('↑', 'H').replace('↓', 'L') : null });
      continue;
    }
    const dt = parseDateTime(line);
    if (dt.date || dt.time) {
      date = dt.date ?? date;
      time = dt.time ?? time;
    }
  }
  close();
  if (!blocks.length) warnings.push('no sample ID or result lines found in the printout');
  for (const b of blocks) if (!b.sampleId) warnings.push('a printout has no sample ID (it must be keyed on the analyzer)');
  return { blocks, warnings };
}

export type MedicaPrintoutInput = {
  sampleId: string;
  /** Local date and time as printed: 'YYYY-MM-DDTHH:MM:SS'. */
  at: string;
  sampleType?: string;
  results: Array<{ code: string; value: string; unit?: string | null; flag?: 'H' | 'L' | null }>;
};

/**
 * Simulator output: a printout in the ASSUMED layout above (not a copy of a real Medica
 * printout). Lines end with CR LF.
 */
export function buildMedicaPrintout(p: MedicaPrintoutInput): string {
  const [date, time] = p.at.split('T') as [string, string];
  const [y, mo, d] = date.split('-');
  const month = MONTH_NAMES[Number(mo) - 1] ?? 'JAN';
  const rule = '-'.repeat(32);
  const lines = [
    'EasyStat (simulated printout)',
    rule,
    `Date: ${d}-${month}-${y}  Time: ${time.slice(0, 5)}`,
    `Sample ID: ${p.sampleId}`,
    `Sample Type: ${p.sampleType ?? 'Arterial'}`,
    rule,
    ...p.results.map((r) => `${r.code.padEnd(8)}${r.value.padStart(8)}${r.unit ? `  ${r.unit.padEnd(7)}` : '         '}${r.flag ? ` ${r.flag}` : ''}`.trimEnd()),
    rule,
    '',
  ];
  return lines.join('\r\n');
}

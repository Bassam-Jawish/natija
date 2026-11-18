import { describe, expect, it } from 'vitest';
import { buildMedicaPrintout, parseMedicaPrintout } from './medica';
import { buildIchromaDemo, parseIchromaDemo } from './ichroma';
import { createSession } from './session';

describe('Medica printout (layout assumed)', () => {
  it('reads sample ID, date/time and analyte lines with units and flags', () => {
    const text = [
      'EasyStat',
      'Date: 17-NOV-2026  Time: 10:15',
      'Sample ID: 261117-0042-01',
      'Sample Type: Arterial',
      'Temp 37.0 C',
      'pH 7.412',
      'pCO2 39.5 mmHg',
      'pO2   58.0  mmHg  L',
      'HCO3   24,8 mmol/L',
      'Na+ 139 mmol/L',
    ].join('\r\n');
    const { blocks, warnings } = parseMedicaPrintout(text);
    expect(warnings).toEqual([]);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.sampleId).toBe('261117-0042-01');
    expect(b.measuredAt).toBe('2026-11-17T10:15:00');
    expect(b.sampleType).toBe('Arterial');
    expect(b.meta).toEqual({ Temp: '37.0 C' });
    expect(b.results).toEqual([
      { code: 'pH', value: '7.412', unit: null, flag: null },
      { code: 'pCO2', value: '39.5', unit: 'mmHg', flag: null },
      { code: 'pO2', value: '58.0', unit: 'mmHg', flag: 'L' },
      { code: 'HCO3', value: '24.8', unit: 'mmol/L', flag: null },
      { code: 'Na+', value: '139', unit: 'mmol/L', flag: null },
    ]);
  });

  it('accepts US dates, other ID labels and several printouts in one burst', () => {
    const text = 'ID#: A17\n11/17/26 09:05\npH 7.30 L\n\nEasyStat\nPatient ID: P-9\n2026-11-17 09:07\npH 7.41\n';
    const { blocks } = parseMedicaPrintout(text);
    expect(blocks.map((b) => [b.sampleId, b.measuredAt, b.results.length])).toEqual([
      ['A17', '2026-11-17T09:05:00', 1],
      ['P-9', '2026-11-17T09:07:00', 1],
    ]);
    expect(blocks[0]!.results[0]!.flag).toBe('L');
  });

  it('warns when no sample ID was keyed', () => {
    const { blocks, warnings } = parseMedicaPrintout('pH 7.40\npCO2 40.0 mmHg\n');
    expect(blocks[0]!.sampleId).toBeNull();
    expect(warnings[0]).toMatch(/sample ID/);
  });

  it('round-trips the simulator layout', () => {
    const text = buildMedicaPrintout({
      sampleId: 'X-1',
      at: '2026-11-17T10:15:00',
      results: [
        { code: 'pH', value: '7.290', flag: 'L' },
        { code: 'pCO2', value: '55.4', unit: 'mmHg', flag: 'H' },
      ],
    });
    const b = parseMedicaPrintout(text).blocks[0]!;
    expect(b.sampleId).toBe('X-1');
    expect(b.measuredAt).toBe('2026-11-17T10:15:00');
    expect(b.results).toEqual([
      { code: 'pH', value: '7.290', unit: null, flag: 'L' },
      { code: 'pCO2', value: '55.4', unit: 'mmHg', flag: 'H' },
    ]);
  });
});

describe('ichroma III invented demo format', () => {
  it('round-trips lines and skips anything else', () => {
    const text = buildIchromaDemo([
      { sampleId: 'S1', test: 'PCT', value: '0.05', unit: 'ng/mL', time: '2026-11-17T10:00:00' },
      { sampleId: 'S1', test: 'CRP', value: '<0.5', unit: 'mg/L', time: '2026-11-17T10:00:00' },
    ]);
    expect(text.startsWith('ICHROMA-DEMO|S1|PCT|0.05|ng/mL|2026-11-17T10:00:00\r\n')).toBe(true);
    const parsed = parseIchromaDemo(`${text}garbage line\r\nICHROMA-DEMO|S2|PCT\r\n`);
    expect(parsed.lines.map((l) => [l.sampleId, l.test, l.value])).toEqual([
      ['S1', 'PCT', '0.05'],
      ['S1', 'CRP', '<0.5'],
    ]);
    expect(parsed.warnings).toHaveLength(2);
  });
});

describe('text session (no framing)', () => {
  it('ends a message on flush, and keeps text cut off by a dropped link as incomplete', async () => {
    const messages: string[] = [];
    const incomplete: string[] = [];
    const s = createSession('medica_text', {
      role: 'host',
      write: () => undefined,
      onMessage: (m) => {
        messages.push(m.text);
      },
      onIncomplete: (t) => {
        incomplete.push(t);
      },
      text: { idleMs: 60_000 },
    });
    s.receive('Sample ID: 1\r\npH 7.40\r\n');
    await s.flush();
    s.receive('Sample ID: 2\r\npH 7.');
    await s.close('socket closed');
    expect(messages).toEqual(['Sample ID: 1\r\npH 7.40\r\n']);
    expect(incomplete).toEqual(['Sample ID: 2\r\npH 7.']);
  });
});

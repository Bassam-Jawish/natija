import { describe, expect, it } from 'vitest';
import {
  ASTM_FRAME_TEXT_MAX,
  astmChecksum,
  astmEscape,
  astmGet,
  astmRecord,
  astmRepeats,
  astmUnescape,
  buildAstm,
  buildFrame,
  DEFAULT_ASTM_DELIMITERS,
  frameMessage,
  parseAstm,
  parseFrame,
  splitAstmMessages,
} from './astm';
import { corruptChecksum } from './astm-link';

describe('E1381 checksum', () => {
  it('sums FN..ETX modulo 256 as two uppercase hex digits', () => {
    // '1' 49 + 'A' 65 + 'B' 66 + 'C' 67 + CR 13 + ETX 3 = 263 → 263 % 256 = 7
    expect(astmChecksum('1ABC\r\x03')).toBe('07');
    // '7' 55 + 'L' 76 + '|' 124 + '1' 49 + '|' 124 + 'N' 78 + CR 13 + ETX 3 = 522 → 10
    expect(astmChecksum('7L|1|N\r\x03')).toBe('0A');
    expect(astmChecksum('2\x17')).toBe('49');
  });
});

describe('E1381 frames', () => {
  it('round-trips a frame', () => {
    const frame = buildFrame(1, 'H|\\^&|||host\r', true);
    expect(frame.startsWith('\x021H|')).toBe(true);
    expect(frame.endsWith('\r\n')).toBe(true);
    const parsed = parseFrame(frame);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame).toMatchObject({ fn: 1, text: 'H|\\^&|||host\r', final: true });
    }
  });

  it('numbers frames 1..7 then 0 across records', () => {
    const records = Array.from({ length: 10 }, (_, i) => `R|${i + 1}|^^^T${i}|${i}`);
    const frames = frameMessage(buildAstm(records));
    expect(frames.map((f) => f[1]).join('')).toBe('1234567012');
    expect(frames.every((f) => parseFrame(f).ok)).toBe(true);
  });

  it('splits long records into ETB frames of at most 240 characters including the frame number', () => {
    const long = `R|1|^^^NOTE|${'X'.repeat(600)}`;
    const frames = frameMessage(buildAstm([long, 'L|1|N']));
    expect(frames.length).toBe(4);
    const parsed = frames.map((f) => parseFrame(f));
    expect(parsed.every((p) => p.ok)).toBe(true);
    const ok = parsed.flatMap((p) => (p.ok ? [p.frame] : []));
    expect(ok.map((f) => f.final)).toEqual([false, false, true, true]);
    for (const f of ok) expect(1 + f.text.length).toBeLessThanOrEqual(240);
    expect(ok.slice(0, 3).map((f) => f.text).join('')).toBe(`${long}\r`);
    expect(ASTM_FRAME_TEXT_MAX).toBe(239);
  });

  it('reports checksum errors and malformed frames', () => {
    const good = buildFrame(3, 'L|1|N\r', true);
    const bad = corruptChecksum(good);
    expect(bad).not.toBe(good);
    const check = parseFrame(bad);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error).toMatch(/checksum/);
      expect(check.fn).toBe(3);
    }
    expect(parseFrame('1L|1|N\r\x0300\r\n').ok).toBe(false);
    expect(parseFrame('\x029L|1|N\r\x03AA\r\n').ok).toBe(false);
    expect(parseFrame('\x021L|1|N\r00\r\n').ok).toBe(false);
  });

  it('accepts lowercase checksums and a missing LF', () => {
    const frame = buildFrame(2, 'P|1\r', true);
    const lower = frame.replace(/([0-9A-F]{2})\r\n$/, (m, c: string) => `${c.toLowerCase()}\r`);
    expect(parseFrame(lower).ok).toBe(true);
  });
});

describe('E1394 records', () => {
  it('reads delimiters from the header and decodes fields, repeats, components and escapes', () => {
    const text = buildAstm([
      'H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1',
      'O|1|0815|1^50001^1^^S1^SC|^^^1010^1\\^^^1020^1|R',
      'R|1|^^^1010^1|3.21|uIU/mL|0.27^4.20|N||F||||20261117101500',
      'C|1|I|Note &F& with &S& escapes &R& and &E& &X41&|G',
      'L|1|N',
    ]);
    const msg = parseAstm(text);
    expect(msg.delimiters).toEqual(DEFAULT_ASTM_DELIMITERS);
    const [h, o, r, c] = msg.records;
    expect(astmGet(h!, 2, msg.delimiters)).toBe('\\^&');
    expect(astmGet(h!, 5, msg.delimiters, 1)).toBe('cobas-e411');
    expect(astmRepeats(o!, 5, msg.delimiters).map((x) => x[3])).toEqual(['1010', '1020']);
    expect(astmGet(r!, 4, msg.delimiters)).toBe('3.21');
    expect(astmGet(r!, 6, msg.delimiters, 2)).toBe('4.20');
    expect(astmGet(c!, 4, msg.delimiters)).toBe('Note | with ^ escapes \\ and & A');
  });

  it('supports non-default delimiters', () => {
    const msg = parseAstm('H;!@$\rR;1;@@@GLU;5.4\rL;1;N\r');
    expect(msg.delimiters).toEqual({ field: ';', repeat: '!', component: '@', escape: '$' });
    expect(astmGet(msg.records[1]!, 3, msg.delimiters, 4)).toBe('GLU');
  });

  it('escapes on build and decodes back', () => {
    const value = 'a|b^c\\d&e';
    expect(astmUnescape(astmEscape(value))).toBe(value);
    const rec = astmRecord('C', { 2: 1, 3: 'I', 4: value });
    const msg = parseAstm(buildAstm(['H|\\^&', rec]));
    expect(astmGet(msg.records[1]!, 4, msg.delimiters)).toBe(value);
  });

  it('builds headers with the delimiter definition and drops trailing empty fields', () => {
    expect(astmRecord('H', {})).toBe('H|\\^&');
    expect(astmRecord('H', { 5: ['host', '1'] })).toBe('H|\\^&|||host^1');
    expect(astmRecord('L', { 2: 1, 3: 'N', 9: '' })).toBe('L|1|N');
    expect(astmRecord('O', { 2: 1, 5: [['', '', '', 'A'], ['', '', '', 'B']] })).toBe('O|1|||^^^A\\^^^B');
  });

  it('rejects malformed text', () => {
    expect(() => parseAstm('')).toThrow();
    expect(() => parseAstm('H|\\^&\r1R|1\r')).toThrow(/record type/);
    expect(() => parseAstm('Hab12\r')).toThrow(/delimiter/);
  });

  it('splits a transmission into messages at each header', () => {
    const one = buildAstm(['H|\\^&', 'P|1', 'L|1|N']);
    const two = buildAstm(['H|\\^&', 'Q|1|^0815||ALL', 'L|1|N']);
    expect(splitAstmMessages(one + two)).toEqual([one, two]);
  });
});

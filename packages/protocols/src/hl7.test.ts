import { describe, expect, it } from 'vitest';
import {
  buildHl7,
  buildHl7Ack,
  hl7AckCode,
  hl7AckedControlId,
  hl7Components,
  hl7Escape,
  hl7Get,
  hl7Segment,
  hl7Unescape,
  mllpFrame,
  MllpDecoder,
  parseHl7,
} from './hl7';
import { createSession } from './session';

const OUL = buildHl7([
  'MSH|^~\\&|cobas pure|SIM|Natija|LIS|20261117101530||OUL^R22^OUL_R22|C0001|P|2.5|||NE|AL||UNICODE UTF-8|||LAB-29^IHE',
  'SPM|1|261117-0042-01||S1^Serum^99ROC|||||||P',
  'OBR|1|261117-0042-01-1||GLUC3^^99ROC',
  'OBX|1|NM|GLUC3^Glucose^99ROC|1|95|mg/dL^^UCUM|74-99|N~A|||F',
  'NTE|1||Line one\\.br\\line two \\F\\ \\S\\ \\T\\ \\R\\ \\E\\ \\X41\\',
]);

describe('MLLP', () => {
  it('frames with VT … FS CR', () => {
    const bytes = mllpFrame('MSH|^~\\&\r');
    expect(bytes[0]).toBe(0x0b);
    expect([...bytes.slice(-2)]).toEqual([0x1c, 0x0d]);
  });

  it('deframes messages split across chunks at any byte, including between FS and CR', () => {
    const wire = Buffer.concat([Buffer.from('noise'), Buffer.from(mllpFrame(OUL)), Buffer.from(mllpFrame('MSH|^~\\&|B\r'))]);
    for (const size of [1, 2, 3, 7, 64]) {
      const d = new MllpDecoder();
      const out: string[] = [];
      for (let i = 0; i < wire.length; i += size) out.push(...d.push(wire.subarray(i, i + size)));
      expect(out).toEqual([OUL, 'MSH|^~\\&|B\r']);
    }
  });

  it('keeps UTF-8 characters split across chunks intact', () => {
    const msg = 'MSH|^~\\&|App|مخبر\r';
    const wire = mllpFrame(msg, 'utf8');
    const d = new MllpDecoder({ encoding: 'utf8' });
    const out: string[] = [];
    for (const byte of wire) out.push(...d.push(Uint8Array.of(byte)));
    expect(out).toEqual([msg]);
  });

  it('reports a frame that never ended', () => {
    const d = new MllpDecoder();
    d.push('\x0bMSH|^~\\&|A\rPID|1');
    expect(d.pending()).toBe('MSH|^~\\&|A\rPID|1');
  });
});

describe('HL7 v2 parsing', () => {
  it('reads delimiters from MSH and decodes fields, components, repetitions and escapes', () => {
    const msg = parseHl7(OUL);
    expect(msg.type).toBe('OUL');
    expect(msg.trigger).toBe('R22');
    expect(msg.structure).toBe('OUL_R22');
    expect(msg.controlId).toBe('C0001');
    expect(msg.version).toBe('2.5');
    const obx = msg.segments.find((s) => s.name === 'OBX')!;
    expect(hl7Get(obx, 3, msg.delimiters, 1)).toBe('GLUC3');
    expect(hl7Get(obx, 3, msg.delimiters, 2)).toBe('Glucose');
    expect(hl7Get(obx, 8, msg.delimiters, 1, 2)).toBe('A');
    const nte = msg.segments.find((s) => s.name === 'NTE')!;
    expect(hl7Get(nte, 3, msg.delimiters)).toBe('Line one\nline two | ^ & ~ \\ A');
    const msh = msg.segments[0]!;
    expect(hl7Get(msh, 1, msg.delimiters)).toBe('|');
    expect(hl7Get(msh, 2, msg.delimiters)).toBe('^~\\&');
  });

  it('handles custom delimiters and subcomponents', () => {
    const msg = parseHl7('MSH#*!@%#A#B\rSPM#1#ID1%NS*FILLER\r');
    expect(msg.delimiters).toEqual({ field: '#', component: '*', repeat: '!', escape: '@', subcomponent: '%' });
    const spm = msg.segments[1]!;
    expect(hl7Get(spm, 2, msg.delimiters, 1, 1, 1)).toBe('ID1');
    expect(hl7Get(spm, 2, msg.delimiters, 1, 1, 2)).toBe('NS');
    expect(hl7Components(spm, 2, msg.delimiters)).toEqual(['ID1%NS', 'FILLER']);
  });

  it('rejects messages without MSH or with bad delimiters', () => {
    expect(() => parseHl7('PID|1\r')).toThrow(/MSH/);
    expect(() => parseHl7('MSH|^^\\&|A\r')).toThrow(/delimiters/);
  });

  it('escapes on build and decodes back', () => {
    const value = 'a|b^c~d\\e&f\nnext';
    expect(hl7Unescape(hl7Escape(value))).toBe(value);
    const seg = hl7Segment('NTE', { 1: 1, 3: value });
    const msg = parseHl7(buildHl7([hl7Segment('MSH', { 9: ['ORU', 'R01'], 10: 'X', 12: '2.3.1' }), seg]));
    expect(hl7Get(msg.segments[1]!, 3, msg.delimiters)).toBe(value);
  });

  it('builds repetitions and subcomponents', () => {
    expect(hl7Segment('QRD', { 8: { repeat: ['A', 'B'] } })).toBe('QRD||||||||A~B');
    expect(hl7Segment('SPM', { 2: [['ID', 'NS'], 'F'] })).toBe('SPM||ID&NS^F');
    expect(hl7Segment('MSH', { 9: ['ACK'] })).toBe('MSH|^~\\&|||||||ACK');
  });
});

describe('HL7 acknowledgements', () => {
  it('builds AA / AE / AR with swapped applications', () => {
    const original = parseHl7(OUL);
    const aa = parseHl7(buildHl7Ack(original, { code: 'AA', controlId: 'A1', now: new Date('2026-11-17T08:00:00Z') }));
    expect(aa.type).toBe('ACK');
    expect(aa.trigger).toBe('R22');
    expect(aa.sendingApp).toBe('Natija');
    expect(aa.receivingApp).toBe('cobas pure');
    expect(hl7AckCode(aa)).toBe('AA');
    expect(hl7AckedControlId(aa)).toBe('C0001');
    const ae = parseHl7(buildHl7Ack(original, { code: 'AE', text: 'disk full', controlId: 'A2' }));
    expect(hl7AckCode(ae)).toBe('AE');
    expect(ae.segments.some((s) => s.name === 'ERR')).toBe(true);
    const v231 = parseHl7('MSH|^~\\&|Mindray|BS-430|||20261117||ORU^R01|9|P|2.3.1\r');
    expect(parseHl7(buildHl7Ack(v231, { code: 'AA', controlId: 'A3' })).segments[0]!.fields[9]).toBe('ACK^R01');
  });

  it('a host session acknowledges after onMessage, and answers AR to unreadable messages', async () => {
    const written: string[] = [];
    const order: string[] = [];
    const session = createSession('hl7', {
      role: 'host',
      write: (b) => {
        written.push(Buffer.from(b).toString('utf8'));
        order.push('ack');
      },
      onMessage: () => {
        order.push('journal');
      },
    });
    session.receive(mllpFrame(OUL));
    session.receive(mllpFrame('MSH|garbage\r'));
    await session.settled();
    expect(order).toEqual(['journal', 'ack', 'journal', 'ack']);
    const acks = written.map((w) => parseHl7(w.slice(1, -2)));
    expect(hl7AckCode(acks[0]!)).toBe('AA');
    expect(hl7AckCode(acks[1]!)).toBe('AR');
    await session.close();
  });
});

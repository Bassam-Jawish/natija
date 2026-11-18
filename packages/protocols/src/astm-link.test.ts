import { describe, expect, it } from 'vitest';
import { AstmLink, corruptChecksum, type AstmLinkOptions } from './astm-link';
import { buildAstm, buildFrame } from './astm';
import type { Timers, WireTrace } from './bytes';

/** Timers driven by hand: advance(ms) runs everything due. */
class ManualTimers implements Timers {
  now = 0;
  private items: Array<{ id: number; at: number; fn: () => void }> = [];
  private next = 1;
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.items.push({ id, at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.items = this.items.filter((t) => t.id !== handle);
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      this.items.sort((a, b) => a.at - b.at);
      const due = this.items[0];
      if (!due || due.at > target) break;
      this.items.shift();
      this.now = due.at;
      due.fn();
      await flush();
    }
    this.now = target;
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

type Side = { link: AstmLink; received: string[]; incomplete: string[]; trace: WireTrace[] };

/** Two links joined by an in-memory wire; `tamper` can change bytes the host writes. */
function pair(opts: { instrument?: Partial<AstmLinkOptions>; host?: Partial<AstmLinkOptions>; timers?: Timers; tamperHost?: (b: Uint8Array) => Uint8Array | null } = {}) {
  const sides: { instrument?: Side; host?: Side } = {};
  const make = (role: 'instrument' | 'host', peer: () => Side | undefined, extra: Partial<AstmLinkOptions> = {}, tamper?: (b: Uint8Array) => Uint8Array | null): Side => {
    const side: Side = { link: null as unknown as AstmLink, received: [], incomplete: [], trace: [] };
    side.link = new AstmLink({
      role,
      timers: opts.timers,
      write: (bytes) => {
        const out = tamper ? tamper(bytes) : bytes;
        if (out) queueMicrotask(() => peer()?.link.receive(out));
      },
      onMessage: (m) => {
        side.received.push(m.text);
      },
      onIncomplete: (text) => {
        side.incomplete.push(text);
      },
      onTrace: (t) => side.trace.push(t),
      ...extra,
    });
    return side;
  };
  sides.instrument = make('instrument', () => sides.host, opts.instrument);
  sides.host = make('host', () => sides.instrument, opts.host, opts.tamperHost);
  return sides as { instrument: Side; host: Side };
}

const MESSAGE = buildAstm(['H|\\^&|||XN-550', 'P|1', 'O|1||^^261117-0042-01^B|^^^^WBC', 'R|1|^^^^WBC^1|7.81|10*3/uL||N', 'L|1|N']);

describe('ASTM link layer', () => {
  it('delivers a multi-frame message with ENQ/ACK, frames and EOT', async () => {
    const { instrument, host } = pair();
    const result = await instrument.link.send(MESSAGE);
    await flush();
    expect(result).toEqual({ ok: true, frames: 5 });
    expect(host.received).toEqual([MESSAGE]);
    const tx = instrument.trace.filter((t) => t.dir === 'tx').map((t) => t.text.slice(0, 7));
    expect(tx[0]).toBe('<ENQ>');
    expect(tx.at(-1)).toBe('<EOT>');
  });

  it('delivers records longer than one frame (ETB)', async () => {
    const long = buildAstm(['H|\\^&', `C|1|I|${'Z'.repeat(1000)}|G`, 'L|1|N']);
    const { instrument, host } = pair();
    expect((await instrument.link.send(long)).ok).toBe(true);
    await flush();
    expect(host.received).toEqual([long]);
  });

  it('NAKs a frame with a bad checksum and accepts the retransmission', async () => {
    const { instrument, host } = pair({
      instrument: { mutateFrame: (f, info) => (info.index === 1 && info.attempt === 0 ? corruptChecksum(f) : f) },
    });
    const result = await instrument.link.send(MESSAGE);
    await flush();
    expect(result.ok).toBe(true);
    expect(host.received).toEqual([MESSAGE]);
    expect(host.trace.filter((t) => t.text === '<NAK>')).toHaveLength(1);
    expect(host.trace.some((t) => t.kind === 'error' && /checksum/.test(t.text))).toBe(true);
  });

  it('gives up after 6 retransmissions and the host ingests nothing', async () => {
    const { instrument, host } = pair({ instrument: { mutateFrame: (f, info) => (info.index === 0 ? corruptChecksum(f) : f) } });
    const result = await instrument.link.send(MESSAGE);
    await flush();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('nak');
    expect(host.trace.filter((t) => t.text === '<NAK>')).toHaveLength(7);
    expect(host.received).toEqual([]);
  });

  it('stores a repeated frame once when the ACK was garbled (duplicate-safe)', async () => {
    let acks = 0;
    const { instrument, host } = pair({
      tamperHost: (b) => {
        if (b.length === 1 && b[0] === 0x06 && ++acks === 3) return Uint8Array.of(0x7f); // garble the ACK of frame 2
        return b;
      },
    });
    const result = await instrument.link.send(MESSAGE);
    await flush();
    expect(result.ok).toBe(true);
    expect(host.received).toEqual([MESSAGE]);
    expect(host.trace.some((t) => /repeated/.test(t.text))).toBe(true);
  });

  it('NAKs a frame number out of sequence', async () => {
    const host = pair().host;
    host.link.receive('\x05');
    host.link.receive(buildFrame(3, 'H|\\^&\r', true));
    await flush();
    expect(host.trace.filter((t) => t.dir === 'tx').map((t) => t.text)).toEqual(['<ACK>', '<NAK>']);
  });

  it('runs beforeAck before writing ACK, and NAKs when it throws', async () => {
    const writes: string[] = [];
    let failures = 1;
    const h = new AstmLink({
      role: 'host',
      write: (b) => writes.push(b[0] === 0x06 ? 'ACK' : b[0] === 0x15 ? 'NAK' : 'other'),
      beforeAck: (frame) => {
        writes.push(`store ${frame.fn}`);
        if (frame.fn === 2 && failures-- > 0) throw new Error('disk full');
      },
    });
    h.receive('\x05');
    h.receive(buildFrame(1, 'H|\\^&\r', true));
    h.receive(buildFrame(2, 'L|1|N\r', true));
    h.receive(buildFrame(2, 'L|1|N\r', true));
    await h.settled();
    expect(writes).toEqual(['ACK', 'store 1', 'ACK', 'store 2', 'NAK', 'store 2', 'ACK']);
  });

  it('reports an incomplete transmission after the 30 s receive timeout', async () => {
    const timers = new ManualTimers();
    const { host } = pair({ timers });
    host.link.receive('\x05');
    host.link.receive(buildFrame(1, 'H|\\^&\r', true));
    await flush();
    expect(host.incomplete).toEqual([]);
    await timers.advance(30_000);
    expect(host.incomplete).toEqual(['H|\\^&\r']);
    expect(host.link.linkState).toBe('idle');
  });

  it('aborts with EOT when the receiver never answers ENQ (15 s)', async () => {
    const timers = new ManualTimers();
    const writes: string[] = [];
    const link = new AstmLink({ role: 'instrument', timers, write: (b) => writes.push(b.length === 1 ? String(b[0]) : 'frame') });
    const p = link.send(MESSAGE);
    await flush();
    await timers.advance(15_000);
    expect(await p).toMatchObject({ ok: false, error: 'timeout' });
    expect(writes).toEqual(['5', '4']);
  });

  it('lets the instrument win line contention', async () => {
    const timers = new ManualTimers();
    const { instrument, host } = pair({ timers });
    const hostMessage = buildAstm(['H|\\^&|||host', 'P|1', 'O|1|0815||^^^1010^1', 'L|1|N']);
    const fromHost = host.link.send(hostMessage);
    const fromInstrument = instrument.link.send(MESSAGE);
    await flush();
    // Both sent ENQ; the host stepped back, the instrument waits 1 s and tries again.
    expect(host.trace.some((t) => /contention/.test(t.text))).toBe(true);
    await timers.advance(1_000);
    expect((await fromInstrument).ok).toBe(true);
    await flush();
    expect(host.received).toEqual([MESSAGE]);
    // After the instrument's EOT the host sends its own message.
    expect((await fromHost).ok).toBe(true);
    await flush();
    expect(instrument.received).toEqual([hostMessage]);
  });

  it('answers a host query reply after EOT', async () => {
    const reply = buildAstm(['H|\\^&|||host', 'P|1', 'O|1|0815||^^^1010^1|R', 'L|1|N']);
    const { instrument, host } = pair({ host: { onMessage: () => [reply] } });
    await instrument.link.send(buildAstm(['H|\\^&', 'Q|1|^0815||ALL', 'L|1|N']));
    await flush();
    await host.link.idle();
    await flush();
    expect(instrument.received).toEqual([reply]);
  });

  it('reports a half-received transmission when closed', async () => {
    const { host } = pair();
    host.link.receive('\x05');
    host.link.receive(buildFrame(1, 'H|\\^&\r', true));
    await flush();
    await host.link.close('socket closed');
    expect(host.incomplete).toEqual(['H|\\^&\r']);
  });
});

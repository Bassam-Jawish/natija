/**
 * Run a simulated analyzer and a host against each other in memory, through the real link
 * layers (ENQ/ACK frames with checksums, MLLP + HL7 acknowledgements, raw text). The server
 * uses this for "simulate" so demo traffic takes exactly the path agent traffic takes; the
 * tests use it for golden round trips.
 */
import type { TextEncoding, WireTrace } from './bytes';
import type { ProtocolFamily } from './profiles';
import { createSession, type ProtocolSession, type SendResult, type SessionMessage, type SessionOptions, type SessionReply } from './session';

export type ExchangeTraceLine = WireTrace & { side: 'instrument' | 'host' };

export type ExchangeOptions = {
  protocol: ProtocolFamily;
  /** Messages the analyzer sends, in order. */
  messages: string[];
  encoding?: TextEncoding;
  /** Host side: called for every complete message (store it, answer queries). */
  onHostMessage?: (msg: SessionMessage) => SessionReply | void | Promise<SessionReply | void>;
  /** Analyzer side: called for messages from the host (order downloads, acknowledgements). */
  onInstrumentMessage?: (msg: SessionMessage) => SessionReply | void | Promise<SessionReply | void>;
  /** Fault injection on the analyzer side. */
  instrument?: Pick<SessionOptions, 'astm' | 'hl7'>;
  /** Give up waiting after this long (default 20 s). */
  timeoutMs?: number;
  /** The lab's time zone: host acknowledgements carry local time, as the Lab Agent's do (default UTC). */
  timeZone?: string;
};

export type ExchangeResult = {
  trace: ExchangeTraceLine[];
  /** Complete messages as the host received them. */
  received: string[];
  /** Messages the host saw start but never finish. */
  incomplete: Array<{ text: string; reason: string }>;
  /** Outcome of each analyzer send (acknowledged, refused, timed out). */
  sendResults: SendResult[];
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(a: ProtocolSession, b: ProtocolSession): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await tick();
    await a.settled();
    await b.settled();
    await a.idle();
    await b.idle();
  }
}

export async function runExchange(opts: ExchangeOptions): Promise<ExchangeResult> {
  const trace: ExchangeTraceLine[] = [];
  const received: string[] = [];
  const incomplete: Array<{ text: string; reason: string }> = [];
  const sendResults: SendResult[] = [];
  const timeoutMs = opts.timeoutMs ?? 20_000;

  // Bytes cross over in microtasks, like a wire: no re-entrant calls between the two sides.
  const peers: { host?: ProtocolSession; instrument?: ProtocolSession } = {};
  const host = createSession(opts.protocol, {
    role: 'host',
    encoding: opts.encoding,
    write: (bytes) => queueMicrotask(() => peers.instrument?.receive(bytes)),
    onMessage: async (m) => {
      if (m.isResponse) return;
      received.push(m.text);
      return opts.onHostMessage?.(m);
    },
    onIncomplete: (text, reason) => {
      incomplete.push({ text, reason });
    },
    onTrace: (t) => trace.push({ ...t, side: 'host' }),
    text: { idleMs: 60_000 },
    hl7: opts.timeZone ? { timeZone: opts.timeZone } : undefined,
  });
  const instrument = createSession(opts.protocol, {
    role: 'instrument',
    encoding: opts.encoding,
    write: (bytes) => queueMicrotask(() => peers.host?.receive(bytes)),
    onMessage: opts.onInstrumentMessage,
    onTrace: (t) => trace.push({ ...t, side: 'instrument' }),
    ...opts.instrument,
  });
  peers.host = host;
  peers.instrument = instrument;

  try {
    await withTimeout(
      (async () => {
        for (const message of opts.messages) {
          sendResults.push(await instrument.send(message));
          await host.flush();
          await settle(host, instrument);
        }
      })(),
      timeoutMs,
      'simulated exchange',
    );
  } finally {
    await instrument.close('simulation finished');
    await host.close('simulation finished');
  }
  return { trace, received, incomplete, sendResults };
}

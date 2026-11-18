/**
 * The simulated analyzer's side of the wire: a TCP socket (as if through a serial device
 * server for RS-232 analyzers), a protocol session in the instrument role, fault injection
 * on the byte stream, and a printed trace of everything that crosses it.
 */
import net from 'node:net';
import { corruptChecksum, createSession, type ProtocolFamily, type ProtocolSession, type SessionMessage, type SessionOptions, type WireTrace } from '@natija/protocols';

export type Fault = 'none' | 'duplicate' | 'bad-checksum' | 'unknown-code' | 'unknown-sample' | 'drop-mid-message' | 'late-ack';

const started = Date.now();
function stamp(): string {
  return `+${((Date.now() - started) / 1000).toFixed(3).padStart(7)}s`;
}

export function say(text: string): void {
  console.log(`${stamp()}  ${text}`);
}

export function printTrace(t: WireTrace, quiet: boolean): void {
  if (t.dir === 'note') {
    if (!quiet || t.kind === 'error') console.log(`${stamp()}  ·  ${t.text}`);
    return;
  }
  if (quiet) return;
  const arrow = t.dir === 'tx' ? 'ANALYZER → AGENT' : 'AGENT → ANALYZER';
  const mark = t.ok === false ? '  [corrupted on purpose]' : '';
  console.log(`${stamp()}  ${arrow}  ${t.text}${mark}`);
}

export type Link = {
  session: ProtocolSession;
  /** Resolves with the next message the host sends (order download, query answer), or null on timeout. */
  nextMessage(timeoutMs: number): Promise<string | null>;
  close(): Promise<void>;
  /** Cut the connection now (fault injection). */
  drop(): void;
};

export async function openLink(opts: {
  protocol: ProtocolFamily;
  host: string;
  port: number;
  listen: boolean;
  fault: Fault;
  quiet: boolean;
  lateAckMs: number;
  dropAfterFrames: number;
}): Promise<Link> {
  const socket = await (opts.listen ? acceptOne(opts.host, opts.port) : connect(opts.host, opts.port));
  const inbox: string[] = [];
  const waiters: Array<(m: string | null) => void> = [];
  let framesWritten = 0;
  let dropped = false;

  const rawWrite = (bytes: Uint8Array) => {
    if (!socket.destroyed) socket.write(bytes);
  };
  const write = (bytes: Uint8Array) => {
    if (dropped) return;
    if (opts.fault === 'late-ack' && isAcknowledgement(bytes, opts.protocol)) {
      say(`late-ack: holding our acknowledgement for ${opts.lateAckMs / 1000} s (the agent's timeout is 15 s)`);
      setTimeout(() => rawWrite(bytes), opts.lateAckMs);
      return;
    }
    if (opts.fault === 'drop-mid-message') {
      if (opts.protocol === 'astm' && bytes[0] === 0x02 && ++framesWritten > opts.dropAfterFrames) {
        say(`drop-mid-message: the next frame is NOT sent; the connection is cut after ${opts.dropAfterFrames} frame(s), before EOT`);
        dropped = true;
        socket.destroy();
        return;
      }
      if (opts.protocol !== 'astm' && bytes.length > 20) {
        const half = Math.floor(bytes.length / 2);
        rawWrite(bytes.subarray(0, half));
        say(`drop-mid-message: sent ${half} of ${bytes.length} bytes, then cut the connection`);
        dropped = true;
        setTimeout(() => socket.destroy(), 200);
        return;
      }
    }
    rawWrite(bytes);
  };

  const sessionOpts: SessionOptions = {
    role: 'instrument',
    write,
    onTrace: (t) => printTrace(t, opts.quiet),
    onMessage: (m: SessionMessage) => {
      if (m.isResponse && opts.protocol === 'hl7' && !/^MSH[^\r]*\|(RSP|QCK)\^/m.test(m.text)) return;
      const waiter = waiters.shift();
      if (waiter) waiter(m.text);
      else inbox.push(m.text);
    },
    text: { idleMs: 60_000 },
  };
  if (opts.fault === 'bad-checksum' && opts.protocol === 'astm') {
    sessionOpts.astm = {
      mutateFrame: (frame, info) => (info.index === 1 && info.attempt === 0 ? corruptChecksum(frame) : frame),
    };
  }
  const session = createSession(opts.protocol, sessionOpts);
  socket.on('data', (chunk: Buffer) => session.receive(chunk));
  socket.on('close', () => {
    for (const w of waiters.splice(0)) w(null);
  });
  socket.on('error', (err) => say(`socket error: ${err.message}`));

  return {
    session,
    nextMessage(timeoutMs) {
      const queued = inbox.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(done);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        const done = (m: string | null) => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push(done);
      });
    },
    async close() {
      await session.close('simulation finished');
      await new Promise<void>((resolve) => {
        if (socket.destroyed) return resolve();
        const force = setTimeout(() => {
          socket.destroy();
          resolve();
        }, 1000);
        socket.end(() => {
          clearTimeout(force);
          socket.destroy();
          resolve();
        });
      });
    },
    drop() {
      dropped = true;
      socket.destroy();
    },
  };
}

/** Our own acknowledgements: an ASTM ACK byte, or an HL7 ACK/ORL message. */
function isAcknowledgement(bytes: Uint8Array, protocol: ProtocolFamily): boolean {
  if (protocol === 'astm') return bytes.length === 1 && bytes[0] === 0x06;
  if (protocol === 'hl7') return /\|(ACK|ORL)\^/.test(Buffer.from(bytes).toString('latin1').slice(0, 200));
  return false;
}

function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      say(`connected to the Lab Agent at ${host}:${port}`);
      resolve(socket);
    });
    socket.once('error', (err) => reject(new Error(`cannot connect to ${host}:${port} (${err.message}). Is the Lab Agent running with this instrument configured?`)));
  });
}

function acceptOne(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      say(`the Lab Agent connected from ${socket.remoteAddress}:${socket.remotePort}`);
      server.close();
      resolve(socket);
    });
    server.once('error', (err) => reject(err));
    server.listen(port, host, () => say(`listening on ${host}:${port}; waiting for the Lab Agent (tcp_client) to connect`));
  });
}


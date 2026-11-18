/**
 * Byte transports between the agent and one analyzer: a TCP server (the analyzer, or a
 * serial device server in TCP-client mode, connects to us), a TCP client (we connect to the
 * analyzer or to a serial device server in TCP-server mode), or a local serial port through
 * the optional `serialport` package. Protocol handling is not done here.
 */
import net from 'node:net';
import type { AgentLinkState } from '@natija/protocols';
import { logger } from './log';

export type TransportEvents = {
  onConnect: (peer: string) => void;
  onData: (chunk: Buffer) => void;
  onDisconnect: (reason: string) => void;
  onState: (state: AgentLinkState, detail: string | null) => void;
};

export interface Transport {
  readonly describe: string;
  start(): void;
  stop(): Promise<void>;
  write(bytes: Uint8Array): void;
}

function normalizeIp(ip: string | undefined): string {
  return (ip ?? '').replace(/^::ffff:/, '');
}

/* ------------------------------------------------------------------ TCP server */

export class TcpServerTransport implements Transport {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly log;

  constructor(
    private readonly opts: { code: string; host: string; port: number; allowFrom: string[] },
    private readonly ev: TransportEvents,
  ) {
    this.log = logger(opts.code);
  }

  get describe(): string {
    return `TCP server ${this.opts.host}:${this.opts.port}`;
  }

  start(): void {
    if (this.stopped) return;
    const server = net.createServer((socket) => this.accept(socket));
    server.on('error', (err: NodeJS.ErrnoException) => {
      const detail = err.code === 'EADDRINUSE' ? `port ${this.opts.port} is already in use` : err.message;
      this.ev.onState('error', `cannot listen on ${this.opts.host}:${this.opts.port}: ${detail}`);
      this.log.error(`cannot listen on ${this.opts.host}:${this.opts.port}: ${detail}; retrying in 10 s`);
      server.close();
      this.server = null;
      this.retry = setTimeout(() => this.start(), 10_000);
    });
    server.listen(this.opts.port, this.opts.host, () => {
      this.log.info(`listening on ${this.opts.host}:${this.opts.port} for the analyzer`);
      this.ev.onState('waiting', `listening on ${this.opts.host}:${this.opts.port}`);
    });
    this.server = server;
  }

  private accept(socket: net.Socket): void {
    const ip = normalizeIp(socket.remoteAddress);
    const peer = `${ip}:${socket.remotePort}`;
    if (this.opts.allowFrom.length && !this.opts.allowFrom.includes(ip)) {
      this.log.warn(`refused a connection from ${peer} (not in allowFrom)`);
      socket.destroy();
      return;
    }
    if (this.socket) {
      // Analyzers reconnect after a network glitch; the new connection wins.
      const old = this.socket;
      this.socket = null;
      old.destroy();
      this.log.warn(`new connection from ${peer} replaces the previous one`);
      this.ev.onDisconnect('replaced by a new connection');
    }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    this.log.info(`analyzer connected from ${peer}`);
    this.ev.onConnect(peer);
    this.ev.onState('connected', peer);
    socket.on('data', (chunk: Buffer) => this.ev.onData(chunk));
    socket.on('error', (err) => this.log.warn(`connection error: ${err.message}`));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.log.info(`analyzer ${peer} disconnected`);
      this.ev.onDisconnect('connection closed by the analyzer');
      if (!this.stopped) this.ev.onState('waiting', `listening on ${this.opts.host}:${this.opts.port}`);
    });
  }

  write(bytes: Uint8Array): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(bytes);
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/* ------------------------------------------------------------------ TCP client */

export class TcpClientTransport implements Transport {
  private socket: net.Socket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private delay = 1_000;
  private stopped = false;
  private readonly log;

  constructor(
    private readonly opts: { code: string; host: string; port: number },
    private readonly ev: TransportEvents,
  ) {
    this.log = logger(opts.code);
  }

  get describe(): string {
    return `TCP client → ${this.opts.host}:${this.opts.port}`;
  }

  start(): void {
    if (this.stopped) return;
    this.ev.onState('waiting', `connecting to ${this.opts.host}:${this.opts.port}`);
    const socket = net.connect({ host: this.opts.host, port: this.opts.port });
    this.socket = socket;
    let connected = false;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      connected = true;
      this.delay = 1_000;
      socket.setKeepAlive(true, 30_000);
      const peer = `${this.opts.host}:${this.opts.port}`;
      this.log.info(`connected to the analyzer at ${peer}`);
      this.ev.onConnect(peer);
      this.ev.onState('connected', peer);
    });
    socket.on('data', (chunk: Buffer) => this.ev.onData(chunk));
    socket.on('error', (err) => this.log.warn(`connection error: ${err.message}`));
    socket.on('close', (hadError) => {
      if (this.socket === socket) this.socket = null;
      if (connected) this.ev.onDisconnect(hadError ? 'connection error' : 'connection closed');
      if (this.stopped) return;
      this.ev.onState('waiting', `reconnecting to ${this.opts.host}:${this.opts.port} in ${Math.round(this.delay / 1000)} s`);
      this.retry = setTimeout(() => this.start(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    });
  }

  write(bytes: Uint8Array): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(bytes);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.destroy();
  }
}

/* ------------------------------------------------------------------ serial (optional dependency) */

type SerialPortLike = {
  isOpen: boolean;
  open(cb: (err: Error | null) => void): void;
  close(cb?: (err: Error | null) => void): void;
  write(data: Uint8Array): boolean;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
};
type SerialPortCtor = new (opts: { path: string; baudRate: number; dataBits: number; parity: string; stopBits: number; autoOpen: boolean }) => SerialPortLike;

let serialCtor: Promise<SerialPortCtor | null> | null = null;

/** `serialport` is an optional dependency with a native module: load it only when a serial analyzer is configured. */
function loadSerialPort(): Promise<SerialPortCtor | null> {
  serialCtor ??= (async () => {
    const name = 'serialport';
    try {
      const mod = (await import(name)) as { SerialPort?: SerialPortCtor };
      return mod.SerialPort ?? null;
    } catch {
      return null;
    }
  })();
  return serialCtor;
}

export class SerialTransport implements Transport {
  private port: SerialPortLike | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly log;

  constructor(
    private readonly opts: { code: string; path: string; baudRate: number; dataBits: 7 | 8; parity: 'none' | 'even' | 'odd'; stopBits: 1 | 2 },
    private readonly ev: TransportEvents,
  ) {
    this.log = logger(opts.code);
  }

  get describe(): string {
    const p = this.opts;
    return `serial ${p.path} ${p.baudRate} ${p.dataBits}${p.parity[0]!.toUpperCase()}${p.stopBits}`;
  }

  start(): void {
    void this.open();
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const Ctor = await loadSerialPort();
    if (!Ctor) {
      this.ev.onState('error', 'the optional "serialport" package is not installed');
      this.log.error('serial transport needs the optional "serialport" package (pnpm install in apps/agent)');
      return;
    }
    const p = this.opts;
    const port = new Ctor({ path: p.path, baudRate: p.baudRate, dataBits: p.dataBits, parity: p.parity, stopBits: p.stopBits, autoOpen: false });
    this.port = port;
    port.on('data', (chunk: Buffer) => this.ev.onData(chunk));
    port.on('error', (err: Error) => this.log.warn(`serial error: ${err.message}`));
    port.on('close', () => {
      if (this.port !== port) return;
      this.port = null;
      this.ev.onDisconnect('serial port closed');
      this.scheduleReopen('serial port closed');
    });
    port.open((err) => {
      if (err) {
        this.port = null;
        this.ev.onState('error', `cannot open ${p.path}: ${err.message}`);
        this.scheduleReopen(err.message);
        return;
      }
      this.log.info(`opened ${this.describe}`);
      this.ev.onConnect(p.path);
      // An open port does not prove the analyzer is on; RS-232 has no connection handshake.
      this.ev.onState('connected', `${this.describe} open`);
    });
  }

  private scheduleReopen(why: string): void {
    if (this.stopped) return;
    this.log.warn(`${this.opts.path}: ${why}; retrying in 10 s`);
    this.retry = setTimeout(() => void this.open(), 10_000);
  }

  write(bytes: Uint8Array): void {
    if (this.port?.isOpen) this.port.write(bytes);
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const port = this.port;
    this.port = null;
    return new Promise((resolve) => (port?.isOpen ? port.close(() => resolve()) : resolve()));
  }
}

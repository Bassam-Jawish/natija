/**
 * One analyzer: its transport, a protocol session per connection, the journal and the
 * host-query answers. The agent is the host (LIS) side of every link.
 */
import { randomUUID } from 'node:crypto';
import {
  buildHostReply,
  createSession,
  normalize,
  PROFILES,
  type AgentLinkState,
  type HostOrder,
  type InstrumentMessage,
  type ProtocolSession,
  type SessionMessage,
  type SessionReply,
  type WireTrace,
} from '@natija/protocols';
import { portOf, protocolOf, type InstrumentConfig } from './config';
import type { Journal } from './journal';
import { logger, type Logger } from './log';
import { SerialTransport, TcpClientTransport, TcpServerTransport, type Transport, type TransportEvents } from './transports';
import type { Uploader } from './uploader';
import type { WorklistCache } from './worklist';

export type RunnerStatus = {
  code: string;
  model: string;
  protocol: string;
  endpoint: string;
  state: AgentLinkState;
  detail: string | null;
  connectedSince: string | null;
  lastMessageAt: string | null;
  messages: number;
  queries: number;
  incomplete: number;
};

export type RunnerDeps = { journal: Journal; worklist: WorklistCache; uploader: Uploader; logTraffic: boolean; timeZone: string };

export class InstrumentRunner {
  readonly status: RunnerStatus;
  private readonly log: Logger;
  private readonly protocol;
  private transport: Transport | null = null;
  private session: ProtocolSession | null = null;
  private transmission: string | null = null;
  private part = 0;

  constructor(
    private readonly cfg: InstrumentConfig,
    private readonly deps: RunnerDeps,
  ) {
    this.log = logger(cfg.code);
    this.protocol = protocolOf(cfg);
    this.status = {
      code: cfg.code,
      model: cfg.model,
      protocol: this.protocol,
      endpoint: '',
      state: cfg.enabled === false ? 'disabled' : 'waiting',
      detail: cfg.enabled === false ? 'disabled in the agent config' : null,
      connectedSince: null,
      lastMessageAt: null,
      messages: 0,
      queries: 0,
      incomplete: 0,
    };
  }

  start(): void {
    if (this.cfg.enabled === false) return;
    const ev: TransportEvents = {
      onConnect: () => this.openSession(),
      onData: (chunk) => this.session?.receive(chunk),
      onDisconnect: (reason) => void this.closeSession(reason),
      onState: (state, detail) => {
        if (state === 'connected' && this.status.state !== 'connected') this.status.connectedSince = new Date().toISOString();
        if (state !== 'connected') this.status.connectedSince = null;
        this.status.state = state;
        this.status.detail = detail;
      },
    };
    const c = this.cfg;
    const profile = c.model === 'other' ? null : PROFILES[c.model];
    if (c.transport === 'serial') {
      this.transport = new SerialTransport(
        {
          code: c.code,
          path: c.serialPath!,
          baudRate: c.baudRate ?? profile?.serial?.baudRate ?? 9600,
          dataBits: c.dataBits ?? profile?.serial?.dataBits ?? 8,
          parity: c.parity ?? profile?.serial?.parity ?? 'none',
          stopBits: c.stopBits ?? profile?.serial?.stopBits ?? 1,
        },
        ev,
      );
    } else if (c.transport === 'tcp_client') {
      this.transport = new TcpClientTransport({ code: c.code, host: c.host!, port: portOf(c)! }, ev);
    } else {
      this.transport = new TcpServerTransport({ code: c.code, host: c.host ?? '127.0.0.1', port: portOf(c)!, allowFrom: c.allowFrom ?? [] }, ev);
    }
    this.status.endpoint = this.transport.describe;
    this.transport.start();
  }

  async stop(): Promise<void> {
    await this.closeSession('agent stopping');
    await this.transport?.stop();
  }

  private trace(t: WireTrace): void {
    const line = `${t.dir === 'tx' ? '→' : t.dir === 'rx' ? '←' : '·'} ${t.text}`;
    if (t.kind === 'error') this.log.warn(line);
    else if (this.deps.logTraffic) this.log.info(line);
    else this.log.debug(line);
  }

  private openSession(): void {
    void this.closeSession('new connection');
    const code = this.cfg.code;
    this.session = createSession(this.protocol, {
      role: 'host',
      write: (bytes) => this.transport?.write(bytes),
      encoding: this.cfg.encoding,
      text: { idleMs: this.cfg.textIdleMs ?? 2_500 },
      hl7: { timeZone: this.deps.timeZone },
      onTrace: (t) => this.trace(t),
      onFrame: (text, idx) => {
        if (idx === 0 || !this.transmission) {
          this.transmission = randomUUID();
          this.part = 0;
        }
        // On disk before the ACK goes out (synchronous SQLite write).
        this.deps.journal.addFrame(code, this.transmission, idx, text);
      },
      onTransmissionEnd: () => {
        if (this.transmission) this.deps.journal.dropFrames(this.transmission);
        this.transmission = null;
      },
      onMessage: (m) => this.onMessage(m),
      onIncomplete: (text, reason) => this.onIncomplete(text, reason),
    });
  }

  private async closeSession(reason: string): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) await session.close(reason);
  }

  private onIncomplete(text: string, reason: string): void {
    const isAstm = this.protocol === 'astm';
    const id = this.deps.journal.addMessage(this.cfg.code, text, {
      incomplete: true,
      note: reason,
      transmission: isAstm ? this.transmission ?? undefined : undefined,
      part: isAstm && this.transmission ? this.part++ : undefined,
    });
    if (isAstm && this.transmission) {
      this.deps.journal.dropFrames(this.transmission);
      this.transmission = null;
    }
    this.status.incomplete++;
    this.log.warn(`incomplete message #${id} kept for review (${reason})`);
    this.deps.uploader.wake();
  }

  private onMessage(m: SessionMessage): SessionReply | void {
    if (m.isResponse) return; // an acknowledgement of something we sent
    const isAstm = this.protocol === 'astm';
    const id = this.deps.journal.addMessage(this.cfg.code, m.text, {
      receivedAt: m.receivedAt,
      transmission: isAstm ? this.transmission ?? undefined : undefined,
      part: isAstm && this.transmission ? this.part++ : undefined,
    });
    this.status.messages++;
    this.status.lastMessageAt = m.receivedAt.toISOString();
    this.deps.uploader.wake();

    let parsed: InstrumentMessage | null = null;
    try {
      parsed = normalize(this.cfg.model, m.text, this.protocol);
    } catch (err) {
      this.log.warn(`message #${id} journaled but not readable here (${err instanceof Error ? err.message : String(err)}); the platform will record it`);
      return;
    }
    const results = parsed.specimens.reduce((n, s) => n + s.results.length, 0);
    this.log.info(`message #${id} journaled: ${parsed.messageType}, ${parsed.specimens.map((s) => s.sampleId || '?').join(', ') || 'no specimen'}${results ? `, ${results} result(s)` : ''}`);
    if (parsed.kind === 'query') return this.answerQuery(m.text, parsed);
  }

  /** Answer a host query from the cached worklist (works offline). */
  private answerQuery(raw: string, parsed: InstrumentMessage): SessionReply | void {
    if (this.cfg.model === 'other' || !PROFILES[this.cfg.model].bidirectional) return;
    const ids = [...new Set(parsed.queries.flatMap((q) => q.sampleIds))];
    if (!ids.length) {
      this.log.warn('host query without a sample ID; not answered');
      return;
    }
    const orders: HostOrder[] = ids.map((id) => {
      const { item, stale, ageMs } = this.deps.worklist.lookup(this.cfg.code, id);
      if (stale) {
        this.log.warn(`worklist is ${ageMs === null ? 'not loaded yet' : `${Math.round(ageMs / 60_000)} min old`}; answering "no work" for ${id}`);
        return { sampleId: id, found: false, tests: [] };
      }
      if (!item) return { sampleId: id, found: false, tests: [] };
      return { sampleId: id, found: true, tests: item.tests.map((t) => t.code), priority: item.priority, sex: item.sex, birthDate: item.birthDate };
    });
    const replies = buildHostReply({ model: this.cfg.model, query: raw, orders, timeZone: this.deps.timeZone });
    this.deps.journal.logOutbound(this.cfg.code, replies.join('\n'), null);
    this.status.queries++;
    this.log.info(`host query: ${orders.map((o) => (o.found ? `${o.sampleId} → ${o.tests.join(',')}` : `${o.sampleId} → no work`)).join('; ')}`);
    return { reply: replies };
  }
}

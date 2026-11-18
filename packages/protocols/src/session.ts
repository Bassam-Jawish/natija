/**
 * One interface over the three link layers, used by the Lab Agent (host side), the
 * simulator (instrument side) and the server's in-process simulation:
 *
 *  - astm:  ASTM E1381 link (astm-link.ts); a transmission may hold several H..L messages,
 *           each is delivered separately.
 *  - hl7:   MLLP framing; every received message gets an acknowledgement (ACK, or ORL^O34
 *           for OML^O33) after onMessage returns, unless onMessage returns explicit replies
 *           (query answers such as RSP^K11 + OML^O33). Unreadable messages get MSA-1 = AR.
 *  - text:  no framing at all (Medica printout, ichroma demo lines): a message ends after an
 *           idle gap, a form feed, or flush(). Nothing is ever acknowledged.
 *
 * "Journal before ACK": onFrame (ASTM, per frame) and onMessage (HL7) are awaited before
 * the acknowledgement is written.
 */
import { AstmLink, type AstmLinkOptions, type AstmTimeouts } from './astm-link';
import { astmHasTerminator, splitAstmMessages } from './astm';
import { buildHl7Ack, hl7AckCode, hl7AckedControlId, hl7Get, hl7IsResponse, hl7Label, mllpFrame, MllpDecoder, parseHl7, type Hl7Message } from './hl7';
import { bytesToBinary, decodeText, encodeText, printable, realTimers, type TextEncoding, type Timers, type WireTrace } from './bytes';
import type { ProtocolFamily } from './profiles';
import { compactTimestamp } from './time';

export type SessionRole = 'host' | 'instrument';

export type SessionMessage = {
  text: string;
  receivedAt: Date;
  /** HL7 only: this message answers one we sent (ACK, RSP, QCK, ORL). */
  isResponse?: boolean;
};

export type SessionReply = {
  /** Messages to send back instead of the automatic acknowledgement (query answers). */
  reply?: string[];
  /** HL7: acknowledgement code when no `reply` is given (default AA). */
  ack?: 'AA' | 'AE' | 'AR';
  ackText?: string;
};

export type SendResult = { ok: boolean; error?: string; response?: string };

export interface ProtocolSession {
  readonly protocol: ProtocolFamily;
  /** Feed bytes read from the wire. */
  receive(chunk: Uint8Array | string): void;
  /** Send one message; resolves when it was acknowledged (or could not be). */
  send(message: string): Promise<SendResult>;
  /** Text protocols: treat what has arrived so far as a complete message. */
  flush(): Promise<void>;
  /** Resolves once queued input has been processed. */
  settled(): Promise<void>;
  /** Resolves when nothing is in flight. */
  idle(): Promise<void>;
  close(reason?: string): Promise<void>;
}

export type SessionOptions = {
  role: SessionRole;
  write: (bytes: Uint8Array) => void;
  onMessage?: (msg: SessionMessage) => SessionReply | void | Promise<SessionReply | void>;
  /** ASTM: every new valid frame (binary text) before it is ACKed; throw to NAK it. */
  onFrame?: (frameText: string, index: number) => void | Promise<void>;
  /** A message that started but never finished (link dropped, timeout). */
  onIncomplete?: (partialText: string, reason: string) => void | Promise<void>;
  /** ASTM: every message of a transmission (ENQ … EOT) has been handed to onMessage/onIncomplete. */
  onTransmissionEnd?: () => void | Promise<void>;
  onTrace?: (entry: WireTrace) => void;
  /** Wire encoding: ASTM defaults to latin1, HL7 and text to utf8. */
  encoding?: TextEncoding;
  timers?: Timers;
  astm?: {
    timeouts?: Partial<AstmTimeouts>;
    maxRetries?: number;
    maxFrameText?: number;
    mutateFrame?: AstmLinkOptions['mutateFrame'];
  };
  hl7?: {
    /** How long to wait for an acknowledgement of a message we sent (default 15 s). */
    ackTimeoutMs?: number;
    timeZone?: string;
    /** Fault injection: change an outgoing message before framing. */
    mutateOutgoing?: (message: string) => string;
  };
  text?: { idleMs?: number };
};

export function createSession(protocol: ProtocolFamily, opts: SessionOptions): ProtocolSession {
  if (protocol === 'astm') return new AstmSession(opts);
  if (protocol === 'hl7') return new Hl7Session(opts);
  return new TextSession(protocol, opts);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ ASTM */

class AstmSession implements ProtocolSession {
  readonly protocol = 'astm' as const;
  private readonly link: AstmLink;

  constructor(opts: SessionOptions) {
    const onFrame = opts.onFrame;
    this.link = new AstmLink({
      role: opts.role,
      write: opts.write,
      encoding: opts.encoding ?? 'latin1',
      timers: opts.timers,
      timeouts: opts.astm?.timeouts,
      maxRetries: opts.astm?.maxRetries,
      maxFrameText: opts.astm?.maxFrameText,
      mutateFrame: opts.astm?.mutateFrame,
      onTrace: opts.onTrace,
      onIncomplete: opts.onIncomplete,
      beforeAck: onFrame ? (frame, index) => onFrame(frame.text, index) : undefined,
      onMessage: async (m) => {
        const replies: string[] = [];
        for (const text of splitAstmMessages(m.text)) {
          if (!astmHasTerminator(text)) {
            // The sender stopped (EOT) before the L record: an aborted message, never applied.
            const reason = 'transmission ended before the terminator (L) record';
            opts.onTrace?.({ t: 0, dir: 'note', kind: 'error', text: `message incomplete (${reason}); not delivered` });
            await opts.onIncomplete?.(text, reason);
            continue;
          }
          const r = await opts.onMessage?.({ text, receivedAt: m.receivedAt });
          if (r?.reply) replies.push(...r.reply);
        }
        await opts.onTransmissionEnd?.();
        return replies;
      },
    });
  }

  receive(chunk: Uint8Array | string): void {
    this.link.receive(chunk);
  }

  async send(message: string): Promise<SendResult> {
    const r = await this.link.send(message);
    return r.ok ? { ok: true } : { ok: false, error: `${r.error}${r.detail ? `: ${r.detail}` : ''}` };
  }

  async flush(): Promise<void> {
    await this.link.settled();
  }

  settled(): Promise<void> {
    return this.link.settled();
  }

  idle(): Promise<void> {
    return this.link.idle();
  }

  close(reason?: string): Promise<void> {
    return this.link.close(reason);
  }
}

/* ------------------------------------------------------------------ HL7 / MLLP */

class Hl7Session implements ProtocolSession {
  readonly protocol = 'hl7' as const;
  private readonly decoder: MllpDecoder;
  private readonly timers: Timers;
  private readonly encoding: TextEncoding;
  private readonly started = Date.now();
  private chain: Promise<void> = Promise.resolve();
  private pending = new Map<string, { resolve: (r: SendResult) => void; timer: unknown }>();
  private waiters: Array<() => void> = [];
  private closed = false;
  private seq = 0;

  constructor(private readonly opts: SessionOptions) {
    this.encoding = opts.encoding ?? 'utf8';
    this.timers = opts.timers ?? realTimers;
    this.decoder = new MllpDecoder({ encoding: this.encoding, onJunk: (text) => this.trace('note', 'info', text) });
  }

  private trace(dir: WireTrace['dir'], kind: WireTrace['kind'], text: string, ok?: boolean): void {
    this.opts.onTrace?.({ t: Date.now() - this.started, dir, kind, text, ...(ok === undefined ? {} : { ok }) });
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch((err: unknown) => this.trace('note', 'error', `session error: ${errorText(err)}`));
    void this.chain.then(() => this.notify());
  }

  private notify(): void {
    if (this.pending.size || !this.waiters.length) return;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private nextControlId(): string {
    this.seq = (this.seq + 1) % 100000;
    return `N${Date.now().toString(36).toUpperCase()}${this.seq}`;
  }

  receive(chunk: Uint8Array | string): void {
    if (this.closed) return;
    for (const text of this.decoder.push(chunk)) {
      const receivedAt = new Date();
      this.enqueue(() => this.handle(text, receivedAt));
    }
  }

  private writeMessage(message: string, ok?: boolean): void {
    this.opts.write(mllpFrame(message, this.encoding));
    this.trace('tx', 'message', printable(`\x0b${message}\x1c\r`), ok);
  }

  private async handle(text: string, receivedAt: Date): Promise<void> {
    this.trace('rx', 'message', printable(`\x0b${text}\x1c\r`));
    let msg: Hl7Message | null = null;
    let parseError = '';
    try {
      msg = parseHl7(text);
    } catch (err) {
      parseError = errorText(err);
    }

    if (msg && hl7IsResponse(msg.type)) {
      const acked = hl7AckedControlId(msg);
      const waiting = acked ? this.pending.get(acked) : undefined;
      const code = hl7AckCode(msg) ?? '';
      if (waiting) {
        this.timers.clear(waiting.timer);
        this.pending.delete(acked!);
        const accepted = code === 'AA' || code === 'CA';
        if (!accepted) this.trace('note', 'error', `${hl7Label(msg)} refused message ${acked} (${code}${this.msaText(msg)})`);
        waiting.resolve(accepted ? { ok: true, response: text } : { ok: false, error: `${code}${this.msaText(msg)}`, response: text });
      } else {
        this.trace('note', 'info', `${hl7Label(msg)} for ${acked ?? 'no'} control ID that is not awaited`);
      }
      try {
        await this.opts.onMessage?.({ text, receivedAt, isResponse: true });
      } catch (err) {
        this.trace('note', 'error', `response handler failed: ${errorText(err)}`);
      }
      return;
    }

    let reply: SessionReply | void = undefined;
    let failure = '';
    try {
      reply = await this.opts.onMessage?.({ text, receivedAt });
    } catch (err) {
      failure = errorText(err);
    }
    if (!msg) {
      this.trace('note', 'error', `unreadable message (${parseError}): answered AR`);
      this.writeMessage(this.rawReject(text, parseError));
      return;
    }
    if (reply?.reply?.length) {
      for (const r of reply.reply) {
        // Fire and forget: awaiting an acknowledgement here would block reading it.
        void this.send(r).then((res) => {
          if (!res.ok) this.trace('note', 'error', `reply not acknowledged (${res.error})`);
        });
      }
      return;
    }
    const code = failure ? 'AE' : (reply?.ack ?? 'AA');
    if (failure) this.trace('note', 'error', `message not stored (${failure}): answered AE`);
    const ack = buildHl7Ack(msg, {
      code,
      text: failure || reply?.ackText,
      controlId: this.nextControlId(),
      timeZone: this.opts.hl7?.timeZone,
      messageType: msg.type === 'OML' && msg.trigger === 'O33' ? 'ORL^O34^ORL_O34' : undefined,
    });
    this.writeMessage(ack);
  }

  private msaText(msg: Hl7Message): string {
    const msa = msg.segments.find((s) => s.name === 'MSA');
    const text = msa ? hl7Get(msa, 3, msg.delimiters) : '';
    return text ? `: ${text}` : '';
  }

  /** AR for a message we could not parse; MSA-2 echoes MSH-10 when it can be found. */
  private rawReject(text: string, reason: string): string {
    const msh = text.split(/\r\n|\r|\n/).find((l) => l.startsWith('MSH')) ?? '';
    const sep = msh[3] && !/[A-Za-z0-9]/.test(msh[3]) ? msh[3] : '|';
    const control = msh ? (msh.split(sep)[9] ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 40) : '';
    const ts = compactTimestamp(new Date(), this.opts.hl7?.timeZone ?? 'UTC');
    const clean = reason.replace(/[|^~\\&\r\n]/g, ' ').slice(0, 80);
    return `MSH|^~\\&|||||${ts}||ACK|${this.nextControlId()}|P|2.5\rMSA|AR|${control}|${clean}\r`;
  }

  send(message: string): Promise<SendResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'closed' });
    let msg: Hl7Message | null = null;
    try {
      msg = parseHl7(message);
    } catch {
      msg = null;
    }
    const out = this.opts.hl7?.mutateOutgoing ? this.opts.hl7.mutateOutgoing(message) : message;
    if (!msg || hl7IsResponse(msg.type) || !msg.controlId) {
      this.writeMessage(out, out === message);
      return Promise.resolve({ ok: true });
    }
    const controlId = msg.controlId;
    const ms = this.opts.hl7?.ackTimeoutMs ?? 15_000;
    const result = new Promise<SendResult>((resolve) => {
      const timer = this.timers.set(() => {
        this.pending.delete(controlId);
        this.trace('note', 'error', `no acknowledgement for ${controlId} within ${ms / 1000} s`);
        resolve({ ok: false, error: 'timeout' });
        this.notify();
      }, ms);
      this.pending.set(controlId, { resolve, timer });
    });
    this.writeMessage(out, out === message);
    return result.then((r) => {
      this.notify();
      return r;
    });
  }

  async flush(): Promise<void> {
    await this.settled();
  }

  async settled(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c;
      if (c === this.chain) return;
    }
  }

  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      void this.settled().then(() => this.notify());
    });
  }

  async close(reason = 'connection closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.settled();
    const partial = this.decoder.pending();
    this.decoder.reset();
    if (partial) {
      this.trace('note', 'error', `message incomplete (${reason}): no <FS><CR> received`);
      try {
        await this.opts.onIncomplete?.(partial, reason);
      } catch (err) {
        this.trace('note', 'error', `incomplete-message handler failed: ${errorText(err)}`);
      }
    }
    for (const [, p] of this.pending) {
      this.timers.clear(p.timer);
      p.resolve({ ok: false, error: 'closed' });
    }
    this.pending.clear();
    this.notify();
  }
}

/* ------------------------------------------------------------------ text (no framing) */

class TextSession implements ProtocolSession {
  private readonly timers: Timers;
  private readonly encoding: TextEncoding;
  private readonly idleMs: number;
  private readonly started = Date.now();
  private buf = '';
  private lastDataAt = 0;
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly protocol: ProtocolFamily,
    private readonly opts: SessionOptions,
  ) {
    this.timers = opts.timers ?? realTimers;
    this.encoding = opts.encoding ?? 'utf8';
    this.idleMs = opts.text?.idleMs ?? 2_500;
  }

  private trace(dir: WireTrace['dir'], kind: WireTrace['kind'], text: string): void {
    this.opts.onTrace?.({ t: Date.now() - this.started, dir, kind, text });
  }

  receive(chunk: Uint8Array | string): void {
    if (this.closed) return;
    const bin = bytesToBinary(chunk);
    this.trace('rx', 'text', printable(decodeText(bin, this.encoding)));
    this.buf += bin;
    this.lastDataAt = Date.now();
    const ff = this.buf.lastIndexOf('\f');
    if (ff >= 0) {
      const done = this.buf.slice(0, ff);
      this.buf = this.buf.slice(ff + 1);
      this.emit(done, 'form feed');
    }
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.buf.length ? this.timers.set(() => void this.flush(), this.idleMs) : null;
  }

  private emit(binary: string, why: string): void {
    const text = decodeText(binary, this.encoding);
    if (!text.trim()) return;
    const receivedAt = new Date();
    this.chain = this.chain
      .then(async () => {
        this.trace('note', 'info', `message complete (${why})`);
        await this.opts.onMessage?.({ text, receivedAt });
      })
      .catch((err: unknown) => this.trace('note', 'error', `message handler failed: ${errorText(err)}`));
  }

  send(message: string): Promise<SendResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'closed' });
    this.opts.write(Buffer.from(encodeText(message, this.encoding), 'latin1'));
    this.trace('tx', 'text', printable(message));
    return Promise.resolve({ ok: true });
  }

  async flush(): Promise<void> {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    const pending = this.buf;
    this.buf = '';
    if (pending) this.emit(pending, 'idle gap');
    await this.settled();
  }

  async settled(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c;
      if (c === this.chain) return;
    }
  }

  idle(): Promise<void> {
    return this.settled();
  }

  async close(reason = 'connection closed'): Promise<void> {
    if (this.closed) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    const pending = this.buf;
    this.buf = '';
    this.closed = true;
    if (pending.trim()) {
      // Data still arriving when the link dropped: the printout may be cut short.
      if (Date.now() - this.lastDataAt < this.idleMs) {
        this.trace('note', 'error', `text cut off (${reason}); kept as incomplete`);
        const text = decodeText(pending, this.encoding);
        this.chain = this.chain
          .then(async () => {
            await this.opts.onIncomplete?.(text, reason);
          })
          .catch((err: unknown) => this.trace('note', 'error', `incomplete-message handler failed: ${errorText(err)}`));
      } else {
        this.emit(pending, reason);
      }
    }
    await this.settled();
  }
}

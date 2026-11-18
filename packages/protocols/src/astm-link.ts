/**
 * ASTM E1381 link layer as a state machine over any byte stream (TCP socket, serial port,
 * or an in-memory pipe). It knows nothing about the transport: feed it bytes with
 * receive(), give it a write() callback, and queue outgoing messages with send().
 *
 * Receiver: ENQ → ACK; each frame → ACK (stored) or NAK (bad checksum, bad frame number);
 *           a repeated frame (our ACK was lost) is ACKed again but stored once; EOT ends the
 *           transmission and hands the text to onMessage.
 * Sender:   ENQ, wait for ACK (NAK = busy, retry after 10 s), frames one by one, each
 *           waiting for ACK (NAK → retransmit, at most 6 times), then EOT.
 * Timeouts (E1381): 15 s for a reply to ENQ or to a frame, 30 s between received frames.
 * Contention (both sides send ENQ): the instrument wins. The host stops, answers the
 *           instrument's next ENQ and sends its own message afterwards; the instrument
 *           waits 1 s and sends ENQ again.
 *
 * "Journal before ACK": beforeAck() runs for every new frame before the ACK is written, so a
 * caller can store the frame on disk first. If it throws, the frame is NAKed and the
 * analyzer keeps the data and retransmits.
 */
import { C, CH, binaryToBytes, bytesToBinary, controlName, decodeText, encodeText, printable, realTimers, type TextEncoding, type Timers, type WireTrace } from './bytes';
import { ASTM_FRAME_RECEIVE_LIMIT, ASTM_FRAME_TEXT_MAX, frameMessage, parseFrame, type AstmFrame } from './astm';

export type AstmLinkRole = 'instrument' | 'host';

export type AstmTimeouts = {
  /** Sender: wait for the reply to ENQ (E1381: 15 s). */
  establishMs: number;
  /** Sender: wait for the reply to a frame (E1381: 15 s). */
  replyMs: number;
  /** Receiver: wait for the next frame or EOT (E1381: 30 s). */
  receiveMs: number;
  /** Sender: pause after the receiver answered ENQ with NAK, i.e. busy (E1381: at least 10 s). */
  busyRetryMs: number;
  /** Instrument: pause after contention before sending ENQ again (E1381: at least 1 s). */
  contentionInstrumentMs: number;
  /** Host: how long it holds back after yielding on contention if the instrument stays quiet. */
  contentionHostMs: number;
};

export const E1381_TIMEOUTS: AstmTimeouts = {
  establishMs: 15_000,
  replyMs: 15_000,
  receiveMs: 30_000,
  busyRetryMs: 10_000,
  contentionInstrumentMs: 1_000,
  contentionHostMs: 20_000,
};

export type AstmReceived = { text: string; frames: number; receivedAt: Date };

export type AstmSendResult = {
  ok: boolean;
  error?: 'timeout' | 'nak' | 'busy' | 'closed';
  detail?: string;
  /** Frames acknowledged by the receiver. */
  frames: number;
};

export type AstmLinkOptions = {
  role: AstmLinkRole;
  write: (bytes: Uint8Array) => void;
  /** A whole transmission (ENQ … EOT) arrived. Return messages to send back, e.g. a host query reply. */
  onMessage?: (msg: AstmReceived) => void | string[] | Promise<void | string[]>;
  /** Runs for every new valid frame BEFORE it is acknowledged. Throw to answer NAK instead. */
  beforeAck?: (frame: AstmFrame, index: number) => void | Promise<void>;
  /** A transmission ended without EOT (receive timeout, connection lost, sender restarted). */
  onIncomplete?: (partialText: string, reason: string) => void | Promise<void>;
  onTrace?: (entry: WireTrace) => void;
  /** Text encoding on the wire (ASTM is 8-bit; default latin1). */
  encoding?: TextEncoding;
  /** Text characters per frame we send (default 239, see astm.ts). */
  maxFrameText?: number;
  /** Retransmissions of one frame before the sender aborts (E1381: 6). */
  maxRetries?: number;
  timeouts?: Partial<AstmTimeouts>;
  timers?: Timers;
  /** Fault injection for simulators: change an outgoing frame (e.g. corrupt its checksum). */
  mutateFrame?: (frame: string, info: { index: number; attempt: number }) => string;
};

export type AstmLinkState = 'idle' | 'rx' | 'tx-enq' | 'tx-frame' | 'tx-wait' | 'closed';

type Outgoing = { text: string; resolve: (r: AstmSendResult) => void; enqTries: number };

const LINE_CONTROLS = new Set<number>([C.ENQ, C.ACK, C.NAK, C.EOT]);
const RX_STOPS = new Set<number>([C.STX, C.EOT, C.ENQ]);
type Current = { out: Outgoing; frames: string[]; index: number; attempt: number };

export class AstmLink {
  private state: AstmLinkState = 'idle';
  private buf = '';
  private skipLf = false;
  private chain: Promise<void> = Promise.resolve();
  private queue: Outgoing[] = [];
  private current: Current | null = null;
  private timer: unknown = null;
  private holdTimer: unknown = null;
  private yielded = false;
  private rxFrames: string[] = [];
  private rxExpected = 1;
  private waiters: Array<() => void> = [];
  private readonly started = Date.now();
  private readonly t: AstmTimeouts;
  private readonly timers: Timers;
  private readonly maxRetries: number;
  private readonly encoding: TextEncoding;

  constructor(private readonly opts: AstmLinkOptions) {
    this.t = { ...E1381_TIMEOUTS, ...opts.timeouts };
    this.timers = opts.timers ?? realTimers;
    this.maxRetries = opts.maxRetries ?? 6;
    this.encoding = opts.encoding ?? 'latin1';
  }

  get linkState(): AstmLinkState {
    return this.state;
  }

  /** Feed bytes read from the wire. */
  receive(chunk: Uint8Array | string): void {
    if (this.state === 'closed') return;
    this.buf += bytesToBinary(chunk);
    this.enqueue(() => this.process());
  }

  /** Queue a message (records separated by CR). Resolves once it was delivered or given up. */
  send(text: string): Promise<AstmSendResult> {
    if (this.state === 'closed') return Promise.resolve({ ok: false, error: 'closed', frames: 0 });
    return new Promise((resolve) => {
      this.queue.push({ text, resolve, enqTries: 0 });
      this.enqueue(() => this.process());
    });
  }

  /** Resolves once queued input has been processed. */
  async settled(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c;
      if (c === this.chain) return;
    }
  }

  /** Resolves when the line is idle with nothing left to send. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.notifyWaiters();
    });
  }

  /** Stop: pending sends fail, a half-received transmission is reported as incomplete. */
  close(reason = 'connection closed'): Promise<void> {
    this.enqueue(async () => {
      if (this.state === 'closed') return;
      this.clearTimers();
      if (this.state === 'rx') await this.incomplete(reason);
      const pending = [...(this.current ? [this.current.out] : []), ...this.queue];
      this.current = null;
      this.queue = [];
      this.state = 'closed';
      for (const p of pending) p.resolve({ ok: false, error: 'closed', detail: reason, frames: 0 });
      this.notifyWaiters();
    });
    return this.settled();
  }

  /* ---------------------------------------------------------------- internals */

  private enqueue(job: () => Promise<void> | void): void {
    this.chain = this.chain
      .then(job)
      .catch((err: unknown) => this.note('error', `link error: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async process(): Promise<void> {
    while (this.state !== 'closed' && (await this.step())) {
      // keep consuming
    }
    this.maybeStartSending();
    this.notifyWaiters();
  }

  private elapsed(): number {
    return Date.now() - this.started;
  }

  private trace(dir: WireTrace['dir'], kind: WireTrace['kind'], text: string, ok?: boolean): void {
    this.opts.onTrace?.({ t: this.elapsed(), dir, kind, text, ...(ok === undefined ? {} : { ok }) });
  }

  private note(kind: 'info' | 'error', text: string): void {
    this.trace('note', kind, text);
  }

  private writeControl(byte: number): void {
    this.opts.write(Uint8Array.of(byte));
    this.trace('tx', 'control', `<${controlName(byte)}>`);
  }

  private writeFrame(frame: string, ok: boolean): void {
    this.opts.write(binaryToBytes(frame));
    this.trace('tx', 'frame', printable(frame), ok);
  }

  private setTimer(ms: number, fn: () => Promise<void> | void): void {
    this.clearTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.enqueue(async () => {
        await fn();
        await this.process();
      });
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private setHold(ms: number, fn: () => void): void {
    if (this.holdTimer !== null) this.timers.clear(this.holdTimer);
    this.holdTimer = this.timers.set(() => {
      this.holdTimer = null;
      this.enqueue(async () => {
        fn();
        await this.process();
      });
    }, ms);
  }

  private clearTimers(): void {
    this.clearTimer();
    if (this.holdTimer !== null) this.timers.clear(this.holdTimer);
    this.holdTimer = null;
  }

  private isIdle(): boolean {
    if (this.state === 'closed') return true;
    return this.state === 'idle' && !this.current && !this.queue.length && !this.buf.length;
  }

  private notifyWaiters(): void {
    if (!this.isIdle() || !this.waiters.length) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Consume one unit of input. Returns false when more bytes are needed. */
  private async step(): Promise<boolean> {
    if (!this.buf.length) return false;
    if (this.skipLf) {
      this.skipLf = false;
      if (this.buf[0] === CH.LF) {
        this.buf = this.buf.slice(1);
        return true;
      }
    }
    if (this.state === 'rx') return this.stepReceive();
    const byte = this.buf.charCodeAt(0);
    if (LINE_CONTROLS.has(byte)) {
      this.buf = this.buf.slice(1);
      this.trace('rx', 'control', `<${controlName(byte)}>`);
      this.onControl(byte);
      return true;
    }
    // Anything else outside a transmission is noise.
    let n = 1;
    while (n < this.buf.length && !LINE_CONTROLS.has(this.buf.charCodeAt(n))) n++;
    const junk = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    if (this.state === 'tx-frame') {
      // E1381: any reply other than ACK, NAK or EOT counts as NAK.
      this.trace('rx', 'text', printable(junk));
      this.onControl(C.NAK);
    } else {
      this.note('info', `ignored ${junk.length} byte(s) outside a transmission: ${printable(junk).slice(0, 80)}`);
    }
    return true;
  }

  private async stepReceive(): Promise<boolean> {
    const c = this.buf.charCodeAt(0);
    if (c === C.EOT) {
      this.buf = this.buf.slice(1);
      this.trace('rx', 'control', '<EOT>');
      await this.endTransmission();
      return true;
    }
    if (c === C.ENQ) {
      this.buf = this.buf.slice(1);
      this.trace('rx', 'control', '<ENQ>');
      if (this.rxFrames.length) await this.incomplete('ENQ received before EOT: the sender started over');
      this.startReceiving();
      return true;
    }
    if (c !== C.STX) {
      let n = 1;
      while (n < this.buf.length && !RX_STOPS.has(this.buf.charCodeAt(n))) n++;
      this.note('info', `ignored ${n} byte(s) between frames`);
      this.buf = this.buf.slice(n);
      return true;
    }
    let term = -1;
    for (let i = 1; i < this.buf.length; i++) {
      const ch = this.buf.charCodeAt(i);
      if (ch === C.ETX || ch === C.ETB) {
        term = i;
        break;
      }
      if (RX_STOPS.has(ch)) {
        this.note('error', 'frame broken off before ETX/ETB; discarded');
        this.buf = this.buf.slice(i);
        return true;
      }
    }
    if (term < 0) {
      if (this.buf.length > ASTM_FRAME_RECEIVE_LIMIT) {
        this.note('error', 'frame exceeds the receive limit; discarded');
        this.buf = '';
        this.writeControl(C.NAK);
        return true;
      }
      return false;
    }
    if (this.buf.length < term + 4) return false;
    let end = term + 4;
    if (this.buf[end] === CH.LF) end++;
    else if (this.buf.length === end) this.skipLf = true;
    const raw = this.buf.slice(0, end);
    this.buf = this.buf.slice(end);
    const check = parseFrame(raw);
    this.trace('rx', 'frame', printable(raw), check.ok);
    this.restartReceiveTimer();
    if (!check.ok) {
      this.note('error', `frame rejected (${check.error}): NAK`);
      this.writeControl(C.NAK);
      return true;
    }
    const frame = check.frame;
    if (frame.fn === this.rxExpected % 8) {
      try {
        await this.opts.beforeAck?.(frame, this.rxFrames.length);
      } catch (err) {
        this.note('error', `frame ${frame.fn} could not be stored (${err instanceof Error ? err.message : String(err)}): NAK`);
        this.writeControl(C.NAK);
        return true;
      }
      if (this.state !== 'rx') return true;
      this.rxFrames.push(frame.text);
      this.rxExpected = (this.rxExpected + 1) % 8;
      this.writeControl(C.ACK);
      return true;
    }
    if (this.rxFrames.length && frame.fn === (this.rxExpected + 7) % 8) {
      this.note('info', `frame ${frame.fn} repeated (our ACK was lost): ACK again, stored once`);
      this.writeControl(C.ACK);
      return true;
    }
    this.note('error', `frame number ${frame.fn} out of sequence (expected ${this.rxExpected % 8}): NAK`);
    this.writeControl(C.NAK);
    return true;
  }

  private restartReceiveTimer(): void {
    this.setTimer(this.t.receiveMs, async () => {
      if (this.state !== 'rx') return;
      await this.incomplete(`no frame or EOT within ${this.t.receiveMs / 1000} s`);
      this.state = 'idle';
    });
  }

  private startReceiving(): void {
    this.state = 'rx';
    this.rxFrames = [];
    this.rxExpected = 1;
    this.writeControl(C.ACK);
    this.restartReceiveTimer();
  }

  private async incomplete(reason: string): Promise<void> {
    const frames = this.rxFrames;
    this.rxFrames = [];
    if (!frames.length) return;
    this.note('error', `transmission incomplete (${reason}); ${frames.length} frame(s) kept as incomplete`);
    try {
      await this.opts.onIncomplete?.(decodeText(frames.join(''), this.encoding), reason);
    } catch (err) {
      this.note('error', `incomplete-message handler failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async endTransmission(): Promise<void> {
    this.clearTimer();
    const frames = this.rxFrames;
    this.rxFrames = [];
    this.state = 'idle';
    if (this.yielded) {
      // The instrument finished the transmission it won on contention; the host may go next.
      this.yielded = false;
      if (this.holdTimer !== null) this.timers.clear(this.holdTimer);
      this.holdTimer = null;
    }
    if (!frames.length) {
      this.note('info', 'EOT without frames');
      return;
    }
    const text = decodeText(frames.join(''), this.encoding);
    let replies: void | string[] = undefined;
    try {
      replies = await this.opts.onMessage?.({ text, frames: frames.length, receivedAt: new Date() });
    } catch (err) {
      this.note('error', `message handler failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (replies?.length) {
      const items = replies.map((r) => ({ text: r, resolve: (res: AstmSendResult) => this.reportReply(res), enqTries: 0 }));
      this.queue.unshift(...items);
    }
  }

  private reportReply(res: AstmSendResult): void {
    if (!res.ok) this.note('error', `reply not delivered (${res.error}${res.detail ? `: ${res.detail}` : ''})`);
  }

  private onControl(byte: number): void {
    switch (this.state) {
      case 'idle':
        if (byte === C.ENQ) this.startReceiving();
        else this.note('info', `<${controlName(byte)}> ignored while idle`);
        return;
      case 'tx-enq':
        return this.onEstablishReply(byte);
      case 'tx-frame':
        return this.onFrameReply(byte);
      case 'tx-wait':
        if (byte === C.ENQ && this.opts.role === 'host') this.yieldToInstrument(true);
        return;
      default:
        return;
    }
  }

  private onEstablishReply(byte: number): void {
    const cur = this.current!;
    if (byte === C.ACK) {
      this.clearTimer();
      this.state = 'tx-frame';
      cur.index = 0;
      cur.attempt = 0;
      this.sendCurrentFrame();
      return;
    }
    if (byte === C.NAK) {
      this.clearTimer();
      cur.out.enqTries++;
      if (cur.out.enqTries > this.maxRetries) {
        this.finish({ ok: false, error: 'busy', detail: 'receiver answered NAK to every ENQ', frames: 0 });
        return;
      }
      this.note('info', `receiver busy (NAK): ENQ again in ${this.t.busyRetryMs / 1000} s`);
      this.state = 'tx-wait';
      this.setHold(this.t.busyRetryMs, () => this.sendEnq());
      return;
    }
    if (byte === C.ENQ) {
      this.clearTimer();
      if (this.opts.role === 'host') {
        this.yieldToInstrument(false);
      } else {
        this.note('info', `contention: the instrument keeps priority, ENQ again in ${this.t.contentionInstrumentMs / 1000} s`);
        this.state = 'tx-wait';
        this.setHold(this.t.contentionInstrumentMs, () => this.sendEnq());
      }
    }
    // E1381: other characters during establishment are ignored.
  }

  /** Host side of contention: stop sending, let the instrument transmit, try again later. */
  private yieldToInstrument(answerNow: boolean): void {
    if (this.current) this.queue.unshift(this.current.out);
    this.current = null;
    this.clearTimers();
    this.yielded = true;
    this.note('info', 'contention: the instrument has priority; the host waits and answers its ENQ');
    this.state = 'idle';
    this.setHold(this.t.contentionHostMs, () => {
      this.yielded = false;
    });
    if (answerNow) this.startReceiving();
  }

  private onFrameReply(byte: number): void {
    const cur = this.current!;
    this.clearTimer();
    if (byte === C.ACK || byte === C.EOT) {
      if (byte === C.EOT) this.note('info', 'receiver asked to interrupt (EOT); treated as ACK');
      cur.index++;
      cur.attempt = 0;
      if (cur.index >= cur.frames.length) {
        this.writeControl(C.EOT);
        this.finish({ ok: true, frames: cur.frames.length });
      } else {
        this.sendCurrentFrame();
      }
      return;
    }
    cur.attempt++;
    if (cur.attempt > this.maxRetries) {
      this.note('error', `frame ${cur.index + 1} refused ${cur.attempt} times: aborting the transmission`);
      this.writeControl(C.EOT);
      this.finish({ ok: false, error: 'nak', detail: `frame ${cur.index + 1} refused ${cur.attempt} times`, frames: cur.index });
      return;
    }
    this.note('info', `NAK: retransmitting frame ${cur.index + 1} (attempt ${cur.attempt + 1})`);
    this.sendCurrentFrame();
  }

  private sendEnq(): void {
    this.state = 'tx-enq';
    this.writeControl(C.ENQ);
    this.setTimer(this.t.establishMs, () => {
      if (this.state !== 'tx-enq') return;
      this.note('error', `no reply to ENQ within ${this.t.establishMs / 1000} s`);
      this.writeControl(C.EOT);
      this.finish({ ok: false, error: 'timeout', detail: 'no reply to ENQ', frames: 0 });
    });
  }

  private sendCurrentFrame(): void {
    const cur = this.current!;
    const original = cur.frames[cur.index]!;
    const frame = this.opts.mutateFrame ? this.opts.mutateFrame(original, { index: cur.index, attempt: cur.attempt }) : original;
    this.writeFrame(frame, frame === original);
    this.setTimer(this.t.replyMs, () => {
      if (this.state !== 'tx-frame') return;
      this.note('error', `no reply to frame ${cur.index + 1} within ${this.t.replyMs / 1000} s`);
      this.writeControl(C.EOT);
      this.finish({ ok: false, error: 'timeout', detail: `no reply to frame ${cur.index + 1}`, frames: cur.index });
    });
  }

  private finish(result: AstmSendResult): void {
    this.clearTimer();
    const cur = this.current;
    this.current = null;
    this.state = 'idle';
    cur?.out.resolve(result);
  }

  private maybeStartSending(): void {
    if (this.state !== 'idle' || this.current || !this.queue.length || this.yielded || this.buf.length) return;
    const out = this.queue.shift()!;
    const frames = frameMessage(encodeText(out.text, this.encoding), { maxText: this.opts.maxFrameText ?? ASTM_FRAME_TEXT_MAX });
    if (!frames.length) {
      out.resolve({ ok: true, frames: 0 });
      return;
    }
    this.current = { out, frames, index: 0, attempt: 0 };
    this.sendEnq();
  }
}

/** Corrupt a frame's checksum (fault injection for simulators). */
export function corruptChecksum(frame: string): string {
  const end = frame.endsWith(`${CH.CR}${CH.LF}`) ? frame.length - 2 : frame.length - 1;
  const last = frame[end - 1]!;
  const swapped = last === '0' ? '1' : '0';
  return `${frame.slice(0, end - 1)}${swapped}${frame.slice(end - 1 + 1)}`;
}

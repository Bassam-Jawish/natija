/**
 * Outbox uploader: sends journaled messages to the platform in small batches. The SHA-256
 * of each raw message is its idempotency key, so a retry after a lost response is
 * harmless (the server answers "duplicate"). While the platform is unreachable messages
 * simply wait in the journal; retries back off exponentially (2 s … 5 min).
 */
import { ApiError, type ApiClient } from './api-client';
import type { Journal, MessageRow } from './journal';
import { logger } from './log';

const log = logger('upload');
const BATCH = 20;
const BATCH_BYTES = 3 * 1024 * 1024;

function backoff(attempts: number): Date {
  const base = Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 8));
  return new Date(Date.now() + base / 2 + Math.random() * (base / 2));
}

export type UploadStatus = { lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null; uploaded: number };

export class Uploader {
  readonly status: UploadStatus = { lastOkAt: null, lastError: null, lastErrorAt: null, uploaded: 0 };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pausedUntil = 0;
  private stopped = false;

  constructor(
    private readonly journal: Journal,
    private readonly api: ApiClient,
  ) {}

  start(): void {
    this.schedule(500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Something new was journaled: upload soon. */
  wake(): void {
    if (!this.running) this.schedule(200);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let more = false;
    try {
      more = await this.uploadOnce();
    } catch (err) {
      log.error(`upload loop: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
      this.schedule(more ? 50 : 2_000);
    }
  }

  /** Returns true when a full batch went out (there may be more). */
  private async uploadOnce(): Promise<boolean> {
    if (!this.api.hasToken || Date.now() < this.pausedUntil) return false;
    const batch = this.journal.nextBatch(BATCH, BATCH_BYTES);
    if (!batch.length) return false;
    try {
      const res = await this.api.messages({
        messages: batch.map((m) => ({
          instrumentCode: m.instrument,
          raw: m.raw,
          receivedAt: new Date(m.received_at).toISOString(),
          idempotencyKey: m.raw_hash,
          ...(m.incomplete ? { incomplete: true } : {}),
          ...(m.note ? { note: m.note.slice(0, 500) } : {}),
        })),
      });
      // Results come back in request order; position (not hash) tells identical messages apart.
      batch.forEach((row, i) => {
        const r = res.results[i];
        if (!r || r.idempotencyKey !== row.raw_hash) {
          this.journal.markRetry(row.id, 'no matching result in the platform response', backoff(row.attempts + 1));
          return;
        }
        this.apply(row, r.accepted, r.status, r.messageId, r.error);
      });
      this.status.lastOkAt = new Date().toISOString();
      return batch.length === BATCH;
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, 'unknown', String(err));
      this.status.lastError = `${e.code}: ${e.message}`;
      this.status.lastErrorAt = new Date().toISOString();
      if (e.status === 401) {
        log.error('the platform refused the agent token (revoked or replaced?); uploads paused for 60 s, messages stay queued');
        this.pausedUntil = Date.now() + 60_000;
        return false;
      }
      log.warn(`upload failed (${e.message}); ${batch.length} message(s) stay queued`);
      for (const m of batch) this.journal.markRetry(m.id, this.status.lastError, backoff(m.attempts + 1));
      return false;
    }
  }

  private apply(row: MessageRow, accepted: boolean, status: string, messageId: string | null, error?: string): void {
    if (accepted) {
      this.journal.markUploaded(row.id, status, messageId);
      this.status.uploaded++;
      const tag = status === 'processed' ? 'info' : status === 'duplicate' ? 'info' : 'warn';
      log[tag](`${row.instrument} message #${row.id} → ${status}${error ? ` (${error})` : ''}`);
      return;
    }
    // Refused (unknown instrument, assigned elsewhere, hash mismatch, server error): keep it, retry slowly.
    const next = error === 'server_error' ? backoff(row.attempts + 1) : new Date(Date.now() + 10 * 60_000);
    log.warn(`${row.instrument} message #${row.id} refused by the platform (${error ?? status}); retrying at ${next.toISOString()}`);
    this.journal.markRetry(row.id, error ?? status, next, true);
  }
}

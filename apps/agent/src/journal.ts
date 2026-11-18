/**
 * The agent's journal (SQLite through Node's built-in node:sqlite).
 *
 * Nothing an analyzer sends is acknowledged before it is on disk:
 *  - ASTM: each frame is written to `frames` before its ACK; when the transmission ends the
 *    frames become rows in `messages` (one per H..L message) and are deleted.
 *  - HL7: the message is written before the HL7 ACK is sent.
 *  - Text (printouts): no acknowledgement exists; the text is written when it completes.
 * `messages` doubles as the upload outbox (state pending → uploaded / failed). Writes use
 * synchronous=FULL, so a commit survives a power cut.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { astmHasTerminator, splitAstmMessages } from '@natija/protocols';

export type MessageRow = {
  id: number;
  instrument: string;
  raw: string;
  raw_hash: string;
  received_at: string;
  incomplete: number;
  note: string | null;
  state: 'pending' | 'uploaded' | 'failed';
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  server_status: string | null;
  server_message_id: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY,
  instrument TEXT NOT NULL,
  transmission TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS frames_tx ON frames (transmission, idx);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  instrument TEXT NOT NULL,
  raw TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  transmission TEXT,
  part INTEGER,
  incomplete INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  server_status TEXT,
  server_message_id TEXT,
  uploaded_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_outbox ON messages (state, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_tx_part ON messages (transmission, part) WHERE transmission IS NOT NULL;
CREATE TABLE IF NOT EXISTS outbound (
  id INTEGER PRIMARY KEY,
  instrument TEXT NOT NULL,
  raw TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  ok INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS worklist (
  instrument TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class Journal {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /* ---------------------------------------------------------------- inbound */

  /** ASTM: store one frame before it is acknowledged. */
  addFrame(instrument: string, transmission: string, idx: number, text: string): void {
    this.db
      .prepare('INSERT INTO frames (instrument, transmission, idx, text, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(instrument, transmission, idx, text, new Date().toISOString());
  }

  /** Store a complete (or incomplete) message for upload. `part` numbers messages of one ASTM transmission. */
  addMessage(instrument: string, raw: string, opts: { receivedAt?: Date; transmission?: string; part?: number; incomplete?: boolean; note?: string } = {}): number {
    const at = (opts.receivedAt ?? new Date()).toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO messages (instrument, raw, raw_hash, received_at, transmission, part, incomplete, note, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(instrument, raw, sha256Hex(raw), at, opts.transmission ?? null, opts.part ?? null, opts.incomplete ? 1 : 0, opts.note ?? null, at);
    return Number(res.lastInsertRowid);
  }

  /** ASTM: the transmission is fully stored as messages; its frames can go. */
  dropFrames(transmission: string): void {
    this.db.prepare('DELETE FROM frames WHERE transmission = ?').run(transmission);
  }

  /**
   * After a crash: rebuild messages from frames whose transmission never finished. A message
   * that reached its L record is complete; the rest is kept as incomplete for review.
   */
  recoverFrames(): Array<{ instrument: string; transmission: string; complete: number; incomplete: number }> {
    const groups = this.db.prepare('SELECT instrument, transmission FROM frames GROUP BY instrument, transmission').all() as Array<{ instrument: string; transmission: string }>;
    const out: Array<{ instrument: string; transmission: string; complete: number; incomplete: number }> = [];
    for (const g of groups) {
      const rows = this.db.prepare('SELECT text, received_at FROM frames WHERE transmission = ? ORDER BY idx').all(g.transmission) as Array<{ text: string; received_at: string }>;
      const text = rows.map((r) => r.text).join('');
      let complete = 0;
      let incomplete = 0;
      this.tx(() => {
        splitAstmMessages(text).forEach((msg, part) => {
          const done = astmHasTerminator(msg);
          if (done) complete++;
          else incomplete++;
          this.addMessage(g.instrument, msg, {
            receivedAt: new Date(rows[0]?.received_at ?? Date.now()),
            transmission: g.transmission,
            part,
            incomplete: !done,
            note: done ? 'recovered from the frame journal after a restart' : 'agent restarted before the transmission ended',
          });
        });
        this.dropFrames(g.transmission);
      });
      out.push({ ...g, complete, incomplete });
    }
    return out;
  }

  /* ---------------------------------------------------------------- outbox */

  nextBatch(limit: number, maxBytes: number): MessageRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE state IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY id LIMIT ?`)
      .all(new Date().toISOString(), limit) as MessageRow[];
    const out: MessageRow[] = [];
    let bytes = 0;
    for (const r of rows) {
      const size = Buffer.byteLength(r.raw, 'utf8');
      if (out.length && bytes + size > maxBytes) break;
      out.push(r);
      bytes += size;
    }
    return out;
  }

  markUploaded(id: number, serverStatus: string, serverMessageId: string | null): void {
    this.db
      .prepare(`UPDATE messages SET state = 'uploaded', server_status = ?, server_message_id = ?, uploaded_at = ?, last_error = NULL, attempts = attempts + 1 WHERE id = ?`)
      .run(serverStatus, serverMessageId, new Date().toISOString(), id);
  }

  /** Keep for another try at `nextAt`; `failed` marks messages the server refused (still retried, slowly). */
  markRetry(id: number, error: string, nextAt: Date, refused = false): void {
    this.db
      .prepare(`UPDATE messages SET state = ?, last_error = ?, next_attempt_at = ?, attempts = attempts + 1 WHERE id = ?`)
      .run(refused ? 'failed' : 'pending', error, nextAt.toISOString(), id);
  }

  counts(): { pending: number; failed: number; incomplete: number; uploaded: number; frames: number } {
    const row = this.db
      .prepare(
        `SELECT
          sum(state = 'pending') AS pending, sum(state = 'failed') AS failed,
          sum(incomplete = 1 AND state <> 'uploaded') AS incomplete, sum(state = 'uploaded') AS uploaded
         FROM messages`,
      )
      .get() as Record<string, number | null>;
    const frames = this.db.prepare('SELECT count(*) AS n FROM frames').get() as { n: number };
    return { pending: row.pending ?? 0, failed: row.failed ?? 0, incomplete: row.incomplete ?? 0, uploaded: row.uploaded ?? 0, frames: frames.n };
  }

  recentMessages(limit: number): Array<Omit<MessageRow, 'raw'> & { size: number }> {
    return this.db
      .prepare(
        `SELECT id, instrument, raw_hash, received_at, incomplete, note, state, attempts, next_attempt_at, last_error, server_status, server_message_id, length(raw) AS size
         FROM messages ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<Omit<MessageRow, 'raw'> & { size: number }>;
  }

  /** Delete uploaded messages older than `days` (the server keeps the record). */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return Number(this.db.prepare(`DELETE FROM messages WHERE state = 'uploaded' AND uploaded_at < ?`).run(cutoff).changes);
  }

  /* ---------------------------------------------------------------- outbound and worklist */

  logOutbound(instrument: string, raw: string, ok: boolean | null, error?: string): void {
    this.db.prepare('INSERT INTO outbound (instrument, raw, sent_at, ok, error) VALUES (?, ?, ?, ?, ?)').run(instrument, raw, new Date().toISOString(), ok === null ? null : ok ? 1 : 0, error ?? null);
  }

  saveWorklist(instrument: string, json: string, fetchedAt: Date): void {
    this.db
      .prepare('INSERT INTO worklist (instrument, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT (instrument) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
      .run(instrument, json, fetchedAt.toISOString());
  }

  loadWorklist(instrument: string): { json: string; fetchedAt: Date } | null {
    const row = this.db.prepare('SELECT json, fetched_at FROM worklist WHERE instrument = ?').get(instrument) as { json: string; fetched_at: string } | undefined;
    return row ? { json: row.json, fetchedAt: new Date(row.fetched_at) } : null;
  }
}

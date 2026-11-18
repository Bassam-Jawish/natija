/**
 * Worklist cache: pending tubes per analyzer, refreshed from the platform every few seconds
 * and kept in the journal, so host queries are answered locally and instantly, even while
 * the internet link is down (up to worklistMaxAgeMinutes old).
 */
import type { AgentWorklistItem, AgentWorklistResponse } from '@natija/protocols';
import { ApiError, type ApiClient } from './api-client';
import type { Journal } from './journal';
import { logger } from './log';

const log = logger('worklist');

type Entry = { items: Map<string, AgentWorklistItem>; fetchedAt: Date | null; lastError: string | null };

export class WorklistCache {
  private readonly entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly api: ApiClient,
    private readonly journal: Journal,
    private readonly instruments: string[],
    private readonly everyMs: number,
    private readonly maxAgeMs: number,
  ) {
    for (const code of instruments) {
      const saved = journal.loadWorklist(code);
      const entry: Entry = { items: new Map(), fetchedAt: null, lastError: null };
      if (saved) {
        try {
          const data = JSON.parse(saved.json) as AgentWorklistResponse;
          for (const item of data.items) entry.items.set(item.barcode, item);
          entry.fetchedAt = saved.fetchedAt;
        } catch {
          // A corrupt cache row is ignored; the next refresh replaces it.
        }
      }
      this.entries.set(code, entry);
    }
  }

  start(): void {
    if (!this.instruments.length) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    if (this.busy || !this.api.hasToken) return;
    this.busy = true;
    try {
      for (const code of this.instruments) {
        const entry = this.entries.get(code)!;
        try {
          const data = await this.api.worklist(code);
          entry.items = new Map(data.items.map((i) => [i.barcode, i]));
          entry.fetchedAt = new Date();
          if (entry.lastError) log.info(`${code}: worklist refreshed again (${data.items.length} tube(s))`);
          entry.lastError = null;
          this.journal.saveWorklist(code, JSON.stringify(data), entry.fetchedAt);
        } catch (err) {
          const message = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
          if (entry.lastError !== message) log.warn(`${code}: worklist refresh failed (${message}); using the cached copy`);
          entry.lastError = message;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** The pending work for a tube, or null. `stale` when the cache is too old to trust. */
  lookup(instrument: string, barcode: string): { item: AgentWorklistItem | null; stale: boolean; ageMs: number | null } {
    const entry = this.entries.get(instrument);
    const ageMs = entry?.fetchedAt ? Date.now() - entry.fetchedAt.getTime() : null;
    const stale = ageMs === null || ageMs > this.maxAgeMs;
    return { item: entry?.items.get(barcode.trim()) ?? null, stale, ageMs };
  }

  snapshot(instrument: string): { fetchedAt: string | null; lastError: string | null; items: AgentWorklistItem[] } | null {
    const entry = this.entries.get(instrument);
    if (!entry) return null;
    return { fetchedAt: entry.fetchedAt?.toISOString() ?? null, lastError: entry.lastError, items: [...entry.items.values()] };
  }
}

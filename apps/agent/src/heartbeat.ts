import { hostname, platform, release } from 'node:os';
import { ApiError, type ApiClient } from './api-client';
import type { Journal } from './journal';
import { logger } from './log';
import type { InstrumentRunner } from './runner';
import { AGENT_VERSION } from './version';

const log = logger('heartbeat');

export type HeartbeatStatus = { lastOkAt: string | null; lastError: string | null; refused: string[] };

/** Every 30 s: tell the platform the agent is alive and how each analyzer link is doing. */
export class Heartbeat {
  readonly status: HeartbeatStatus = { lastOkAt: null, lastError: null, refused: [] };
  private timer: NodeJS.Timeout | null = null;
  private readonly started = Date.now();

  constructor(
    private readonly api: ApiClient,
    private readonly journal: Journal,
    private readonly runners: InstrumentRunner[],
    private readonly everyMs: number,
  ) {}

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async beat(): Promise<void> {
    if (!this.api.hasToken) return;
    const counts = this.journal.counts();
    try {
      const res = await this.api.heartbeat({
        version: AGENT_VERSION,
        hostInfo: { hostname: hostname(), platform: `${platform()} ${release()}`, node: process.version },
        uptimeSec: Math.round((Date.now() - this.started) / 1000),
        queue: { pending: counts.pending, failed: counts.failed, incomplete: counts.incomplete },
        instruments: this.runners.map((r) => ({
          code: r.status.code,
          state: r.status.state,
          detail: r.status.detail,
          connectedSince: r.status.connectedSince,
          lastMessageAt: r.status.lastMessageAt,
        })),
      });
      const refused = res.instruments.filter((i) => !i.accepted).map((i) => `${i.code} (${i.reason ?? 'refused'})`);
      if (refused.join() !== this.status.refused.join() && refused.length) log.warn(`the platform does not accept: ${refused.join(', ')}`);
      if (this.status.lastError) log.info('platform reachable again');
      this.status.refused = refused;
      this.status.lastOkAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (err) {
      const message = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      if (message !== this.status.lastError) log.warn(`heartbeat failed (${message}); analyzers keep working and messages stay queued`);
      this.status.lastError = message;
    }
  }
}

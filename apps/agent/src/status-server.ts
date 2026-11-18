/**
 * Local status endpoint for the lab's IT person and for the simulator, bound to 127.0.0.1:
 *   GET /status    agent, queue and per-analyzer link state
 *   GET /worklist?instrument=CODE   cached pending tubes (barcodes and test codes, no names)
 */
import http from 'node:http';
import type { Heartbeat } from './heartbeat';
import type { Journal } from './journal';
import { logger } from './log';
import type { InstrumentRunner } from './runner';
import type { Uploader } from './uploader';
import { AGENT_VERSION } from './version';
import type { WorklistCache } from './worklist';

const log = logger('status');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function startStatusServer(opts: {
  port: number;
  agentName: string;
  serverUrl: string;
  enrolled: () => boolean;
  runners: InstrumentRunner[];
  journal: Journal;
  worklist: WorklistCache;
  uploader: Uploader;
  heartbeat: Heartbeat;
}): http.Server {
  const started = Date.now();
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body, null, 2));
    };
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return send(403, { error: 'local access only' });
    if (req.method !== 'GET') return send(405, { error: 'GET only' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/status' || url.pathname === '/') {
      return send(200, {
        agent: {
          name: opts.agentName,
          version: AGENT_VERSION,
          serverUrl: opts.serverUrl,
          enrolled: opts.enrolled(),
          uptimeSec: Math.round((Date.now() - started) / 1000),
          heartbeat: opts.heartbeat.status,
          upload: opts.uploader.status,
        },
        queue: opts.journal.counts(),
        instruments: opts.runners.map((r) => {
          const wl = opts.worklist.snapshot(r.status.code);
          return { ...r.status, worklist: wl ? { fetchedAt: wl.fetchedAt, lastError: wl.lastError, tubes: wl.items.length } : null };
        }),
        recentMessages: opts.journal.recentMessages(20),
        notice: 'Natija Lab Agent. Analyzer integrations are at readiness level L0 (simulated) unless the lab has validated them.',
      });
    }
    if (url.pathname === '/worklist') {
      const code = url.searchParams.get('instrument');
      const codes = code ? [code] : opts.runners.map((r) => r.status.code);
      const out = codes.map((c) => ({ instrument: c, ...(opts.worklist.snapshot(c) ?? { fetchedAt: null, lastError: 'not configured', items: [] }) }));
      return send(code && !opts.worklist.snapshot(code) ? 404 : 200, code ? out[0] : out);
    }
    return send(404, { error: 'not found', endpoints: ['/status', '/worklist?instrument=CODE'] });
  });
  server.on('error', (err) => log.error(`status endpoint: ${err.message}`));
  server.listen(opts.port, '127.0.0.1', () => log.info(`status on http://127.0.0.1:${opts.port}/status`));
  return server;
}

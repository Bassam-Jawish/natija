import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = 'info';
let logDir: string | null = null;

/** Console logging plus one file per day under <dataDir>/logs (kept for troubleshooting on site). */
export function configureLog(opts: { level?: Level; dir?: string | null }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.dir) {
    mkdirSync(opts.dir, { recursive: true });
    logDir = opts.dir;
  }
}

function write(level: Level, scope: string, message: string): void {
  if (RANK[level] < RANK[minLevel]) return;
  const at = new Date();
  const line = `${at.toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  if (logDir) {
    try {
      appendFileSync(join(logDir, `agent-${at.toISOString().slice(0, 10)}.log`), `${line}\n`);
    } catch {
      // Logging must never stop the agent.
    }
  }
}

export type Logger = Record<Level, (message: string) => void>;

export function logger(scope: string): Logger {
  return {
    debug: (m) => write('debug', scope, m),
    info: (m) => write('info', scope, m),
    warn: (m) => write('warn', scope, m),
    error: (m) => write('error', scope, m),
  };
}

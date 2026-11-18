import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, PROFILES, type InstrumentModel, type ProtocolFamily, type TextEncoding } from '@natija/protocols';

export type InstrumentConfig = {
  /** Instrument code as set up in Natija (e.g. "XN550"). */
  code: string;
  /** Profile model, or "other" with an explicit protocol (generic ASTM / HL7). */
  model: InstrumentModel | 'other';
  protocol?: ProtocolFamily;
  /** tcp_server: the agent listens and the analyzer connects; tcp_client: the agent connects; serial: COM port. */
  transport: 'tcp_server' | 'tcp_client' | 'serial';
  /** tcp_server: address to listen on (default 127.0.0.1); tcp_client: analyzer address. */
  host?: string;
  port?: number;
  /** tcp_server only: analyzer IP addresses allowed to connect (empty = any). */
  allowFrom?: string[];
  serialPath?: string;
  baudRate?: number;
  dataBits?: 7 | 8;
  parity?: 'none' | 'even' | 'odd';
  stopBits?: 1 | 2;
  encoding?: TextEncoding;
  /** Text protocols: silence that ends a printout (ms). */
  textIdleMs?: number;
  enabled?: boolean;
};

export type AgentConfig = {
  /** Platform address, e.g. https://lab.example.org (the API is under /api/v1). */
  serverUrl: string;
  /** Long-lived agent token from `enroll`. Keep this file readable by the service account only. */
  token?: string | null;
  agentName?: string;
  /** Journal and logs; relative paths are relative to this file. Default: this file's folder. */
  dataDir?: string;
  /** Local status page (127.0.0.1 only). */
  statusPort?: number;
  heartbeatSeconds?: number;
  worklistSeconds?: number;
  /** Do not answer host queries from a worklist older than this (minutes). */
  worklistMaxAgeMinutes?: number;
  /** Print every frame and control character to the console/log. */
  logTraffic?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  instruments: InstrumentConfig[];
};

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = resolve(here, '..', 'data', 'agent.config.json');
export const EXAMPLE_CONFIG_PATH = resolve(here, '..', 'agent.config.example.json');

export function configPath(cli?: string): string {
  return resolve(cli ?? process.env.NATIJA_AGENT_CONFIG ?? DEFAULT_CONFIG_PATH);
}

export class ConfigError extends Error {}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ConfigError(message);
}

/** Read and validate the config file. */
export function loadConfig(file: string): AgentConfig {
  check(existsSync(file), `No config file at ${file}. Run "init" to create one from the example.`);
  let cfg: AgentConfig;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8')) as AgentConfig;
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  check(typeof cfg.serverUrl === 'string' && /^https?:\/\//.test(cfg.serverUrl), 'serverUrl must start with http:// or https://');
  check(Array.isArray(cfg.instruments), 'instruments must be a list');
  const codes = new Set<string>();
  const ports = new Set<string>();
  for (const i of cfg.instruments) {
    check(typeof i.code === 'string' && i.code.length > 0, 'every instrument needs a code');
    check(!codes.has(i.code), `instrument ${i.code} is listed twice`);
    codes.add(i.code);
    check(i.model === 'other' || (MODELS as string[]).includes(i.model), `${i.code}: unknown model "${i.model}" (one of ${MODELS.join(', ')}, other)`);
    check(i.model !== 'other' || !!i.protocol, `${i.code}: model "other" needs a protocol`);
    check(['tcp_server', 'tcp_client', 'serial'].includes(i.transport), `${i.code}: transport must be tcp_server, tcp_client or serial`);
    if (i.transport === 'serial') check(!!i.serialPath, `${i.code}: serial transport needs serialPath (e.g. COM3)`);
    else {
      const port = i.port ?? (i.model === 'other' ? undefined : PROFILES[i.model].defaultPort);
      check(Number.isInteger(port) && port! > 0 && port! < 65536, `${i.code}: a TCP port is required`);
      if (i.transport === 'tcp_client') check(!!i.host, `${i.code}: tcp_client needs the analyzer host`);
      if (i.transport === 'tcp_server' && i.enabled !== false) {
        const key = `${i.host ?? '127.0.0.1'}:${port}`;
        check(!ports.has(key), `${i.code}: port ${key} is used twice`);
        ports.add(key);
      }
    }
  }
  return cfg;
}

/** Write the config atomically (token updates must not leave a half-written file). */
export function saveConfig(file: string, cfg: AgentConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

export function dataDir(cfg: AgentConfig, file: string): string {
  const dir = cfg.dataDir ?? '.';
  return isAbsolute(dir) ? dir : join(dirname(file), dir);
}

export function protocolOf(i: InstrumentConfig): ProtocolFamily {
  return i.protocol ?? (i.model === 'other' ? 'astm' : PROFILES[i.model].protocol);
}

export function portOf(i: InstrumentConfig): number | null {
  return i.port ?? (i.model === 'other' ? null : PROFILES[i.model].defaultPort);
}

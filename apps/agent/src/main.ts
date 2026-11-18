/**
 * Natija Lab Agent — runs on a PC in the lab, next to the analyzers.
 *
 *   pnpm agent init                       write data/agent.config.json from the example
 *   pnpm agent enroll --server URL --code XXXX-XXXX [--name "Bench PC"]
 *   pnpm agent run                        (default) talk to the analyzers, upload results
 *   pnpm agent status                     print the local status page
 *
 * Options: --config <file> (or env NATIJA_AGENT_CONFIG).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiClient, ApiError } from './api-client';
import { ConfigError, configPath, dataDir, EXAMPLE_CONFIG_PATH, loadConfig, saveConfig, type AgentConfig } from './config';
import { Heartbeat } from './heartbeat';
import { Journal } from './journal';
import { configureLog, logger } from './log';
import { InstrumentRunner } from './runner';
import { startStatusServer } from './status-server';
import { Uploader } from './uploader';
import { AGENT_VERSION } from './version';
import { WorklistCache } from './worklist';

const log = logger('agent');

// `pnpm agent -- run` passes the "--" through; drop it so options parse normally.
const argv = process.argv.slice(2).filter((a) => a !== '--');
const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    server: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const command = positionals[0] ?? 'run';
const file = configPath(values.config);

const HELP = `Natija Lab Agent ${AGENT_VERSION}

  init                         create ${file} from the example
  enroll --server URL --code CODE [--name NAME]
                               exchange a one-time enrollment code for the agent token
  run                          connect to the analyzers and upload results (default)
  status                       print the local status page

  --config FILE                config file (default: ${file})`;

async function init(): Promise<void> {
  if (existsSync(file)) {
    console.log(`${file} already exists; edit it instead.`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(EXAMPLE_CONFIG_PATH, file);
  console.log(`Created ${file}. Set serverUrl and the instruments, then run "enroll".`);
}

async function enroll(): Promise<void> {
  if (!values.code) throw new ConfigError('enroll needs --code (shown once when the agent is created in Natija → Analyzers → Lab Agents)');
  let cfg: AgentConfig;
  if (existsSync(file)) cfg = loadConfig(file);
  else {
    if (!values.server) throw new ConfigError(`no config at ${file}; pass --server or run "init" first`);
    cfg = { serverUrl: values.server, instruments: [] };
  }
  if (values.server) cfg.serverUrl = values.server;
  const api = new ApiClient(cfg.serverUrl, null);
  const res = await api.enroll({
    code: values.code,
    name: values.name ?? hostname(),
    version: AGENT_VERSION,
    hostInfo: { hostname: hostname(), platform: `${platform()} ${release()}`, node: process.version },
  });
  cfg.token = res.token;
  cfg.agentName = res.agent.name;
  saveConfig(file, cfg);
  console.log(`Enrolled as "${res.agent.name}" for ${res.lab.nameEn} (${res.lab.code}). The token is saved in ${file}.`);
  console.log('Keep that file readable by the service account only: the token lets anyone post results for this lab.');
}

async function status(): Promise<void> {
  const cfg = loadConfig(file);
  const port = cfg.statusPort ?? 7300;
  const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res) {
    console.log(`The agent is not running (nothing on http://127.0.0.1:${port}/status).`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function run(): Promise<void> {
  const cfg = loadConfig(file);
  const dir = dataDir(cfg, file);
  configureLog({ level: cfg.logLevel ?? 'info', dir: join(dir, 'logs') });
  log.info(`Natija Lab Agent ${AGENT_VERSION} starting (config ${file})`);
  log.info('Readiness L0: these analyzer integrations are simulated/built to research notes and not yet validated on real analyzers.');

  const journal = new Journal(join(dir, 'journal.sqlite'));
  for (const r of journal.recoverFrames()) {
    log.warn(`${r.instrument}: recovered a transmission left in the frame journal (${r.complete} complete, ${r.incomplete} incomplete message(s))`);
  }
  const api = new ApiClient(cfg.serverUrl, cfg.token ?? null);
  if (!cfg.token) log.warn('not enrolled yet: analyzer traffic is journaled locally and uploaded after "enroll"');

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const enabled = cfg.instruments.filter((i) => i.enabled !== false);
  const worklist = new WorklistCache(
    api,
    journal,
    enabled.map((i) => i.code),
    (cfg.worklistSeconds ?? 5) * 1000,
    (cfg.worklistMaxAgeMinutes ?? 720) * 60_000,
  );
  const uploader = new Uploader(journal, api);
  const runners = cfg.instruments.map((i) => new InstrumentRunner(i, { journal, worklist, uploader, logTraffic: cfg.logTraffic ?? false, timeZone }));
  const heartbeat = new Heartbeat(api, journal, runners, (cfg.heartbeatSeconds ?? 30) * 1000);

  for (const r of runners) r.start();
  uploader.start();
  worklist.start();
  heartbeat.start();
  const statusServer = startStatusServer({
    port: cfg.statusPort ?? 7300,
    agentName: cfg.agentName ?? hostname(),
    serverUrl: cfg.serverUrl,
    enrolled: () => api.hasToken,
    runners,
    journal,
    worklist,
    uploader,
    heartbeat,
  });
  const pruneTimer = setInterval(() => {
    const n = journal.prune(30);
    if (n) log.info(`pruned ${n} uploaded message(s) older than 30 days`);
  }, 6 * 3_600_000);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: stopping (journal is closed cleanly; unsent messages are kept)`);
    clearInterval(pruneTimer);
    heartbeat.stop();
    worklist.stop();
    uploader.stop();
    statusServer.close();
    await Promise.allSettled(runners.map((r) => r.stop()));
    journal.close();
    // Let the event loop drain (process.exit() while sockets close can abort on Windows);
    // the unref'd timer only forces the exit if something keeps the loop alive.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  // Windows: NSSM / WinSW send Ctrl+Break or close the console.
  process.on('SIGBREAK', () => void stop('SIGBREAK'));
}

async function main(): Promise<void> {
  if (values.help || command === 'help') {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'init':
      return init();
    case 'enroll':
      return enroll();
    case 'status':
      return status();
    case 'run':
      return run();
    default:
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(`Config: ${err.message}`);
  else if (err instanceof ApiError) console.error(`Platform: ${err.code} ${err.message}`);
  else console.error(err);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 5_000).unref();
});

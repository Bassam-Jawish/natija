/**
 * Natija analyzer simulator: plays one analyzer against the Lab Agent over TCP, speaking the
 * analyzer's protocol family for real (ENQ/ACK frames with checksums for ASTM, MLLP + HL7
 * acknowledgements, raw text for printout-style analyzers). Every frame is printed.
 *
 *   pnpm simulate -- --instrument sysmex_xn --mode abnormal --barcode 261117-0042-01
 *   pnpm simulate -- --instrument E411 --from-worklist --query
 *   pnpm simulate -- --instrument cobas_pure --from-worklist --fault duplicate
 *
 * SIMULATED traffic only (readiness level L0): it shows how Natija handles each protocol,
 * not that any analyzer has been integrated.
 */
import { parseArgs } from 'node:util';
import {
  ICHROMA_DEMO_NOTICE,
  parseHostOrders,
  PROFILES,
  seededRandom,
  simulateQuery,
  simulateResults,
  unmappedCodeFor,
  type InstrumentModel,
  type SimMode,
  type SimSpecimen,
} from '@natija/protocols';
import { agentInstruments, agentWorklist, endpointAddress, isModel } from './agent-lookup';
import { openLink, say, type Fault } from './link';

const FAULTS: Fault[] = ['none', 'duplicate', 'bad-checksum', 'unknown-code', 'unknown-sample', 'drop-mid-message', 'late-ack'];

const HELP = `Natija analyzer simulator (simulated traffic, readiness L0)

  --instrument X     model (${Object.keys(PROFILES).join(', ')})
                     or an instrument code configured in the Lab Agent (e.g. XN550)
  --mode M           normal | abnormal | critical (default normal)
  --barcode B        tube barcode; repeat or comma-separate for several tubes
  --from-worklist    take pending tubes from the Lab Agent's /worklist
  --count N          how many worklist tubes (default 1)
  --tests A,B        instrument test codes to report (default: the worklist's, else the first 5 of the menu)
  --query            ask the host for the work first (host query), then run what it answered
  --qc [--level L1]  send QC results (sample ID QC-<level>) instead of patient results
  --fault F          ${FAULTS.join(' | ')}
  --host H --port P  where the Lab Agent listens for this analyzer (default: from the agent, else the profile port)
  --listen           act as a TCP server and wait for the agent (analyzers the agent connects to)
  --agent URL        the agent's local status page (default http://127.0.0.1:7300)
  --seed N           repeat a run exactly
  --quiet            do not print every frame`;

const argv = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args: argv,
  options: {
    instrument: { type: 'string', short: 'i' },
    mode: { type: 'string', default: 'normal' },
    barcode: { type: 'string', multiple: true },
    'from-worklist': { type: 'boolean' },
    count: { type: 'string', default: '1' },
    tests: { type: 'string' },
    query: { type: 'boolean' },
    qc: { type: 'boolean' },
    level: { type: 'string', default: 'L1' },
    fault: { type: 'string', default: 'none' },
    host: { type: 'string' },
    port: { type: 'string' },
    listen: { type: 'boolean' },
    agent: { type: 'string', default: 'http://127.0.0.1:7300' },
    seed: { type: 'string' },
    quiet: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (values.help || !values.instrument) {
    console.log(HELP);
    if (!values.help) process.exitCode = 2;
    return;
  }
  const mode = values.mode as SimMode;
  if (!['normal', 'abnormal', 'critical'].includes(mode)) fail(`--mode must be normal, abnormal or critical`);
  const fault = values.fault as Fault;
  if (!FAULTS.includes(fault)) fail(`--fault must be one of ${FAULTS.join(', ')}`);

  // Which analyzer, and where does the agent listen for it?
  const agentList = await agentInstruments(values.agent!);
  let model: InstrumentModel;
  let code: string | null = null;
  let endpoint: { host: string; port: number } | null = null;
  if (isModel(values.instrument)) {
    model = values.instrument;
    const hit = agentList?.find((i) => i.model === model);
    if (hit) {
      code = hit.code;
      endpoint = endpointAddress(hit.endpoint);
    }
  } else {
    const hit = agentList?.find((i) => i.code.toLowerCase() === values.instrument!.toLowerCase());
    if (!hit) fail(`"${values.instrument}" is neither a model nor an instrument known to the agent at ${values.agent}`);
    if (!isModel(hit.model)) fail(`${hit.code} has model "${hit.model}", which has no simulator`);
    model = hit.model;
    code = hit.code;
    endpoint = endpointAddress(hit.endpoint);
  }
  const profile = PROFILES[model];
  const host = values.host ?? endpoint?.host ?? '127.0.0.1';
  const port = Number(values.port ?? endpoint?.port ?? profile.defaultPort);
  const seed = values.seed ? Number(values.seed) : Math.floor(Math.random() * 2 ** 31);
  const rnd = seededRandom(seed);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const textOnly = profile.protocol === 'medica_text' || profile.protocol === 'ichroma_invented';

  console.log(`Simulating ${profile.name} (${profile.protocol}, research confidence ${profile.confidence}) — SIMULATED, readiness L0`);
  if (model === 'ichroma3') console.log(`NOTE: ${ICHROMA_DEMO_NOTICE}`);
  if (model === 'medica_easystat') console.log('NOTE: the printout layout is an assumption to confirm against a real EasyStat printout.');
  if (profile.transport === 'serial') console.log(`(${profile.name} is RS-232 on site; here it talks TCP as if through a serial device server.)`);

  // Which tubes and tests?
  let specimens: SimSpecimen[] = [];
  const testOverride = values.tests?.split(',').map((t) => t.trim()).filter(Boolean);
  if (values.qc) {
    specimens = [{ sampleId: `QC-${values.level}`, isQc: true, tests: testOverride ?? profile.tests.slice(0, 3).map((t) => t.code) }];
  } else if (values.barcode?.length) {
    specimens = values.barcode.flatMap((b) => b.split(',')).map((b) => ({ sampleId: b.trim(), tests: testOverride }));
  } else if (values['from-worklist']) {
    if (!code) fail(`the agent at ${values.agent} is not reachable or has no ${model} configured; pass --barcode instead`);
    const wl = await agentWorklist(values.agent!, code);
    if (!wl?.items.length) fail(`no pending tubes for ${code} in the agent's worklist${wl?.fetchedAt ? ` (fetched ${wl.fetchedAt})` : ''}`);
    specimens = wl.items.slice(0, Number(values.count)).map((i) => ({ sampleId: i.barcode, tests: testOverride ?? i.tests.map((t) => t.code), sex: i.sex, birthDate: i.birthDate }));
  } else if (fault !== 'unknown-sample') {
    fail('pass --barcode, --from-worklist or --qc');
  }
  if (fault === 'unknown-sample') specimens = [{ sampleId: `999999-${1000 + Math.floor(rnd() * 9000)}-99`, tests: testOverride ?? specimens[0]?.tests }];
  for (const s of specimens) if (!s.tests?.length) s.tests = profile.tests.slice(0, 5).map((t) => t.code);
  if (profile.specimenIdMax) {
    const long = specimens.find((s) => s.sampleId.length > profile.specimenIdMax!);
    if (long) fail(`${profile.name} accepts specimen IDs up to ${profile.specimenIdMax} characters ("${long.sampleId}")`);
  }

  const wantQuery = !!values.query || fault === 'late-ack';
  if (wantQuery && !profile.bidirectional) {
    if (fault === 'late-ack') fail(`late-ack needs host-to-analyzer traffic; ${profile.name} sends results only`);
    fail(`${profile.name} does not query the host (results only)`);
  }
  if (fault === 'bad-checksum' && profile.protocol !== 'astm' && profile.protocol !== 'hl7') fail(`${profile.protocol} has no checksum or acknowledgement`);

  const link = await openLink({ protocol: profile.protocol, host, port, listen: !!values.listen, fault, quiet: !!values.quiet, lateAckMs: 16_000, dropAfterFrames: 2 });

  // 1. Host query: ask for the work, run what the host answers.
  if (wantQuery && !values.qc) {
    const asked = specimens.map((s) => s.sampleId);
    say(`host query for ${asked.join(', ')}`);
    const query = simulateQuery({ model, sampleIds: model === 'cobas_pure' || model === 'mindray_bs430' ? asked.slice(0, 1) : asked, timeZone });
    const sent = await link.session.send(query);
    if (!sent.ok) say(`query not acknowledged: ${sent.error}`);
    const answered = new Map<string, string[]>();
    for (let i = 0; i < 3; i++) {
      const reply = await link.nextMessage(fault === 'late-ack' ? 40_000 : 20_000);
      if (!reply) break;
      const orders = parseHostOrders(model, reply);
      for (const o of orders) {
        say(o.found ? `host asks for ${o.sampleId}: ${o.tests.join(', ')}${o.priority === 'stat' ? ' (STAT)' : ''}` : `host has no work for ${o.sampleId || 'this sample'}`);
        if (o.found) answered.set(o.sampleId, o.tests);
      }
      // ASTM answers in one message. HL7 answers RSP^K11 / QCK^Q02 first ("not found" ends it),
      // then the orders arrive as OML^O33 / DSR^Q03.
      if (profile.protocol === 'astm' || orders.length) break;
    }
    if (fault === 'late-ack') {
      say('late-ack run done: see the agent log for its 15 s timeout and EOT/abort handling');
      await sleep(17_000);
      await link.close();
      return;
    }
    specimens = specimens.filter((s) => answered.has(s.sampleId)).map((s) => ({ ...s, tests: testOverride ?? answered.get(s.sampleId) }));
    if (!specimens.length) {
      say('nothing to run');
      await link.close();
      return;
    }
  }

  // 2. Results.
  const extraCodes = fault === 'unknown-code' ? [unmappedCodeFor(model, rnd)] : [];
  if (extraCodes.length) say(`unknown-code: adding ${extraCodes[0]} (not in the code map) to ${specimens[0]!.sampleId}`);
  const messages = simulateResults({ model, specimens, mode, seed, timeZone, extraCodes });
  const queue = messages.map((m) => m.raw);
  if (fault === 'duplicate') queue.splice(1, 0, queue[0]!);
  for (const [i, m] of messages.entries()) {
    say(`${m.sampleId}: ${m.values.map((v) => `${v.code}=${v.value}${v.unit ? ` ${v.unit}` : ''}${v.flag !== 'N' ? ` ${v.flag}` : ''}`).join(', ')}${i === 0 && fault === 'duplicate' ? ' (will be sent twice)' : ''}`);
  }
  if (fault === 'bad-checksum' && profile.protocol === 'hl7') {
    say('bad-checksum: HL7 over MLLP has no checksum; sending a message with broken delimiters first (the agent must answer AR)');
    const broken = queue[0]!.replace(/^MSH\|\^~\\&/, 'MSH|^^\\&');
    const r = await link.session.send(broken);
    say(r.ok ? 'the agent accepted the broken message?!' : `refused as expected (${r.error})`);
  }
  for (const [i, raw] of queue.entries()) {
    // Unframed text has no message boundary but silence: leave a gap so a repeat is a second message.
    if (i > 0 && textOnly) await sleep(3_000);
    const r = await link.session.send(raw);
    if (textOnly) say('sent (this format has no acknowledgement)');
    else say(r.ok ? 'delivered and acknowledged' : `not delivered: ${r.error}`);
    if (fault === 'drop-mid-message') break;
  }

  // Text protocols have no acknowledgement: stay connected past the agent's idle gap so it closes the printout.
  if (textOnly) {
    if (fault !== 'drop-mid-message') {
      say('waiting 3 s so the agent sees the end of the printout');
      await sleep(3_000);
    }
  } else {
    await link.session.idle();
  }
  await link.close();
  say(`done (seed ${seed}). Check the agent log and Natija → Analyzers → ${code ?? model} → Messages.`);
}

// No process.exit() on the normal path: on Windows it can abort while sockets are still closing.
main()
  .catch((err: unknown) => {
    console.error(`simulator: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  })
  .finally(() => {
    // Safety net only; normally the event loop is already empty here.
    setTimeout(() => process.exit(), 5_000).unref();
  });

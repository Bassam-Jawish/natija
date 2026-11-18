# Natija Lab Agent

A small service that runs on a PC in the lab, next to the analyzers. It speaks each analyzer's protocol (ASTM E1381/E1394, HL7 v2 over MLLP, Medica printout text), writes everything to a journal on disk **before** acknowledging it, uploads results to Natija over HTTPS (outbound only), and answers analyzers' host queries from a local worklist cache, so the bench keeps working when the internet does not.

> **Honesty statement.** Every analyzer integration is at readiness level **L0 (simulated)**: it has been exercised with Natija's simulators only, never with a real analyzer. Moving an analyzer to L1–L3 needs its vendor manual, a bench test and the lab's validation (see `docs/analyzers.md`). Do not tell a lab that an analyzer "is integrated" before L3.

## Requirements

- Windows 10/11 (or any OS that runs Node), Node.js **24.7+** (uses the built-in `node:sqlite`).
- This repository (or a copy of `apps/agent` and `packages/protocols` with dependencies installed: `pnpm install`).
- For analyzers on a COM port: the optional `serialport` package (native module; installed with the agent's optional dependencies). TCP-only sites do not need it.

## Quick start (demo, with the simulator)

```bash
pnpm agent init                                   # writes apps/agent/data/agent.config.json from the example
# In Natija: Analyzers → Lab Agents → New agent → copy the 8-character code (shown once, valid 24 h)
pnpm agent enroll --server http://localhost:4310 --code ABCD-2345
pnpm agent run                                    # or just: pnpm agent
pnpm simulate -- --instrument sysmex_xn --from-worklist --mode abnormal
```

`pnpm agent status` (or <http://127.0.0.1:7300/status>) shows the link of each analyzer, the upload queue and the worklist cache.

## Configuration (`agent.config.json`)

| Field | Meaning |
| --- | --- |
| `serverUrl` | Natija address, e.g. `https://lab.example.org` |
| `token` | Written by `enroll`. A secret: anyone with it can post results for this lab |
| `dataDir` | Journal and logs (relative to the config file; default its folder) |
| `statusPort` | Local status page, bound to 127.0.0.1 (default 7300) |
| `heartbeatSeconds`, `worklistSeconds` | Default 30 and 5 |
| `worklistMaxAgeMinutes` | Older cache → host queries get "no work" (default 720) |
| `logTraffic` | Log every frame and control character (good for commissioning) |
| `instruments[]` | One entry per analyzer, see below |

Per analyzer: `code` (the instrument code in Natija), `model` (`sysmex_xn`, `cobas_e411`, `cobas_pure`, `mindray_bs430`, `medica_easystat`, `ichroma3`, or `other` with `protocol`), `transport`:

- `tcp_server`: the agent listens on `host:port`; the analyzer (or a serial device server in TCP-client mode) connects. Use the PC's LAN address or `0.0.0.0` for real analyzers, and `allowFrom: ["192.168.10.21"]` to accept only the analyzer's IP.
- `tcp_client`: the agent connects to the analyzer (`host`, `port`), e.g. a cobas pure in server mode, or a serial device server in TCP-server mode.
- `serial`: `serialPath` (`COM3`), `baudRate`, `dataBits`, `parity`, `stopBits` (defaults from the model: e 411 9600 8N1, Medica 2400 8N1).

Also: `encoding` (`latin1` for ASTM by default, `utf8` for HL7), `textIdleMs` (silence that ends a printout, default 2500), `enabled`.

## What happens to data

- **ASTM**: each frame is stored before its ACK. If storing fails the frame is NAKed and the analyzer retransmits. At EOT the frames become messages (one per H…L) and are removed. A transmission that never finished (power cut, cable pulled) is rebuilt at the next start: finished messages are uploaded normally, the rest as *incomplete* (stored by Natija for review, never applied).
- **HL7**: each message is stored before the ACK (`MSA-1 AA`); a message that cannot be read is answered `AR`.
- **Printout text**: no acknowledgement exists; the printout is stored when the analyzer goes quiet.
- **Upload**: batches of up to 20 messages, SHA-256 of the raw text as idempotency key, exponential backoff (2 s … 5 min) while the platform is unreachable. Uploaded messages are pruned from the journal after 30 days (the platform keeps them).
- **Host queries**: answered locally from the cached worklist (barcode, priority, sex, birth date, test codes; never patient names). Every answer is logged in the journal (`outbound` table).

## Run as a Windows service

Use a service wrapper; the agent stops cleanly on Ctrl+C / Ctrl+Break and keeps unsent messages in the journal.

**NSSM** (<https://nssm.cc>), from an administrator prompt:

```bat
nssm install NatijaAgent "C:\Program Files\nodejs\node.exe"
nssm set NatijaAgent AppParameters "C:\natija\node_modules\tsx\dist\cli.mjs C:\natija\apps\agent\src\main.ts run --config C:\ProgramData\Natija\agent.config.json"
nssm set NatijaAgent AppDirectory C:\natija\apps\agent
nssm set NatijaAgent AppStdout C:\ProgramData\Natija\service.log
nssm set NatijaAgent AppStderr C:\ProgramData\Natija\service.log
nssm set NatijaAgent AppStopMethodConsole 10000
nssm set NatijaAgent Start SERVICE_AUTO_START
nssm start NatijaAgent
```

**WinSW** (<https://github.com/winsw/winsw>): put `NatijaAgent.exe` and this `NatijaAgent.xml` side by side, then `NatijaAgent.exe install`:

```xml
<service>
  <id>NatijaAgent</id>
  <name>Natija Lab Agent</name>
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>C:\natija\node_modules\tsx\dist\cli.mjs C:\natija\apps\agent\src\main.ts run --config C:\ProgramData\Natija\agent.config.json</arguments>
  <workingdirectory>C:\natija\apps\agent</workingdirectory>
  <stoptimeout>10 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/>
  <log mode="roll-by-size"/>
</service>
```

Run the service under a dedicated local account and restrict the config folder, which holds the token:

```bat
icacls C:\ProgramData\Natija /inheritance:r /grant:r "NT SERVICE\NatijaAgent:(OI)(CI)M" /grant:r Administrators:(OI)(CI)F
```

## Hardware notes

- **Serial (RS-232)**: USB-to-RS-232 adapters with FTDI chips are the most reliable on Windows; note the COM number in Device Manager and fix it. Check whether the analyzer needs a straight or null-modem cable (Roche e 411: ask Roche; Medica: use Medica's cable). RS-232 is reliable to about 15 m.
- **Serial device servers** (e.g. Moxa NPort): put the analyzer on the network. In *TCP client* mode it connects to the agent (`tcp_server`); in *TCP server* mode the agent connects to it (`tcp_client`). Match the serial settings exactly (e 411 9600 8N1, Medica 2400 8N1).
- **Network analyzers** (cobas pure, Sysmex XN, Mindray): give the analyzer and the agent PC static addresses, ideally on a separate VLAN; allow inbound connections to the agent's ports only from analyzer IPs (Windows firewall plus `allowFrom`); the agent only needs outbound HTTPS to Natija.
- **Power and time**: put the agent PC and the network switch on the analyzer UPS; keep Windows time synchronised (timestamps from analyzers are read in the lab's time zone).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `port … is already in use` | Another program (or a second agent) listens there; change `port` |
| Analyzer never connects | IP/port on the analyzer, firewall, `allowFrom`, cable, serial settings |
| `the platform refused the agent token` | The agent was revoked or re-enrolled; enroll again with a new code |
| Uploads failing | `status` page → `upload.lastError`; messages stay queued and are retried |
| Host queries answered "no work" | Worklist age on the status page; is the tube collected and are its tests mapped to this analyzer? |
| `serialport package is not installed` | `pnpm install` in the repository (optional dependency with a native build) |

Logs: `<dataDir>/logs/agent-YYYY-MM-DD.log`. With `logTraffic: true` every frame is logged with `→` (agent to analyzer) and `←` (analyzer to agent).

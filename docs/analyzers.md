# Analyzer integration

> **Honesty statement.** Every analyzer integration in Natija is at readiness level **L0 (simulated)**. None of them has been connected to, or tested against, a real analyzer. The protocol code follows the research below: some of it comes from manufacturer manuals (verified), some from secondary sources (likely), and for one analyzer no specification exists at all (unknown). Natija must never present an analyzer as "integrated" until it reaches L3 in that lab.

## Readiness levels

| Level | Name | Meaning | How an analyzer gets there |
| --- | --- | --- | --- |
| L0 | Simulated | Demo traffic only, from Natija's simulators | The default for every instrument |
| L1 | Built to spec | Implemented from the vendor's host-interface manual for that model and software version | Get the manual, check every field position used below, fix the dialect, add tests from the manual's examples |
| L2 | Bench-tested | Tested against a real analyzer, outside patient work | Run each message type (results, QC, query, download) and each fault (cable pulled, analyzer off, bad barcode) on site |
| L3 | In service | Validated by the lab and used for patient results | Parallel run against manual entry, documented comparison, sign-off by the lab director |

The level is stored per instrument (`instruments.integration_level`), shown in the UI with these labels (`INTEGRATION_LEVEL_LABELS` in `packages/contracts/src/instruments.ts`), and changing it is audited.

## Summary

| Analyzer | Connection | Protocol | Direction | Confidence | Level |
| --- | --- | --- | --- | --- | --- |
| Roche cobas pure | Ethernet | HL7 v2.5 over MLLP, IHE LAW | Bidirectional: query + download | Verified | L0 |
| Roche cobas e 411 | RS-232 (DB-9), 9600 8N1 | ASTM E1381 / E1394 | Bidirectional: query + download | Verified | L0 |
| Sysmex XN-L / XN (XN-550) | LAN (analyzer connects to host) or RS-232 | ASTM E1381 / E1394 | Bidirectional: query | Likely | L0 |
| Mindray BS-430 | LAN (analyzer connects to host) | HL7 v2.3.1 over MLLP (or ASTM) | Bidirectional: query | Likely | L0 |
| Medica EasyStat / EasyBloodGas | RS-232, 2400 8N1, Medica cable | Printout text, no framing | Results only | Verified (layout assumed) | L0 |
| Boditech ichroma III | Unknown | **No public specification** (demo uses an invented format) | Unknown | Unknown | L0 |

## How a result travels

```
Analyzer ──RS-232 / TCP──► Lab Agent (lab PC) ──HTTPS, outbound only──► /api/v1/agent/messages ──► ingest ──► results engine
            link layer        journal on disk                               (SHA-256 dedup)          │
            ACK/NAK           outbox + retries                                                       ├─► review queue (anything not applied)
            host queries ◄──  worklist cache ◄── GET /api/v1/agent/worklist                          └─► QC runs (control specimens)
```

1. **Link layer** (`packages/protocols`): ASTM E1381 frames with checksums and ENQ/ACK/NAK/EOT, HL7 over MLLP with acknowledgements, or raw text for printout analyzers.
2. **Journal before acknowledgement** (Lab Agent): an ASTM frame is written to SQLite before its ACK; an HL7 message before its ACK; a printout when it ends. Writes use `synchronous=FULL`. If the write fails the frame is NAKed and the analyzer keeps the data.
3. **Upload** with the SHA-256 of the raw text as idempotency key; the agent retries with backoff and keeps everything while the internet is down.
4. **Ingest** (`apps/api/src/services/ingest.ts`), for every message, agent or simulated:
   - store it; the same content for the same instrument twice is a **duplicate**: logged, never applied again;
   - parse it with the model's dialect; unreadable → status `error`;
   - find the tube by barcode, map each instrument code to an analyte (`instrument_mappings`), find the pending result on that tube's order line, convert with the map's `unit_factor`, and write it through `applyResultValue()` (flags, reference range, delta check, critical alerts, audit);
   - mark received/collected tubes `in_analysis`, refresh order status, mark the instrument online, publish a live event.
5. **Nothing is dropped silently.** A value that cannot be applied safely becomes a review item:

| Reason | When |
| --- | --- |
| `unknown_sample` | No tube with that barcode, or the analyzer sent no sample ID |
| `unknown_code` | No active code mapping for the instrument code |
| `unit_mismatch` | The unit sent differs from the mapping's instrument unit: never converted silently |
| `no_order_item` | The analyte is not ordered on that tube (including "ordered on another tube of the order": a value measured in one specimen never lands on a test planned for another) |
| `sample_rejected` | The tube was rejected |
| `result_locked` | The result is already validated or released; the value is kept as an attempt only |

   A reviewer assigns the value to a result (through the same results engine, audited; optionally remembering a new code mapping) or dismisses it with a note. Values the analyzer itself marks "cannot be done" (ASTM `R.9` / HL7 `OBX-11` = `X`) and empty values are not written; the test stays pending and the message shows why.
6. **QC**: control specimens (ASTM action code `Q`, LAW `SPM-11 = Q`, Mindray `MSH-16 = 2`) become `qc_runs` for the matching active QC material (same analyte, this analyzer preferred, lot/level matched against the control ID) and are judged with the Westgard rules; a rejected run notifies everyone with `instruments.manage`.

Message statuses: `processed` (all applied), `partial` (some to review), `unmatched` (nothing applied), `duplicate`, `error` (unreadable, incomplete or failed).

## The Lab Agent

A Node.js service on a Windows PC in the lab (`apps/agent`, install notes in `apps/agent/README.md`).

- **Transports** per analyzer: TCP server (the analyzer, or a serial device server in TCP-client mode, connects to the agent; optional `allowFrom` IP list), TCP client (the agent connects to the analyzer or to a serial device server in TCP-server mode), or a local COM port through the optional `serialport` package.
- **Protocols**: the same link layers as the simulators. The agent is always the host (LIS) side.
- **Journal**: `journal.sqlite` (built-in `node:sqlite`): frames, messages/outbox, outbound replies, worklist cache. After a crash, frames of an unfinished ASTM transmission are rebuilt: messages that reached their L record are uploaded, the rest is uploaded as *incomplete* (stored for review with status `error`, never applied).
- **Host queries** are answered locally from a worklist cache refreshed every 5 s (`GET /api/v1/agent/worklist`), so analyzers get their orders instantly and while the internet is down (up to `worklistMaxAgeMinutes`, default 12 h; older → "no work"). The worklist carries barcode, priority, sex, birth date and instrument test codes — no patient names.
- **Heartbeat** every 30 s with each link's state. The platform marks an instrument online when its link is up or traffic arrived in the last 5 minutes; a background job marks instruments behind a real agent offline after 5 silent minutes.
- **Status page** on `http://127.0.0.1:7300/status` and `/worklist` (loopback only).
- **Enrollment**: an admin creates the agent in Natija and gets an 8-character one-time code (24 hours; only a keyed hash is stored). `pnpm agent enroll --server URL --code XXXX-XXXX` exchanges it for a long-lived token (only its hash is stored on the server). Revoking the agent stops the token at once.

## Simulators

Two ways to produce traffic without an analyzer. Both are labelled simulated everywhere (messages carry `is_simulated`).

Values are drawn per test from the model's normal, abnormal or critical span. A simulated blood count is then made consistent, as a real analyzer's is: the differential adds up to 100 %, absolute counts follow the WBC, and HCT, RBC and MCH follow from HGB, MCV and MCHC. Other panels stay independent draws, so the demo seed uses its own coherent values for lipids, bilirubins, proteins, PT/INR and blood gas.

- **In the platform**: `POST /api/v1/instruments/:id/simulate` builds messages for the instrument's model, runs them through the real link layer in memory (frames, checksums, ACK/NAK, MLLP acknowledgements) and ingests what the host side received, through the per-lab "Virtual Lab Agent (demo)". The response shows the wire trace, the raw messages, the parsed records and the outcome of every value. Faults: `duplicate`, `bad_checksum` (ASTM: every attempt of frame 2 fails, the host NAKs 7 times, the analyzer gives up, nothing is applied and the partial message is stored with status `error`; HL7 has no checksum, so a message with broken delimiters is sent and refused with MSA-1 `AR`), `unknown_code`, `unknown_sample`. Option `qc: true` sends QC results for the analyzer's QC materials.
- **CLI** (`apps/simulator`, see its README): plays one analyzer against a running Lab Agent over TCP, including host queries and faults the in-platform simulator cannot show: `drop-mid-message` (connection cut before EOT) and `late-ack` (the analyzer answers after the agent's 15-second timeout).

## Per-analyzer notes

Field references: ASTM `R.4` = field 4 of the R record (E1394 numbering, field 1 is the record type); HL7 `OBX-5` = field 5 of OBX. Code: `packages/protocols/src/normalize.ts` (reading), `simulate.ts` (writing).

### Roche cobas pure (c 303 / e 402 / ISE) — HL7 v2.5, IHE LAW

**Verified (manufacturer manual):** Ethernet. HL7 v2.5 over MLLP (`<VT>` message `<FS><CR>`), UTF-8, IHE Laboratory Analytical Workflow message set. Results: `OUL^R22`, acknowledged with `ACK`. Order query: `QBP^Q11` → `RSP^K11`, then the orders as `OML^O33` → `ORL^O34`. Batch download: `OML^O33`. The analyzer can be TCP client or server; default port 54000. `OBX-3` is the application code or host code, `OBX-6` the unit, `OBX-8` the abnormal flags (H/N/L). `SPM` and `SAC` carry the sample and container IDs.

**How Natija reads it:** `SPM-2.1` specimen ID (fallback `SAC-3`); `SPM-11 = Q` marks a control; OBX segments after an OBR are results (`OBX-3.1` code, `OBX-5` value with NM, SN and CE/CWE handled, `OBX-6.1` unit, `OBX-8` flags, `OBX-11` status, `OBX-19` or `OBX-14` time); OBX directly under SPM are specimen observations (kept as comments); `TCD-2` dilution. Query: `QPD-3` container ID. Reply: `RSP^K11` with `QAK-2 = OK/NF`, then `OML^O33` with PID (sex and birth date only), SPM, SAC and ORC/TQ1/OBR per test (`TQ1-9 = S` for STAT).

**To confirm before L1:** IHE profile IDs and query name Roche expects (we send `LAB-27/28/29`), whether `SPM-2` or `SAC-3` is authoritative, which OBX segments besides the result the analyzer adds (they would land in review as unknown codes until mapped), calibrator/QC `SPM-11` values, `MSH-3..6` values, reruns and corrected results (`OBX-11 = C`), and whether PID-5 may stay empty.

### Roche cobas e 411 — ASTM E1381 / E1394

**Verified (manufacturer manual):** RS-232, DB-9, 9600 8N1 recommended. ASTM E1381 low level: ENQ/ACK establishment, frames of at most 240 characters including the frame number, ETB/ETX, two-hex-digit checksum (sum of FN through ETX/ETB modulo 256), CR LF, EOT; 15-second timeouts, 6 retries; the instrument wins line contention. ASTM E1394 records H, P, O, R, C, Q, L. Test ID `^^^ACN^dilution`. Result flags L/H/N/A. QC results are transmitted. Specimen ID at most 22 characters. Real-time host query (Q record) and batch download.

**How Natija reads it:** `H.11` describes the message (`RSUPL^REAL` results, `TSREQ^REAL` query, `TSDWN^REPLY` our answer); `O.3` specimen ID; `O.4` sequence^rack^position^^sample type^container; `O.12 = Q` marks QC; `R.3` component 4 = ACN, component 5 = dilution; `R.4` value, `R.5` unit, `R.7` flag, `R.9` status, `R.13` time. Query: `Q.3` component 2 = specimen ID. Our answer echoes the position components and sends `O.26 = Q` (orders) or `Y` (no order). We send at most 239 text characters per frame, valid whether or not the frame number counts toward the 240.

**To confirm before L1:** the exact `H.11` texts and the component layout of `O.4` and `Q.3` for the installed software version, ACN codes per assay, how reruns and automatic dilutions are flagged, how QC lots are identified in the control specimen ID, the cable (straight or null-modem) and the e 411 host-interface settings (query timeout, batch vs real-time).

### Sysmex XN-L / XN (XN-550) — ASTM E1381 / E1394

**Likely (secondary sources):** ASTM E1381/E1394 over LAN, where the analyzer connects to the host (agent `tcp_server`), or over RS-232. Host query. Sends histograms and scattergrams. Universal test ID like `^^^^WBC^1`.

**How Natija reads it:** `O.4` component 3 = sample number (component 4 `B` = read from a barcode), falling back to `O.3`; `R.3` component 5 = parameter (WBC, NEUT#, …), component 6 = dilution; graph references (scattergram, histogram) are kept apart and never treated as results; `O.12 = Q` marks QC (standard E1394 action code, to confirm); query `Q.3` component 3.

**Unknown / to confirm:** the Sysmex host-interface specification itself; whether graphs are file references or inline data; how IP messages (flags such as "Leukocytosis") and research parameters are sent — sent as R records they would reach review as unknown codes; QC file transmission; sample number padding.

### Mindray BS-430 — HL7 v2.3.1 (or ASTM)

**Likely (secondary sources):** HL7 v2.3.1 over MLLP: results `ORU^R01` / `ACK^R01`; query `QRY^Q02` → `QCK^Q02`, then `DSR^Q03` / `ACK^Q03`. ASTM E1394 is offered too. The analyzer connects to the host.

**How Natija reads it:** `OBR-2` sample barcode (fallback `OBR-3`); `OBX-3` test number and `OBX-4` test name — Natija maps on the name, falling back to the number; `OBX-5` value, `OBX-6` unit, `OBX-7` range, `OBX-8` flag, `OBX-14` time; `MSH-16 = 2` marks QC. Query: `QRD-8` barcode. Our answer: `QCK^Q02` (`QAK-2 = OK/NF`) and `DSR^Q03` with DSP lines (21 barcode, 24 STAT, 26 sample type, 29 onward the tests).

**Unknown / to confirm:** a BS-430 host-interface manual has not been seen. Every field position above, the DSP line numbers, the `MSH-16` result-type convention, the character set, and which protocol the installed unit is set to need confirming.

### Medica EasyStat / EasyBloodGas — printout text

**Verified:** RS-232 at 2400 baud, 8N1, through Medica's cable. The analyzer sends its **printout** as plain ASCII, with no framing and no acknowledgement, results only ("not ASTM or LIS enabled"). Staff key the sample ID on the analyzer.

**How Natija reads it (layout assumed):** the agent ends a printout after an idle gap (default 2.5 s, `textIdleMs`) or a form feed. The parser looks for a sample ID line (`Sample ID:`, `ID#`, `Patient ID:` as fallback), a date and time in several formats, and analyte lines such as `pH 7.412` or `pCO2 39.5 mmHg` with an optional H/L flag; temperature and barometric lines are kept as comments.

**Limits:** no acknowledgement means no retransmission and no way to prove a printout is complete; text cut off by a dropped connection is stored as incomplete for review. Typing errors in the sample ID land in review as unknown samples. No host query. **To confirm:** a real printout capture for each print option (patient ID, operator, calculated values, temperature correction, QC printouts) and the firmware version.

### Boditech ichroma III — no specification

**Unknown:** Boditech publishes no host-interface specification for the ichroma III. So that the demo covers all six analyzers, the simulator and parser use an **invented** line format, `ICHROMA-DEMO|<sampleId>|<test>|<value>|<unit>|<time>`. It is not Boditech's protocol and must never be described as such. A real integration needs the vendor's interface document (or captured traffic and written permission), after which the dialect is replaced.

## Questions for each lab and distributor

1. **Identity:** exact model, software version, serial number; is the LIS/host interface option licensed and enabled?
2. **Documentation:** the host-interface manual for that model *and software version*; who at the distributor can answer protocol questions.
3. **Physical link:** port type (DB-9, RJ-45), cable (straight or null-modem, length), serial settings, IP addressing, who configures the analyzer side (vendor engineer visit?), is a serial device server acceptable?
4. **Protocol:** ASTM or HL7 mode; unidirectional or bidirectional; real-time query or batch download; query timeout on the analyzer; character set; specimen ID length and barcode symbology.
5. **Content:** test code list (application codes, parameter names), units configured, flags sent, how reruns, dilutions, QC and calibration results are transmitted, what happens when the host does not answer a query.
6. **Operations:** samples per day, STAT handling, maintenance windows, who keys sample IDs on results-only analyzers.
7. **Validation:** permission and time for a bench test (L2), test samples and controls, who signs off L3.

## Where the code is

| Area | Files |
| --- | --- |
| Link layers and dialects | `packages/protocols/src/`: `astm.ts`, `astm-link.ts`, `hl7.ts`, `medica.ts`, `ichroma.ts`, `normalize.ts`, `session.ts`, `exchange.ts` |
| Simulated traffic | `packages/protocols/src/simulate.ts`, `apps/api/src/modules/instruments/simulate.ts`, `apps/simulator/` |
| Ingest | `apps/api/src/services/ingest.ts` |
| API | `apps/api/src/modules/{instruments,agents,agent-api,integration,qc}/` |
| Request/response shapes | `packages/contracts/src/instruments.ts`, agent wire types in `packages/protocols/src/agent-api.ts` |
| Lab Agent | `apps/agent/` |
| Tests | `packages/protocols/src/*.test.ts` (`pnpm vitest run packages/protocols`) |

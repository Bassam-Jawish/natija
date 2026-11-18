# Natija analyzer simulator

Plays one analyzer against a running Lab Agent, over TCP, speaking that analyzer's protocol family for real: ASTM E1381 frames with checksums and ENQ/ACK/NAK/EOT, HL7 v2 over MLLP with acknowledgements, or raw printout text. Every frame and control character is printed.

> **Simulated traffic only (readiness level L0).** It demonstrates how Natija handles each protocol; it does not show that any analyzer has been integrated. The ichroma III format is **invented** (Boditech publishes no specification) and the Medica printout layout is an assumption.

## Usage

Start the Lab Agent first (`pnpm agent`, see `apps/agent/README.md`), then:

```bash
pnpm simulate -- --instrument sysmex_xn --mode abnormal --barcode 261117-0042-01
pnpm simulate -- --instrument E411 --from-worklist --query          # host query, then results for what the host asked
pnpm simulate -- --instrument cobas_pure --from-worklist --count 3 --mode critical
pnpm simulate -- --instrument mindray_bs430 --from-worklist --query --fault late-ack
pnpm simulate -- --instrument medica_easystat --barcode 261117-0044-01
pnpm simulate -- --instrument XN550 --qc --level L2
```

`--instrument` takes a model (`sysmex_xn`, `cobas_e411`, `cobas_pure`, `mindray_bs430`, `medica_easystat`, `ichroma3`) or an instrument code configured in the agent. The simulator reads the agent's status page (`--agent`, default `http://127.0.0.1:7300`) to find the port the agent listens on for that analyzer, and its `/worklist` for pending tubes (`--from-worklist`). Analyzers that are RS-232 on site (cobas e 411, Medica) talk TCP here, as they would through a serial device server.

| Option | Meaning |
| --- | --- |
| `--mode` | `normal`, `abnormal` or `critical` values from the model's test menu |
| `--barcode` | Tube barcode(s); repeat or comma-separate |
| `--from-worklist`, `--count` | Take pending tubes and their tests from the agent's cache |
| `--tests` | Instrument test codes to report |
| `--query` | Ask the host first (ASTM Q record, `QBP^Q11`, `QRY^Q02`), then run what it answered |
| `--qc`, `--level` | Send QC results with sample ID `QC-<level>` |
| `--host`, `--port` | Override where the agent listens |
| `--listen` | Be the TCP server and wait for the agent (for `tcp_client` analyzers such as a cobas pure in server mode) |
| `--seed` | Repeat a run exactly |
| `--quiet` | Print only the summary |

## Faults

| `--fault` | What the simulator does | What to expect |
| --- | --- | --- |
| `duplicate` | Sends the first message twice | Natija applies it once and logs a duplicate |
| `bad-checksum` | ASTM: corrupts the checksum of frame 2 once. HL7 (no checksum): first sends a copy with broken delimiters | ASTM: `<NAK>`, retransmission, `<ACK>`. HL7: `MSA-1 AR`, then the good copy is accepted |
| `unknown-code` | Adds a test code the lab has not mapped | Review item `unknown_code` |
| `unknown-sample` | Uses a barcode that does not exist | Review items `unknown_sample` |
| `drop-mid-message` | Cuts the connection mid-message (ASTM: after 2 frames, before EOT) | The agent keeps the partial message as incomplete; Natija stores it for review, never applies it |
| `late-ack` | Holds its own acknowledgements for 16 s during a host query | The agent times out after 15 s, sends EOT and logs that the reply was not delivered |

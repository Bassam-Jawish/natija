# Demo guide

Everything in the demo is fictional. Start it with `pnpm dev` (or open the offline file from `pnpm build:offline`): it runs in mock mode, with no server and no internet. Any lab code, user name and password signs in; the sign-in page lists the accounts, and one click signs in.

| Lab code | Who to sign in as | Shows |
| --- | --- | --- |
| `yasmin` (Damascus) | `reception`, `tech`, `tech.hem`, `doctor`, `accountant`, `manager`, `owner` | The full workflow, all six simulated analyzers, two branches |
| `orontes` (Hama) | same usernames | A second lab with its own staff, prices and four analyzers |
| `citadel` (Aleppo) | same usernames | A third lab, three analyzers |

Tip: in mock mode each browser keeps its own copy of the data, so to be two people at once (reception and the lab doctor), sign out and in within the same window. With the real backend (`pnpm dev:full`), two browser profiles share the data and live updates move between them.

## What is already in the demo

The first start in a browser replays about a month of work in each lab ([apps/web/src/mock/seed/history.ts](../apps/web/src/mock/seed/history.ts); with the real backend, `pnpm seed:demo` does the same in the database). It runs the same services the screens use, on a simulated clock, as the member of staff who would do each step:

- **Patients:** 110–160 fictional patients per lab. Each has a profile (check-up, diabetes, kidney disease, anaemia, thyroid, infection, pregnancy, urinary infection, brucellosis, cardiac, warfarin, ICU…), so repeat visits show believable trends and delta checks. Phone numbers use the unassigned `0900` prefix and e-mails `example.com`.
- **The daily routine:** the cash session opens at 07:30 and closes at 20:00 (Fridays half a day), with the occasional short or over count. Then come QC runs judged by the Westgard rules (sometimes a warning, rarely a rejection followed by a rerun), daily and weekly analyzer maintenance, and expenses: generator fuel from the drawer, weekly reagents, and rent and salaries on the 1st.
- **Every order goes through each step:**
  - registration, with payment in full, in part or on delivery;
  - labels;
  - collection and reception, with an occasional rejected tube and its recollection;
  - analyzer results, or manual entry for urine, stool, serology and cultures;
  - verification;
  - the doctor's validation, with a recorded call for every critical value;
  - report release;
  - delivery by print, WhatsApp link, SMS or e-mail (both simulated), with any balance paid at the desk.
- **Occasional events:** discounts approved by the manager, cancelled orders, a corrected result (report version 2), cultures released two to three days later as a second report version.
- **The demo day** is today (yesterday if you run the seed before 08:00). It stops at the moment you ran the seed, or shortly before closing time (18:30, Fridays 13:00) when you run it outside opening hours, so every stage is on screen at once:
  - orders waiting for collection;
  - tubes on the analyzers;
  - results to verify and validate;
  - reports to hand over;
  - a STAT chest-pain patient whose critical troponin still needs the doctor's call;
  - a discount waiting for the manager;
  - a QC warning;
  - a few analyzer faults in the review queue and the event log.
- **Analyzer traffic:** about half of the last two days' single chemistry and immunoassay results went through the simulated links, so they show up under *Messages*. Every other result was applied the way the link applies it, without the wire traffic. Panels whose values must agree with each other (CBC, bilirubins, proteins, lipids, PT/INR, blood gas) always use the seed's coherent values, because the simulator draws each value on its own.

**Reset demo data** in the user menu creates the data again, which also moves "today" to the current time (with the real backend: `pnpm seed:demo`).

## Scenario 1 — a patient from the desk to the report

1. **Reception** (`yasmin` / `reception`) → *Reception*. Search the patient by name or phone; for a new patient enter first, father's, mother's and family name, sex, and the age (the system stores an estimated birth date) or the birth date. A duplicate warning appears if a similar patient exists.
2. Add tests: type "CBC", pick *Lipid profile*, or choose the *General check-up* package. The tube preview shows which tubes to draw (lavender EDTA, gold serum…). Pick the payer (general public, an insurer plan, a client lab); the totals split into patient and insurer shares.
3. *Create order*. The daily number appears large. Print the **labels** (one per tube, Code 128) and the **receipt** (with the patient's 6-digit access code and a QR code). Take a full or partial payment (open your cash session when asked).
4. **Collection** (`tech`) → *Sample collection*: the order waits there with its waiting time; mark tubes collected.
5. *Sample reception*: scan or type each tube barcode; tubes turn *Received*.
6. Results: either *Instruments → Sysmex XN-550 → Simulator → Run* (the CBC arrives through the ASTM pipeline) or type results in *Worklists* (Enter moves to the next field). Then *Verify*.
7. **Validation** (`doctor`) → *Validation*: review flags, reference ranges and previous values; *Validate* with your password (e-signature). Then *Release report*.
8. **Delivery** (`reception`) → *Report delivery*: print the A4 report, send it by WhatsApp (opens WhatsApp with the link ready), or copy the patient link. On the printed report, scan the QR code: it opens the public *verify* page.
9. Open the patient link in a private window: enter the access code from the receipt to see the report.

## Scenario 2 — abnormal and critical results

1. Create an order with *Electrolytes* and *CBC* as in scenario 1, collect and receive the tubes.
2. *Instruments → cobas pure → Simulator*, mode **critical** → potassium or glucose arrives beyond the critical limit. Every validator gets a red notification immediately.
3. As `doctor`, open the order: the critical banner requires **Record call** (who was told, their role, phone, read-back). Release is refused until the call is recorded.
4. Validate (e-signature) and release. The report shows ↑↑/↓↓ flags readable in black and white, and the validation history.
5. Optional: *Amend* a released result with a reason → version 2 of the report, marked as replacing version 1; the old QR shows "superseded".

## Scenario 3 — labs can't see each other

1. As `yasmin` / `reception`, create a patient and an order; note the order number.
2. Sign out, sign in as `orontes` / `reception`: search for that patient or order number — nothing. The lab name, logo, colour, staff, prices and doctors are Orontes's own.
3. Behind it: PostgreSQL row-level security on every lab table (see [security](security.md)); `apps/api/test/isolation-db.test.ts` and the module tests try cross-lab access and expect nothing back.

## Scenario 4 — analyzer integration

1. As `tech` or `manager`: *Instruments* shows each analyzer with its protocol, connection, status and the honest integration level (**L0 · simulated**).
2. Pick an instrument → *Simulator*. Choose a mode and a fault, then *Run*. The screen shows the raw frames (ENQ/ACK/STX…ETX checksum/EOT for ASTM, MLLP for HL7, plain text for Medica), the parsed records, the code mapping (e.g. `GLUC3` → Glucose) and where each value went.
3. Faults: **duplicate** (detected, not applied twice), **bad checksum** (NAKed, nothing stored), **unknown code** / **unknown sample** (go to the *Review queue*, where a technician assigns or dismisses them).
4. *Messages* lists every message with raw and parsed views; *Events* logs connections and errors.
5. The real Lab Agent and simulators can also run as separate programs talking TCP: see [apps/agent/README.md](../apps/agent/README.md) and [docs/analyzers.md](analyzers.md).

## More to show

- **Dashboard** (`owner` / `manager`): work in progress from collection to delivery, criticals, turnaround times, orders by hour, revenue.
- **Cashier** (`accountant`): open/close a cash session with the counted-cash difference; refunds; approvals for discounts and free tests; expenses; insurer statements with Excel export.
- **Administration** (`owner`): test catalog and reference ranges by sex and age, payer groups and unit prices, staff and role permissions, lab branding and report language, audit log with hash-chain verification.

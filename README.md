# Natija · نتيجة

A multi-tenant laboratory information system (LIMS) for medical laboratories, built for how Syrian labs work: Arabic first (right-to-left) with English, prices in units per payer group, insurers through third-party administrators, lab-to-lab referrals, WhatsApp delivery, and analyzers connected through an on-site Lab Agent.

> **Demo status.** The web app runs on its own with **mock data**: no server, no database and no internet are needed, and any lab code, user name and password signs in. The three demo labs, their patients, doctors, insurers and results are fictional. Analyzer connections are **simulated (level L0)**: no instrument has been tested against a real device yet. SMS and email go to a simulated outbox. No regulatory compliance is claimed. The real backend (API + PostgreSQL) is still in the repository and can be switched back on.

## What's inside

| Area | What it does |
| --- | --- |
| Front desk | Patient registry with Arabic name parts, age or birth date, duplicate detection and merge; one-screen reception (tests, packages, payer pricing, doctor, priority); tube grouping and barcode labels; invoices split between patient and insurer; partial payments; receipts with the patient's access code |
| Laboratory | Collection queue, barcode-scan reception, rejection with recollection, storage; department worklists with keyboard result entry; flags by sex and age, critical values, delta checks, calculated tests (eGFR, LDL…); technical verification; medical validation with e-signature and segregation of duties; amendments as new report versions |
| Reports | Bilingual A4 reports printed by the browser (correct Arabic), QR code that proves a printed report is genuine, patient portal with access code, WhatsApp one-click delivery |
| Analyzers | ASTM E1381/E1394, HL7 v2 (MLLP) and vendor-text parsers; Lab Agent (journal before ACK, offline queue, host-query cache); simulators for Roche cobas pure and e 411, Sysmex XN, Mindray BS-430, Medica EasyStat and (invented format) Boditech ichroma III; review queue; QC with Westgard rules |
| Back office | Cash sessions with counted-cash difference, refunds, discount and free-test approvals, expenses, insurer and client-lab statements |
| Insights | Live dashboard (work-in-progress pipeline, turnaround, criticals), reports with Excel export |
| Administration | Test catalog with reference ranges, payer groups and prices, doctors, staff and roles (36 permissions), lab branding and settings, hash-chained audit log |
| Platform | Many labs on one database, isolated by PostgreSQL row-level security on every lab-owned table |

## Quick start (Windows, macOS, Linux)

Requirements: **Node 24.7+** and **pnpm 10+**, only to install and start the app.

```bash
pnpm install
pnpm dev           # the web app alone, in mock mode (port 5173)
```

Open http://localhost:5173. The first start prepares a month of demo history in the browser (a few seconds), then keeps it there: what you add stays after a reload, and **Reset demo data** in the user menu starts over.

Any lab code, user name and password works. The sign-in page lists the demo accounts for one-click sign-in; an unknown user name signs in as the role its name suggests (`reception`, `tech`, `doctor`…) or as the lab owner.

| Lab code | Lab | City |
| --- | --- | --- |
| `yasmin` | Yasmin Medical Laboratories | Damascus (all six analyzers, two branches) |
| `orontes` | Orontes Diagnostics | Hama |
| `citadel` | Citadel Medical Lab | Aleppo |

Usernames in every lab: `owner`, `manager`, `reception`, `tech`, `doctor` (validator), `accountant`; Yasmin also has `tech.hem` (hematology only).

**Without installing anything:** `pnpm build:offline` writes one file, `apps/web/dist-offline/natija-demo.html`, with the whole app inside it. Copy it anywhere and double-click it; it works offline. Tested opened from the disk in Chrome and Edge (sign-in, changes kept after a reload, a second tab on the same data); Firefox and Safari not tried yet.

Scenario walkthroughs: [docs/demo-guide.md](docs/demo-guide.md). How mock mode works: [docs/architecture.md](docs/architecture.md#mock-mode).

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | The web app alone in mock mode, with live reload |
| `pnpm build:offline` | One self-contained `natija-demo.html` that opens from a file, offline |
| `pnpm build` | The web app for static hosting (mock mode) |
| `pnpm dev:full` | The real backend: PostgreSQL, migrations, API and web app (`VITE_MOCK=false`) |
| `pnpm seed:demo` | Real backend: reset the database and load the demo labs with history |
| `pnpm db:reset` | Reset to base data only (labs, staff, catalog, instruments) |
| `pnpm db:start` / `db:stop` / `db:status` | Control the local PostgreSQL |
| `pnpm test` | All tests (each run uses its own throwaway database) |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm start` | Production-style local run: built web app served by the API on port 4310 |
| `pnpm agent` / `pnpm simulate` | Lab Agent and analyzer simulator (see [apps/agent/README.md](apps/agent/README.md)) |

## Layout

```
apps/api         Fastify API (REST + live events); modules per area; services; tests
apps/web         React app: lab workspace, print pages, patient portal
apps/agent       On-site Lab Agent (serial/TCP, journal, worklist cache)
apps/simulator   Virtual analyzers speaking each protocol family
packages/db      Drizzle schema, SQL migrations (row-level security), seed data
packages/domain  Pure rules: pricing, ranges and flags, tubes, numbers, formulas, QC
packages/protocols  ASTM, HL7, Medica, instrument profiles, simulators
packages/contracts  Shared request/response types
infra            Docker, Compose, Caddy, backups
docs             Architecture, security, deployment, analyzers, modules, demo guide
```

## Documentation

- [Architecture](docs/architecture.md) · [Security](docs/security.md) · [Deployment & hosting](docs/deployment.md)
- [Analyzer integration](docs/analyzers.md) · [Demo guide](docs/demo-guide.md)
- Modules: [front desk](docs/modules/frontdesk.md) · [laboratory](docs/modules/bench.md) · [administration & finance](docs/modules/admin.md)

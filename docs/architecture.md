# Architecture

Natija is one TypeScript monorepo: a React web app, a Fastify API, PostgreSQL 18, an on-site Lab Agent and analyzer simulators. Pure business rules live in `packages/domain` and are shared by the API, the web app and the seed.

```
Browser (React, Arabic/English)  ──HTTPS, cookie session, CSRF header──►  API (Fastify)  ──►  PostgreSQL 18
        ▲  server-sent events (live updates)                                │                     (row-level security per lab)
        └────────────────────────────────────────────────────────────────────┘
Lab Agent (each lab, Windows service) ──HTTPS outbound only, device token──► /api/v1/agent/*
   ▲ RS-232 / TCP: ASTM E1381/E1394, HL7 v2 MLLP, Medica text
Analyzers
```

## Request lifecycle

1. `onRequest` resolves the session cookie (sha256 of a random 32-byte token) to the user, lab and permissions (10-second in-process cache).
2. `preHandler` checks the route's config: `public`, `agent` (device bearer token), required permissions (`perm`, any-of), and the CSRF header on POST/PUT/PATCH/DELETE. Only `/api/` routes go through these checks; the built web app's files and client routes (served by the API in production) are public.
3. The handler runs inside **one transaction scoped to the lab** (`withLab`): `set_config('app.lab_id', …, true)`. Every query in the request goes through that transaction (`db()` from AsyncLocalStorage), so row-level security applies to all of it.
4. Events and notifications are published **after commit** (`afterCommit`), never for rolled-back work. The HTTP response is held back until the commit too, so a client that acts on it straight away always finds the data.

## Lab isolation (multi-tenancy)

Shared database and schema, `lab_id` on every lab-owned row, and:

- **Row-level security, forced**, on all 50 lab-owned tables; policy `lab_id = app_lab_id()` for reads and writes. The application role `natija_app` cannot bypass it (no superuser, no BYPASSRLS).
- **Composite foreign keys** `(lab_id, id)`: a row can't point at another lab's row, even through a bug.
- The lab comes from the session only, never from the URL or body; a foreign id returns 404.
- Exempt by design, holding no patient data: `labs` (directory), `sessions` and `agents` (looked up by token hash before the lab is known).
- Public pages (patient portal, report verification) resolve their lab through two narrow `SECURITY DEFINER` functions, then continue under row-level security.
- Tests: `apps/api/test/isolation-db.test.ts` (database level) and per-module cross-lab tests.

## Key modules

| Module | Role |
| --- | --- |
| `services/results-engine.ts` | The only path for a result value (manual, analyzer, calculated): keeps every attempt, picks the reference range by sex/age/specimen/instrument, flags (L/H/LL/HH/A), delta check, recalculates dependent calculated tests, alerts validators about criticals, audits |
| `services/order-status.ts` | Derives line and order status from results and tubes |
| `services/outbox.ts` | Outgoing SMS/email queue; delivered by provider adapters (simulated in the demo) |
| `services/ingest.ts` | Analyzer messages: dedup by hash, parse, map codes, match tubes, apply results, review queue |
| `lib/audit.ts` | Per-lab hash-chained, append-only audit log; before/after values are stored in jsonb key order so every hash can be recomputed from the stored row |

## Mock mode

The web app runs on its own by default: no server, no database, no internet. Every call it would send to `/api/v1` is answered inside the browser by `apps/web/src/mock`, from demo data kept in the browser's IndexedDB. Set `VITE_MOCK=false` (or run `pnpm dev:full`) to talk to the real API again; nothing else in the app changes.

- **One switch.** `lib/api.ts` sends each request either to `fetch` or to `mockRequest()`. Live updates come from the mock's event bus instead of the server's event stream (`lib/live.tsx`). Excel exports become CSV files and attachments become data URLs.
- **Same data model.** The mock store keeps the database's tables and row fields (`packages/db/src/schema.ts`), split per lab the way row-level security splits them. It fills defaults from the same table definitions.
- **Same rules.** `mock/modules` mirrors `apps/api/src/modules`: the same paths, response shapes and permission checks, with the services ported to work on the store. The results engine, order status and billing are shared by the areas, as on the server.
- **Input is never refused.** Sign-in accepts any lab code, user name and password, and the e-signature and patient access codes accept anything. Input that fails the server's validation drops the failing fields instead of returning an error. Lab workflow rules stay, because they are what the demo shows: segregation of duties, critical calls before release, cash needing an open session.
- **Demo data.** The first start creates the three labs with the same seeder as the server (`packages/db/src/seed`). It then replays about a month of work through the mock services on a simulated clock (`mock/seed/history.ts`), which takes a few seconds and is saved. **Reset demo data** in the user menu throws the changes away and starts again.
- **Offline file.** `pnpm build:offline` inlines scripts, styles and fonts into one HTML file with hash routes (`…/natija-demo.html#/orders`), so it opens from the disk.
- **Not available in mock mode:** the Lab Agent (no real analyzer can connect; the in-app simulators work), real SMS and e-mail (the outbox simulates them), and shared data between people. Each browser has its own copy.

## Decisions

| Decision | Why |
| --- | --- |
| Fastify modules instead of NestJS (proposal) | Same modular structure with far less ceremony; route config carries permissions and tenancy |
| PostgreSQL for data, queue (outbox table with `SKIP LOCKED`) and events | Fewer moving parts; no Redis needed at this size |
| PostgreSQL 18 | Native `uuidv7()` for time-ordered keys |
| Embedded PostgreSQL for local runs | Runs on any Windows PC without Docker; production uses the official image |
| Reports printed by the browser from HTML | Perfect Arabic shaping and bidi with no server-side Chromium; works on free hosting; a server-side PDF renderer can be added later for automated attachments |
| Server-side sessions in httpOnly cookies + CSRF token | Revocable at once; nothing in browser storage for scripts to steal |
| REST + shared zod contracts | The same API can serve a future mobile app (e.g. Flutter) |
| Lab Agent connects outward only | Labs need no fixed IP or open ports; queues on disk during internet or power cuts |

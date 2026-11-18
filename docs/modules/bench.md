# Laboratory side (bench)

Samples, worklists, results, technical verification, medical validation, reports, delivery and the public patient pages. Arabic first (right-to-left), English as a toggle.

| Layer | Where |
| --- | --- |
| API | `apps/api/src/modules/{samples,worklists,results,reports,public}/` — each has `service.ts` (business functions, run inside the current lab context) and `routes.ts`; shared row mapping in `results/shared.ts` |
| Contracts | `packages/contracts/src/bench.ts` (zod inputs + response shapes) |
| Web | `apps/web/src/features/bench/` — pages, `print/ReportPrint`, `public/{PortalPage,VerifyPage}`, `order-panels.tsx`, `components/` |
| Translations | `apps/web/src/locales/{ar,en}/bench.json` |
| Tests | `apps/api/test/bench-{flow,samples,public}.test.ts`, fixtures in `bench-fixtures.ts` |

## Flows

```
Tube:    pending ──collect──► collected ──receive──► received ──store──► stored ──dispose──► disposed
            │  (receive directly when the lab does not require the collection step)   ▲
            └──────────── transfer ──► in_transit ──receive──┘                          │
         any active tube ──reject──► rejected  (+ recollect: new tube, next number, takes the lines)

Result:  pending ──enter / analyzer──► resulted ──verify──► verified ──validate (e-sign)──► validated ──release──► released
            ▲                               │                    │                                              │
            └──────── rerun (value cleared, attempts kept) ──────┘                         amend (e-sign) ──────┘ new report version
```

Every tube move writes a `sample_events` row, an audit entry and a `samples.changed` event, then `refreshOrderStatus` recomputes the lines and the order. Every result value goes through `applyResultValue` (flags by sex/age, delta check, calculated tests, critical alerts).

## Rules

- **Collection step** (`settings.requireCollectionStep`): when on, a tube must be marked collected before the bench can receive it (`not_collected`); when off, receiving also records the collection.
- **Department scope**: users with `departmentIds` only see and change results of tests in those departments (worklist, entry, verification, validation). Asking for another department answers `403 department_not_allowed`.
- **Manual entry** is checked against the analyte: numbers (with `<`/`>` qualifiers, Arabic digits accepted), one of the options, or text. Calculated analytes are never typed. A batch is all-or-nothing; refused fields come back keyed by result id.
- **Validation** is e-signed (password re-entered) and needs a value (resulted or verified). With `settings.segregationOfDuties`, nobody validates a value they typed (the selected attempt is manual and theirs) or verified: `403 same_user`. Each validation writes a `result_versions` row.
- **Critical values** notify `results.validate` holders when they first appear; the report can't be released while a critical result has no `critical_calls` row (`409 critical_call_required`).
- **Rerun** clears the value through the engine (all attempts stay) with the reason in the attempt note.
- **Amendment** (released results only, `results.amend`, e-signed): the old value goes to `result_versions`, the new one through the engine (dependent calculated results are unlocked and recalculated too), the rows are marked `amended`, the report is re-released as a new version with the reason, and `reports.deliver` holders are told to resend.
- **Rejection with recollection**: new tube `accession-NN` (next number, `recollectOfId`), lines moved to it, values entered from the rejected tube cleared, `samples.collect` holders notified. A tube with validated results can't be rejected; a rejected tube keeps the `rejected` status when disposed of.

## Reports

A report version is a frozen JSON snapshot (`buildReportSnapshot`): letterhead (names, tagline, director, address, phone, logo SVG, brand colour, time zone), patient (names, sex, age at the order, MRN), order (number, daily number, collected / received / validated / released times, doctor), sections per department → tests → rows (names AR/EN, value as printed, unit, flag, critical, reference, previous released value + date, comment, amended), validators with times, footers from settings, `partial` + pending tests, version, replaced version, amend reason and verify code.

- `contentHash` = SHA-256 of the canonical JSON (keys sorted at every level), so it can be recomputed from the stored snapshot.
- `verifyCode`: 10 characters from an unambiguous alphabet, unique across all labs (retried on collision); the QR points to `/verify/<code>`.
- Releasing supersedes the previous version. The printed page (`/print/report/:orderId?version=&lang=`) follows `settings.reportLanguage` (ar, en, bilingual), A4 with 12 mm margins; letterhead + patient block and the footer (QR, code, footers, demo label) repeat on every page through the table header/footer groups; "Page X of Y" comes from the `@page` margin box (Chrome). Flags print as arrows + letters (↑ H, ↓ L, ↑↑ HH, ↓↓ LL, ! A) so black-and-white copies read correctly. The browser does the Arabic shaping.

## Delivery and the patient portal

- **Link**: 32 random bytes, only the SHA-256 stored (`report_tokens`), valid 30 days, URL `${PUBLIC_URL}/r/<token>`. The patient adds the 6-digit receipt code (constant-time compare). Five wrong codes lock the link for good (`423 link_locked`); expired or revoked links answer `410`.
- **Receipt QR** (`/r?lab=&order=`): lab code + order number + code. Wrong attempts are counted per order in a `report_tokens` row keyed by an HMAC (no link token can hash to it); five lock the lookup for 15 minutes. Unknown orders and wrong codes get the same answer.
- **Channels**: print; WhatsApp returns a `wa.me/<digits>?text=` link the desk opens on its own WhatsApp (the business API can't reach Syrian numbers; local `09…` numbers become `9639…`); SMS and email go through the outbox (`simulated` in the demo); portal returns the link. Any delivery of a completed order, and the patient opening it, marks the order delivered. Openings are logged as `deliveries` rows with status `opened`.
- **Verify** (`/verify/<code>`): genuine / superseded / not found, with lab, order number, version, release date, patient initials, test count and content hash — never results.
- Public routes run with `public: true, tenant: false`, are rate-limited per address, resolve the lab through `public_resolve_report_token` / `public_verify_report`, then work inside `withLab`.

## API

| Endpoint | Permission |
| --- | --- |
| `GET /samples/meta` · `GET /samples` (`view=collection` for the draw queue; `status,departmentId,orderId,from,to,dateBy,sort,q,events`) · `GET /samples/by-barcode/:barcode` · `GET /samples/:id/events` | any sample/order/result read |
| `POST /samples/collect {sampleIds?\|barcodes?}` | `samples.collect` |
| `POST /samples/receive {barcodes}` → per tube: received / already_received / not_found / rejected / not_collected / order_cancelled | `samples.receive` |
| `POST /samples/:id/reject {reasonId, note, recollect}` | `samples.reject` |
| `POST /samples/:id/transfer {toLocation}` | `samples.store` / `samples.collect` / `samples.receive` |
| `POST /samples/:id/store {location}` · `POST /samples/:id/dispose` | `samples.store` |
| `GET /worklists?departmentId&instrumentId&status=pending\|to_verify\|all&from&to&q` | `results.enter` / `results.verify` |
| `PUT /results/:id {value?, comment?, dilution?}` · `POST /results/batch {entries}` | `results.enter` |
| `POST /results/verify {resultIds}` | `results.verify` |
| `POST /results/validate {resultIds, password}` | `results.validate` |
| `POST /results/:id/rerun {reason}` · `POST /results/:id/critical-call {…}` | enter / verify / validate |
| `POST /results/:id/amend {value, reason, password}` | `results.amend` |
| `GET /results/:id/history` · `GET /results/orders/:orderId` | `results.read` |
| `GET /results/validation-queue?departmentId&priority&critical&q` | `results.validate` |
| `POST /reports/orders/:orderId/release {resultIds?}` | `results.validate` |
| `GET /reports/orders/:orderId?version=` · `GET /reports/:id` | `reports.print` / `reports.deliver` / `results.read` |
| `POST /reports/orders/:orderId/link` · `GET /reports/deliveries?from&to&status&q` | `reports.deliver` |
| `POST /reports/orders/:orderId/deliver {channel, to?}` | `reports.deliver` (`reports.print` for `print`) |
| `POST /public/report/info {token}` · `POST /public/report/open {token, code}` · `POST /public/report/lookup {labCode, accession, code}` · `GET /public/labs/:code` · `GET /public/verify/:code` | public |

## Service functions (for seeds and other modules)

All run inside `withLab(labId, { userId }, …)`; the actor comes from the context. `opts.at` back-dates an action (history seed).

```ts
// samples/service.ts
collectSamples({ sampleIds?, barcodes? }, opts?) ; receiveSamples(barcodes, opts?)
rejectSample(sampleId, { reasonId, note?, recollect? }, opts?) ; transferSample(id, { toLocation, note? }, opts?)
storeSample(id, { location, note? }, opts?) ; disposeSample(id, { note? }, opts?)
listSamples(params) ; collectionQueue(params) ; getSample(id) ; getSampleByBarcode(code) ; getSampleEvents(id) ; getBenchMeta(departmentIds)
// worklists/service.ts
getWorklist(params, { departmentIds })
// results/service.ts  (scope = { departmentIds? } restricts departments; validation/amend do NOT check the password — call checkSignature first)
enterResults(entries, scope?) ; enterResult(resultId, { value?, comment?, dilution? }, scope?)
verifyResults(resultIds, scope?, opts?) ; checkSignature(password) ; validateResults(resultIds, scope?, opts?)
rerunResult(resultId, reason, scope?) ; recordCriticalCall(resultId, { recipientName, recipientRole, phone?, readBack, note? }, opts?)
amendResult(resultId, { value, reason }, opts?) ; getResultHistory(id) ; getOrderResults(orderId) ; getValidationQueue(query, scope?)
// reports/service.ts
buildReportSnapshot(orderId, opts?) ; releaseReport(orderId, { resultIds? }, opts?) ; createReportVersion(orderId, { amendReason?, at? })
getOrderReports(orderId, version?) ; getReport(id) ; createReportLink(orderId, { days?, at? }) ; deliverReport(orderId, { channel, to? })
markDeliveredIfComplete(orderId, at?) ; listDeliveries(query) ; canonicalJson(value) ; reportContentHash(snapshot) ; whatsappDigits(phone)
```

## Web

| Route | Page |
| --- | --- |
| `/collection` | Draw queue (STAT/urgent first, live waiting time), tubes with cap colour and barcode, print labels, collect one/all, scan to collect |
| `/samples` | Scan box for keyboard-wedge scanners with instant per-tube feedback; tabs: to receive, received today, rejected, storage (store, move, send, dispose); reject dialog (reason, note, recollect) |
| `/worklists` | Department tabs (the user's own), analyzer and status filters, entry grid per tube: Enter / ↓ next field, Shift+Enter / ↑ back, Ctrl+S saves the batch; verify selected, rerun, comments, history, critical calls; analyzer values marked |
| `/validation` | Queue + review panel (flags, ranges, previous values, delta), critical banner with call recording, e-signed validation, return for rerun, release |
| `/delivery` | Released reports with per-channel delivery state; print, WhatsApp, SMS, email, copy link |
| `/print/report/:orderId` | A4 report (`?version=`, `?lang=`) |
| `/r/:token`, `/r?lab=&order=` | Patient portal (code entry, report on screen, Save as PDF / Print, language toggle) |
| `/verify/:code`, `/verify` | Public verification |

`order-panels.tsx` exports `OrderSamplesPanel`, `OrderResultsPanel` and `OrderReportsPanel` (`{ orderId }`) for the order page; they read `?tube=` to highlight a tube. Interpolated codes, barcodes and phone numbers are wrapped with `ltr()` (Unicode isolates) so they keep their order inside Arabic sentences.

## Known gaps

- Page numbers use CSS `@page` margin boxes (Chrome 131+); other browsers print without them.
- The demo outbox only simulates SMS/email; a real provider adapter is still needed.
- Failed e-signature attempts are rejected but not counted towards a lockout (the request transaction rolls back); the endpoints are rate-limited instead.

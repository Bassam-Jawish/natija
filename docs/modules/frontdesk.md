# Front desk: patients, orders and desk billing

The front desk is where a visit starts: find or register the patient, choose tests and packages, take payment, print the tube labels and the receipt. It also owns the patient file (history, trends, attachments, merging), the order list and the order page.

| Layer | Where |
| --- | --- |
| API | `apps/api/src/modules/patients/`, `orders/` (with `pricing.ts`), `billing/` — each has `service.ts` (business functions, run inside the caller's lab transaction) and `routes.ts` (HTTP) |
| Contracts | `packages/contracts/src/frontdesk.ts` — zod request schemas + response types |
| Web | `apps/web/src/features/frontdesk/` — pages, print pages, components, `api.ts` |
| Translations | `apps/web/src/locales/{ar,en}/frontdesk.json` |
| Tests | `apps/api/test/frontdesk.test.ts` |

## Patients

- **Registration**: Arabic first, father's, mother's and family name; optional Latin first/last name; sex; birth date **or** an age (`{value, unit: years|months|days}`), in which case the birth date is estimated (`birthDateEstimated`, shown as "≈" in the UI). Full names are `first father family`; the mother's name is stored separately.
- **MRN** `P-000123` from the per-lab counter `patient`.
- **Search** (`search_text`): normalised Arabic + Latin names, MRN, national ID and phone. Arabic normalisation (`normalizeText`) folds hamza forms, taa marbuta, alef maqsura and diacritics, so "محمّد العلى" finds "محمد العلي". A number matches on its last nine digits, so `0944…`, `+963 944…` and `944…` find the same phone. Every word of a query must match.
- **Duplicates**: `POST /patients/duplicates` scores candidates with `duplicateScore` (name similarity, birth year/date, sex, phone) and returns those ≥ 60 with reasons. Reception calls it live while a new patient is typed and offers "use this patient".
- **Merge** (`patients.merge`): orders and attachments move to the record that stays, blanks on it are filled from the other record, and the other record gets `mergedIntoId` (kept for history, hidden from lists and search, refuses new orders). Different sex, or birth dates more than two years apart, return `409 merge_mismatch` unless `force: true`. Both records get an audit entry.
- **History**: the patient's orders, and validated/released numeric results per analyte (oldest first) for trend sparklines. Users without `results.read` get the orders only.
- **Attachments**: one file per request (multipart, ≤ 10 MB). The type is taken from the file's first bytes, not the client: PNG, JPEG, GIF, WebP or PDF only (`415 file_type_not_allowed`). Stored at `storageDir/<labId>/<uuid>`; downloads look the row up through row-level security first, then stream the file (`inline`, or `?download=1`).

## Orders

### Pricing (`orders/pricing.ts`)

The quote, order creation and "add tests" all use `priceItems()`, so a phone quote is exactly the invoice the order gets.

1. Packages are expanded into their active tests. A test is done once per order: when it also comes alone, or in a second package, the first package's copy wins and the duplicate is dropped (`duplicate_test` warning; a package left with nothing is dropped with `package_covered`). The reception screen also swaps standalone tests out when a package containing them is added.
2. Each line is priced with `priceTest`: payer override (`price_overrides`) > fixed price > units × the payer's unit price.
3. A package price is the sum of its tests, `units × unit price`, or its fixed price, spread over its lines with `distributePackagePrice`.
4. The payer's contractual discount, an optional manual discount, and the patient/insurer split are computed **on the order total** and spread over the lines by largest remainder, so an insurer plan with a 20 % patient share bills exactly 20 % (1 800 of 9 000, not the 1 801 that ten rounded lines give). The same split is used whenever the invoice is recomputed.
5. Two tests measuring the same analyte (e.g. LFT and ALT) give an `analyte_overlap` warning; the order is still allowed.

Money is in the lab currency, rounded with `roundMoney` (whole pounds for SYP).

### Creating an order (`POST /orders`)

In one transaction: daily number from `order:<YYYY-MM-DD>` in the lab's time zone → accession `YYMMDD-NNNN`; 6-digit `portalCode` (crypto random); lines grouped into tubes by container and specimen (`groupIntoTubes`; `separate_tube` tests get their own) → `samples` with barcode `<accession>-NN`, status `pending`, a `created` sample event; `order_items` with the price snapshot; one pending `results` row per active analyte; the invoice (`INV-YYYY-NNNNNN` from `invoice:<year>`) and its lines.

- **Manual discount** (amount or percent + reason): applied at once when the user has `finance.approve`; otherwise an `approvals` row (`discount`, `pending`) is created, approvers are notified, and nothing is deducted until the finance module grants it (it then calls `applyDiscount`).
- **Pay now**: checked *before* anything is written (amount ≤ patient total, active method, an open cash session for cash), so a closed cash box returns `409 no_cash_session` and leaves no half-made order. A retry with the same payment `idempotencyKey` returns the order the first attempt created.
- Audit `order.create`, events `orders.changed` (+ `finance.changed` when paid).

### Changing an order

| Action | Rules |
| --- | --- |
| Edit header (`PUT /orders/:id`) | Doctor, referral clinic, priority, clinical info, notes, delivery channel, fasting/pregnant (female only), external ref. Requires the `version` the user saw (`409 version_conflict` otherwise). |
| Add tests (`POST /orders/:id/items`) | Priced with the order's payer. A usable tube of the same container and specimen is reused (not rejected/disposed, not a separate-tube tube); otherwise new tubes continue the numbering. Invoice recomputed, statuses refreshed. |
| Remove a test (`DELETE /orders/:id/items/:itemId?reason=`) | Only while all its results are empty (`409 item_has_results`), never the last test (`409 last_item`). The line is cancelled (kept for history), its empty results deleted, a tube left empty is deleted if still not drawn (otherwise disposed). Invoice recomputed. |
| Cancel (`POST /orders/:id/cancel {reason}`, `orders.cancel`) | Only while no result is validated or released (`409 order_has_validated_results`). Lines cancelled, empty results deleted (entered values are kept for the record), tubes disposed with a sample event, pending discount requests rejected. An unpaid invoice is voided; a paid one is recomputed and the refund due is returned and notified to `finance.refund` holders. |

Every change is audited and published as `orders.changed`; `GET /orders/:id/activity` gathers the audit entries of the order and of its lines, tubes, results, invoice, payments, approvals, reports and deliveries.

## Desk billing (`billing/service.ts`)

Other modules import these functions; all run inside the current lab context.

| Function | Does |
| --- | --- |
| `takePayment({invoiceId, amount, methodId, reference?, idempotencyKey, note?})` → `PaymentResult` | Same key returns the original payment (`duplicate: true`; a key used on another invoice is `409 idempotency_conflict`). Attempts with one key are serialised with an advisory lock; the invoice row is locked. Amount ≤ balance (`400 amount_exceeds_balance`); void invoices refused; cash needs the user's open `cash_sessions` row (`409 no_cash_session`). Audits `payment.create`, publishes `finance.changed`. |
| `refreshInvoiceTotals(invoiceId)` → totals | Paid total from payments minus refunds; status from `invoiceStatus`. |
| `applyDiscount(invoiceId, amount, reason)` → totals + `applied` | Spreads the discount over active lines (capped at what is left), stores it on the order lines so later recomputations keep it, recomputes, audits `invoice.discount`. |
| `recomputeInvoice(orderId)` → totals | Lines follow the active order lines (new ones added, cancelled ones removed, shares re-split); totals and status refreshed. Void invoices are left alone. |
| `requestDiscount(invoiceId, {amount?/percent?, reason}, {canApprove})` | Desk discount on an existing invoice: applied or sent for approval. |
| `currentCashSession(userId?)`, `getInvoiceDetail(invoiceId)` | Helpers used by the finance module and the order page. |

`balance` in responses is `patientTotal − paidTotal`; negative means a refund is due.

## HTTP API (under `/api/v1`)

| Endpoint | Permission |
| --- | --- |
| `GET /patients` (q, sex, from, to, limit, offset) · `GET /patients/:id` · `GET /patients/:id/history` · `GET /patients/:id/attachments` · `GET /patients/:id/attachments/:attachmentId` | `patients.read` |
| `POST /patients` · `PUT /patients/:id` · `POST /patients/:id/attachments` · `DELETE /patients/:id/attachments/:attachmentId` | `patients.write` |
| `POST /patients/duplicates` | `patients.read` or `patients.write` |
| `POST /patients/merge` | `patients.merge` |
| `GET /orders/form-data` | `orders.read`, `orders.create` or `orders.edit` |
| `POST /orders/quote` | `orders.read` or `orders.create` |
| `POST /orders` | `orders.create` |
| `GET /orders` (from/to in the lab's time zone, default today — a search or a patient filter spans all dates; status, priority, source, payerGroupId, doctorId, patientId, q, unpaid) · `GET /orders/:id` · `GET /orders/:id/activity` · `GET /orders/:id/receipt` | `orders.read` (receipt also `finance.read`) |
| `PUT /orders/:id` · `POST /orders/:id/items` · `DELETE /orders/:id/items/:itemId` | `orders.edit` |
| `POST /orders/:id/cancel` | `orders.cancel` |
| `GET /orders/:id/labels` | `samples.collect` or `orders.read` |
| `POST /orders/:id/labels/printed` | `samples.collect`, `orders.create` or `orders.edit` |
| `GET /billing/invoices/:id` | `finance.read` or `orders.read` |
| `POST /billing/payments` | `finance.payment` |
| `POST /billing/invoices/:id/discount` | `orders.create`, `orders.edit` or `finance.approve` |
| `GET /billing/cash-session` | `finance.payment` or `finance.cash` |

Another lab's id answers 404 everywhere (row-level security; covered by the tests). Error codes are stable and translated in `frontdesk.json` (`errors.*`).

## Web

| Page | Notes |
| --- | --- |
| `/reception` | One screen: patient (search ↑↓ Enter, or new patient with the live duplicate warning), tests (code/name search — Enter adds the first match — favourites, packages, departments, price preview for the chosen payer), lines priced by the live quote with tube preview and warnings, payment (payer, discount request, pay now with partial payments and the cash-box check), order details. **F2** new patient · **F4** tests · **Ctrl+Enter** create. `?patient=<id>` starts with that patient. After creating: the daily number large, access code, and buttons for labels, receipt, payment, the order and the next patient. |
| `/patients`, `/patients/:id` | List with search/filters; patient file with orders, results trends (recharts sparklines with the reference band), attachments, details (edit) and merge (side-by-side comparison, which record stays, reason, force on mismatch). |
| `/orders`, `/orders/:id` | Filters live in the address bar. The order page has the desk actions (labels, receipt, payment, add tests, edit, cancel) and tabs Overview, Samples, Results, Reports (the last three from `features/bench/order-panels`, which read `?tube=` themselves; `?tube=` opens Samples), Billing and Activity. |
| `/print/labels/:orderId` | One 50 × 25 mm label per live tube: Code 128 of the tube barcode, short name, sex/age, daily number, container, tests. The print is recorded (`labels/printed`) when the print dialog closes. |
| `/print/receipt/:orderId` | 80 mm receipt: lab, invoice lines and totals, payments by method, order number, and the 6-digit access code with a QR to `/r?lab=<code>&order=<accession>` (the code is not in the QR). |

Query keys start with `orders`/`patients`/`finance` so live events refresh them; the reception form data and quotes use `frontdesk` keys so a busy day doesn't refetch them on every order event.

## Known gaps

- Payer `patientSharePct` is not snapshotted: recomputing an old invoice (e.g. after adding a test) uses the payer's current share.
- Attachments are kept on local disk (`STORAGE_DIR`); deleting a patient's file removes the row first and the file after commit.
- An order created without a payment has no idempotency key, so a double submit is only prevented by the UI disabling the button.

# Administration, finance back office, dashboards and reports

Everything a lab manager, accountant or owner uses behind the bench: the test catalog and reference ranges, prices and payer groups, referring doctors, staff and roles, lab settings and branding, the cash desk and back-office money, the dashboard and management reports, the audit log and the outbox.

| Layer | Where |
| --- | --- |
| API | `apps/api/src/modules/{catalog,pricing,doctors,staff,settings,finance,analytics,audit,outbox}/` — `service.ts` (business functions, run inside the caller's lab transaction) and `routes.ts`. Extras: `settings/svg.ts` (logo sanitiser), `analytics/excel.ts` + `export.ts` (Excel), `audit/kit.ts` (shared helpers) |
| Contracts | `packages/contracts/src/admin.ts` — zod request schemas + response types (prefixed `Catalog*`, `Pricing*`, `Finance*`, `Analytics*`, `Staff*`, `Settings*`…) |
| Web | `apps/web/src/features/admin/` — `pages/`, `components/<area>/`, `components/charts.tsx`, `components/common.tsx`, `api.ts` |
| Translations | `apps/web/src/locales/{ar,en}/admin.json` (same keys in both) |
| Tests | `apps/api/test/admin.test.ts` |

Every change validates its input with zod, needs the permission named in the route config, writes an audit entry and publishes a live event (`finance.changed` for money; `catalog.changed`, `pricing.changed`, `doctors.changed`, `staff.changed`, `settings.changed` for the rest). Rows are always looked up by id inside the lab's row-level security, so another lab's id is a 404.

## Catalog (`/catalog`, reads open to any signed-in user, changes need `catalog.manage`)

- **Lookups** `GET /catalog/lookups`: departments, specimen types, tubes (cap colour, volume), rejection reasons and analyzers, each with usage counts. Departments, specimens, tubes and rejection reasons have plain CRUD; deleting one that is used (by tests, tubes, samples, users' scope, ranges) is `409 in_use`.
- **Tests**: department, specimen, tube, units, fixed price, turnaround hours, method, external, separate tube, favourite, active, report names and the **ordered** analyte list. A test that has been ordered cannot be deleted (`409 test_ordered`) — deactivate it.
- **Analytes**: numeric, text, option (choice list) or calculated. A calculated analyte's formula is parsed with `validateFormula`; every variable must be an analyte code of the lab (or `AGE`, `FEMALE`), and a formula may not reach itself through other formulas (`formula_invalid`, `formula_unknown_variable`, `formula_cycle`). `POST /catalog/formula/check` gives the editor the parse result and the allowed variables. A code used in other formulas cannot be renamed; the result type cannot change once results exist.
- **Reference ranges** are replaced as a whole (`PUT /catalog/analytes/:id/ranges`). Rows for the **same sex, specimen and analyzer** whose ages overlap are refused (`400 range_overlap`, with `errors: {"rows.N": ["overlap:M"]}`); inverted ages or limits and empty rows are `range_invalid`. Age gaps are not errors: the response (and the dry run `POST …/ranges/check`) lists them per sex for the base rows (no specimen/analyzer), counting "any" rows for both sexes. Critical limits inside the normal range are warnings. Ages are stored in days; the editor offers days/months/years.
- **Packages**: tests plus a price mode (sum of tests, units, or fixed price).

## Pricing (`/pricing`, `pricing.manage`; payer groups readable by any signed-in user)

Payer groups (general public, insurer plan, client lab, other) with unit price, patient share %, contractual discount %, on-account flag and organisation. Per-test **overrides** win over the test's fixed price, which wins over units × unit price (`priceTest`). `GET /pricing/price-list` gives tests × payers with price, net, patient and payer share (also `pricing.manage`, `finance.read` or `orders.create`), exportable to Excel. `POST /pricing/bulk-unit-price` sets or raises (by %) several payers' unit price with rounding; one audit entry per payer, before → after.

## Doctors (`/doctors`, directory readable by any signed-in user, changes need `doctors.manage`)

CRUD; a doctor named on orders cannot be deleted (`doctor_in_use`). `GET /doctors/referrals?from&to` (`doctors.manage` or `analytics.read`): orders, distinct patients, tests and net revenue per doctor; orders without a doctor come back as `walkIn`. Revenue is `null` for users without `finance.read`.

## Staff (`/staff`, `users.manage`)

- **Users**: created with a generated temporary password (12 characters, `Xxxx-xxxx-xxxx`) returned **once**; only its argon2 hash is stored. Roles, department and branch scope, language. Disable → status `disabled`, all sessions revoked and the auth cache cleared after commit (the user is signed out at once). Reset password → new temporary password, sessions revoked, lock cleared. Nobody can disable themselves, and a change that would leave no active user with `users.manage` is refused (`409 last_admin`).
- **Roles**: permission sets from the registry (`PERMISSIONS`); unknown permissions are refused. System roles can be renamed and re-permissioned but not deleted; a role still assigned cannot be deleted. Role changes clear the whole auth cache, so they apply on the next request. `GET /staff/permissions` returns the registry grouped by area with Arabic/English labels.

## Settings (`/settings`, `settings.manage`; payment methods and branches readable by any signed-in user)

Lab profile (bilingual names, taglines, addresses, director), brand colour, currency, time zone (validated with `Intl`), workflow and report settings (segregation of duties, collection step, digits, default and report language, footers, delta-check days, USD display + rate). Every lab change calls `invalidateLab` after commit; the web app then reloads `/auth/me`.

**Logo upload** (`settings/svg.ts`): the SVG (≤ 100 KB) is parsed by a small XML tokenizer and written out again from a whitelist (shapes, paths, text, gradients, clip paths, masks, internal `<use>`). Refused outright: scripts, `on*` handlers, `foreignObject`/iframe/object/embed, any `href` or `url()` that does not point inside the file, `javascript:`/`data:` values, DOCTYPE/ENTITY, malformed XML. Editor metadata, `<style>` blocks and unknown elements/attributes are dropped and reported. `POST /settings/lab/logo/preview` sanitises without saving for the live preview.

Payment methods (cash or not; the cash flag is locked once payments exist) and branches (exactly one main branch) with in-use checks.

## Finance back office (`/finance`)

Desk payments, invoices and discounts live in the front desk's `billing` module; this module reuses its `refreshInvoiceTotals`, `applyDiscount` and `currentCashSession`, and the cash desk takes payments through `POST /billing/payments`.

- **Cash sessions** (`finance.cash` or `finance.payment`): one open session per user. `GET …/current` returns it with live totals. Totals cover payments linked to the session, plus the owner's unlinked (non-cash) payments taken while it was open. **Expected cash = opening float + cash payments − cash refunds − cash expenses of the session**; closing stores counted, expected and difference (counted − expected), audits it, and notifies `finance.approve` holders when there is a difference. Only the cashier or a supervisor (`finance.approve`) can close a session.
- **Payments** and **invoices** lists (`finance.read`): date range, status (`due` = open or partly paid with a balance), payer, search by invoice/order/file number or name, page sums.
- **Statements** (`GET /finance/statements?payerGroupId&from&to`, `/export` for Excel): a payer group's non-void invoices with gross, discount, patient and payer shares and totals.
- **Refunds** (`finance.refund`): a `refund` payment row (cash ones come out of the refunding user's open session — `409 no_cash_session` otherwise), at most the net amount paid (`refund_exceeds_paid`), idempotent by key; then `refreshInvoiceTotals`.
- **Approvals** (`GET` with `finance.approve` or `finance.read`; deciding needs `finance.approve`): an approved discount (amount, or percent of the invoice net) or free test is applied with `applyDiscount`; refund/cancel approvals only record the decision. With segregation of duties on, nobody decides their own request (`403 own_request`). The requester gets an in-app notification.
- **Expenses** and categories (`finance.expenses`): an expense paid "from the drawer" is linked to the user's open session and lowers its expected cash; it cannot be deleted once that session is closed.
- **Summary** (`GET /finance/summary`): billed, discounts, net, collected (net of refunds), outstanding patient balances, insurer receivables (on-account payers), expenses, net cash (collected − expenses), by method and by day.

## Dashboard and reports (`/analytics`, `analytics.read`)

All figures use the lab's time zone and a calendar range (≤ 400 days). Money figures need `finance.read` too (`money: null` / 403 otherwise).

- **Dashboard**: patients, orders, tests, new files, revenue, collected, outstanding; work in progress *now* by stage (items `ordered`, `collected`, `received`/`in_analysis`, `resulted`, `verified`, `validated`, and orders `completed` but not delivered in the last 30 days); open critical results (critical, last 7 days, no documented call); rejections by reason; turnaround; overdue tests (received, not yet validated, past receipt + the test's TAT); orders by hour (0–23); tests by department; top tests; orders by payer; analyzer status; billed vs collected over the last 14 days.
- **Turnaround** (`/tat`): per order line validated in the range, minutes from sample receipt to the last validation; median and 90th percentile (linear interpolation), mean, % within the test's target, the median of each step (collection → receipt → first result → validation), by department, test and day, and a histogram.
- `/volume`, `/revenue`, `/productivity` (results entered/verified/validated, orders registered, samples collected/received per user; `null` user = analyzers and calculations), `/rejections` (rate, reasons, collectors, recent), `/instruments` (messages, errors, unmatched, results, QC), `/doctors`.
- `GET /analytics/export/:report?from&to&lang` → .xlsx (exceljs); Arabic workbooks are right-to-left.

## Audit (`/audit`, `audit.read`) and outbox (`/outbox`)

`GET /audit` filters by date, record type, action, person and text. `GET /audit/verify` walks the lab's chain in `seq` order, recomputes each row's hash from its stored content and checks that it points at the previous row's hash; it reports the first broken row (`hash_mismatch` = edited, `chain_break` = a row removed or inserted). The admin modules write their before/after values in jsonb key order (`record()` in `audit/kit.ts`), because jsonb does not keep key order and the hash covers the serialised values.

`GET /outbox` (`settings.manage` or `reports.deliver`) lists outgoing messages with status counts; failed ones can be queued again (`settings.manage`). No SMS/email provider is connected, so messages end as `simulated`; the page says so.

## Web pages

Dashboard, Analytics (7 tabs, Excel export per tab), Cash desk (my session, collection by method, quick expense, unpaid invoices with "take payment", today's payments), Invoices (invoices with detail drawer, refunds; statements; cash sessions), Approvals, Expenses, Lab settings, Catalog, Prices and payers, Doctors, Staff and roles, Messages, Audit. Charts (`components/charts.tsx`, recharts) use thin marks, a hairline grid, a fixed colour order validated for colour-blind separation in both themes, tooltips with the value first, and are mirrored for Arabic (the SVG is laid out left-to-right and mirrored with `reversed` axes, because SVG `text-anchor` follows the page direction). Date ranges live in the URL (`?from&to`), tabs in `?tab=`.

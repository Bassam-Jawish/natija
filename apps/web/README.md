# Natija web app — conventions

React 19 + Vite + TypeScript, Tailwind CSS v4, React Router 7, TanStack Query/Table, Radix primitives, i18next.
Arabic (right-to-left) is the default language; English is a toggle. The look is calm, dense and clinical.

## Where things go
- `src/features/<area>/pages/*.tsx` — routed pages (default export). Routes are already declared in `src/app/router.tsx`; replace the placeholder files.
- `src/features/<area>/components/*` — pieces used by your pages. One feature never imports another feature's internals, except the agreed shared components (e.g. `features/bench/order-panels.tsx` used by the order page).
- `src/features/<area>/api.ts` — your typed query/mutation functions (call `api.get/post/put/del` from `@/lib/api`).
- `src/locales/{ar,en}/<namespace>.json` — your translations. Namespaces: `frontdesk`, `bench`, `instruments`, `admin`. Shared words live in `common.json` (don't edit it; add your own keys to your namespace). Use `const { t } = useTranslation('frontdesk')` and `t('common:actions.save')` for shared words. Arabic plurals: provide `key_zero/_one/_two/_few/_many/_other` where counts matter (at least `_one` and `_other`).

## Rules
- **Data**: TanStack Query. Query keys must start with the area prefix so live events refresh them: `['orders', …]`, `['patients', …]`, `['samples', …]`, `['worklists', …]`, `['validation', …]`, `['results', …]`, `['reports', …]`, `['instruments', …]`, `['integration', …]`, `['qc', …]`, `['finance', …]`, `['dashboard', …]`, `['outbox', …]`. After a mutation, invalidate the keys you changed.
- **Permissions**: `const { can } = useAuth(); can('results.validate')`. Hide or disable controls the user can't use; the server enforces anyway.
- **Formatting**: `const f = useFormat()` → `f.money(v)`, `f.number(v, decimals)`, `f.date(d)`, `f.time(d)`, `f.dateTime(d)`, `f.relative(d)`, `f.age(birthDate)`, `f.duration(minutes)`, `f.today()`. Never `toFixed`/`toLocaleString` in pages. `<Money value={…}/>` for amounts.
- **Bilingual records**: `const bi = useBi(); bi(test, 'name')` picks `nameAr`/`nameEn` for the current language.
- **RTL**: use logical utilities only (`ms-/me-/ps-/pe-/start-/end-/text-start/text-end/border-s/border-e`). Direction icons get `rtl:rotate-180`. Numbers, codes, barcodes, phone numbers and units: wrap with `className="ltr-num"` (or `<Input ltr/>`), and use `font-mono` for barcodes/accessions.
- **Colours**: only tokens (`bg-surface`, `text-ink`, `text-muted`, `border-line`, `bg-accent`, `text-ok/warn/crit/info`, `bg-*-soft`). Tube cap colours only via `<TubeIcon cap=…/>`. Never encode state by colour alone: use `<StatusChip kind status/>` and `<FlagChip flag critical/>`.
- **States**: every list/detail has loading (Skeleton/DataTable `loading`), empty (`EmptyState`), and error (`ErrorState` with retry). Mutations show a toast (`toast.success/error`) with `useErrorMessage()` for API errors.
- **Confirmations**: cancel order, reject sample, amend result, refund, delete → `ConfirmDialog` (with `reason="required"` where the record needs a reason). Medical validation and amendments → `ESignDialog` (password re-entry).
- **Layout**: page = `<PageHeader title description actions/>` then content. Desktop first at 1366×768; avoid horizontal page scroll; tables scroll inside `DataTable`. Side panels (`Drawer`) instead of stacked dialogs. Keyboard friendly: Enter submits, focus first field.
- **Printing**: print pages live under `/print/*` (no app chrome). Open with `openPrint('/print/…')`; in the print page call `usePrintWhenReady(dataLoaded)`. Use `@page` CSS for size (A4 report, 50×25 mm labels, 80 mm receipt).
- **Live**: `useLiveEvent('results.changed', fn)` for extra reactions; invalidation of the standard keys already happens.

## Components (`@/components/ui`)
Button (variant primary|secondary|ghost|subtle|danger|success|link, size sm|md|lg|icon|icon-sm, loading, asChild) ·
Input (invalid, leading, trailing, ltr) · Textarea · SearchInput · Label · Field (label, hint, error, required; children or `(id) => control`) ·
Checkbox · Switch · RadioGroup · Select (options [{value,label,hint}]) · Combobox (searchable; onSearchChange for remote) ·
Dialog (title, description, footer, size sm|md|lg|xl) · Drawer (side panel, width sm|md|lg|xl) · ConfirmDialog (tone, reason) · ESignDialog (onConfirm(password)) ·
Popover/PopoverTrigger/PopoverContent · Tooltip · Menu/MenuTrigger/MenuContent/MenuItem/MenuSeparator/MenuLabel ·
Badge (tone) · StatusChip (kind: order|item|sample|result|invoice|instrument|message|priority|approval|session|review|qc|level|agent|outbox|delivery|user) · FlagChip ·
Card (title, description, actions, padded) · StatTile (label, value, hint, icon, tone, to) · PageHeader (title, description, actions, back, meta) · InfoList ·
Spinner · Skeleton · EmptyState · ErrorState · useErrorMessage · Kbd · TubeIcon (cap) · Segmented · Avatar · Money ·
Tabs/TabsList/TabsTrigger(count)/TabsContent · DataTable (columns, data, loading, error, onRetry, empty, onRowClick, pagination, dense, maxHeight; column `meta.align='end'` for numbers) · Pagination ·
Barcode (Code 128 SVG) · QrCode · DateRangePicker + useTodayRange · toast.
Layout helpers: `RequirePerm` (in `@/components/layout/AppShell`), `LabLogo`.

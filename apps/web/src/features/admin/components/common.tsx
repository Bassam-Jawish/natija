import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi, useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, Button, DateRangePicker, Field, Input, toast, useErrorMessage, type DateRange } from '@/components/ui';

/* ------------------------------------------------------------------ errors */

/** API errors in the user's language: admin-specific codes first, then the shared ones. */
export function useAdminError() {
  const { t, i18n } = useTranslation('admin');
  const base = useErrorMessage();
  return useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        if (i18n.exists(`admin:errors.${err.code}`)) return t(`errors.${err.code}`, { detail: err.message });
        if (err.code === 'validation' && err.errors) {
          const [field, messages] = Object.entries(err.errors)[0] ?? [];
          if (field && messages?.[0]) return `${t(`fields.${field.split('.')[0]}`, { defaultValue: field })}: ${fieldMessage(t, messages[0])}`;
        }
      }
      return base(err);
    },
    [t, i18n, base],
  );
}

function fieldMessage(t: (k: string, o?: Record<string, unknown>) => string, raw: string): string {
  const [code, arg] = raw.split(':');
  return t(`fieldErrors.${code}`, { defaultValue: raw, arg });
}

/** Per-field messages from a 400 validation error, for showing under inputs. */
export function useFieldErrors(error: unknown): Record<string, string> {
  const { t } = useTranslation('admin');
  return useMemo(() => {
    if (!(error instanceof ApiError) || !error.errors) return {};
    const out: Record<string, string> = {};
    for (const [field, msgs] of Object.entries(error.errors)) if (msgs[0]) out[field] = fieldMessage(t, msgs[0]);
    return out;
  }, [error, t]);
}

/* ------------------------------------------------------------------ ranges */

function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Date range kept in the URL (?from=&to=) so reports can be shared and survive a reload. */
export function useRangeParam(defaultDays = 0): [DateRange, (r: DateRange) => void] {
  const f = useFormat();
  const [params, setParams] = useSearchParams();
  const today = f.today();
  const valid = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const range = {
    from: valid(params.get('from')) ?? shift(today, -defaultDays),
    to: valid(params.get('to')) ?? today,
  };
  const set = useCallback(
    (r: DateRange) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('from', r.from);
          next.set('to', r.to);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [range, set];
}

/** One filter row above the content it scopes: date range first, then extra controls. */
export function FilterBar({ range, onRange, children, end }: { range?: DateRange; onRange?: (r: DateRange) => void; children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {range && onRange ? <DateRangePicker value={range} onChange={onRange} /> : null}
      {children}
      {end ? <div className="ms-auto flex flex-wrap items-center gap-2">{end}</div> : null}
    </div>
  );
}

/** Excel export (a CSV file in mock mode). */
export function ExportButton({ path, query, label }: { path: string; query?: Record<string, string | undefined>; label?: string }) {
  const { t } = useTranslation();
  const lang = useLang();
  return (
    <Button variant="secondary" size="sm" onClick={() => void api.download(path, { ...query, lang }).catch((err: unknown) => toast.error(String((err as Error)?.message ?? err)))}>
      <Download />
      {label ?? t('actions.exportExcel')}
    </Button>
  );
}

/* ------------------------------------------------------------------ form pieces */

export function BilingualFields({
  ar,
  en,
  onAr,
  onEn,
  labelAr,
  labelEn,
  errorAr,
  errorEn,
  required = true,
  autoFocus,
}: {
  ar: string;
  en: string;
  onAr: (v: string) => void;
  onEn: (v: string) => void;
  labelAr?: string;
  labelEn?: string;
  errorAr?: string;
  errorEn?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('admin');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={labelAr ?? t('fields.nameAr')} required={required} error={errorAr}>
        {(id) => <Input id={id} dir="rtl" value={ar} onChange={(e) => onAr(e.target.value)} autoFocus={autoFocus} invalid={!!errorAr} />}
      </Field>
      <Field label={labelEn ?? t('fields.nameEn')} required={required} error={errorEn}>
        {(id) => <Input id={id} dir="ltr" className="text-left" value={en} onChange={(e) => onEn(e.target.value)} invalid={!!errorEn} />}
      </Field>
    </div>
  );
}

/** Numeric text box that keeps what the user typed; parse with toNumber() on save. */
export function NumberField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  suffix,
  placeholder,
  className,
  step,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  suffix?: ReactNode;
  placeholder?: string;
  className?: string;
  step?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(id) => {
        const input = (
          <Input
            id={id}
            ltr
            inputMode="decimal"
            type="number"
            step={step ?? 'any'}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            invalid={!!error}
          />
        );
        return suffix ? (
          <div className="flex items-center gap-2">
            {input}
            <span className="shrink-0 text-[12.5px] text-muted">{suffix}</span>
          </div>
        ) : (
          input
        );
      }}
    </Field>
  );
}

/** "" → null; numbers as typed (Arabic digits accepted). */
export function toNumber(v: string): number | null {
  const s = v.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.').replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const numText = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

/* ------------------------------------------------------------------ display pieces */

/** Codes, numbers and barcodes: left-to-right text inside, page-direction margins outside. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[12.5px] text-ink-2', className)}>
      <span className="ltr-num">{children}</span>
    </span>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation('admin');
  return active ? (
    <Badge tone="ok" dot>
      {t('common.active')}
    </Badge>
  ) : (
    <Badge tone="muted" dot>
      {t('common.inactive')}
    </Badge>
  );
}

/** A person's name in the current language from a pair of fields (e.g. requestedByNameAr / …En). */
export function usePairName() {
  const lang = useLang();
  return useCallback((ar: string | null | undefined, en: string | null | undefined) => (lang === 'ar' ? ar || en : en || ar) ?? '', [lang]);
}

export function useName() {
  const bi = useBi();
  return bi;
}

/** Minutes as "1 h 25 m" / "1 س 25 د"; a day or more as "3 d 4 h" / "3 ي 4 س". */
export function useMinutes() {
  const f = useFormat();
  const { t } = useTranslation('admin');
  return useCallback(
    (m: number | null | undefined) => {
      if (m === null || m === undefined) return '—';
      const total = Math.round(m);
      if (total < 1440) return f.duration(total);
      const days = Math.floor(total / 1440);
      const hours = Math.floor((total % 1440) / 60);
      return t('common.daysHours', { d: f.number(days), h: f.number(hours) });
    },
    [f, t],
  );
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[13px] font-semibold text-ink-2">{children}</h3>
      {actions}
    </div>
  );
}

/** Small "label · value" line used in summaries. */
export function Metric({ label, value, tone, strong }: { label: ReactNode; value: ReactNode; tone?: 'ok' | 'warn' | 'crit' | 'muted'; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className={cn('tabular ltr-num', strong ? 'font-semibold text-ink' : 'text-ink-2', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', tone === 'crit' && 'text-crit')}>{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ tabs, clipboard, dialogs */

/** The open tab kept in the URL (?tab=…) so a reload or a shared link lands on it. */
export function useTabParam<T extends string>(allowed: readonly T[], fallback: T): [T, (tab: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab = (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
  const set = useCallback(
    (next: string) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === fallback) p.delete('tab');
          else p.set('tab', next);
          return p;
        },
        { replace: true },
      ),
    [setParams, fallback],
  );
  return [tab, set];
}

/** Copy text to the clipboard; resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** For confirm dialogs: wait for the mutation, but let its own onError (toast) report failures. */
export function settle(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => undefined,
    () => undefined,
  );
}

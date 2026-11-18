import { useCallback, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CATALOG_CAP_COLORS, type CatalogAnalyte } from '@natija/contracts';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, TubeIcon, toast, type Tone } from '@/components/ui';
import { adminKeys } from '../../api';
import { useAdminError } from '../common';

/** Everything cached for the catalog (lists, details, lookups) and the price list built from it. */
export async function invalidateCatalog(qc: QueryClient) {
  await Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'catalog'] }), qc.invalidateQueries({ queryKey: ['admin', 'pricing'] })]);
}

/** A catalog write: toast on success or error, then refresh the catalog caches. */
export function useCatalogSave<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>, opts: { success?: string; onSuccess?: (result: TResult) => void } = {}) {
  const qc = useQueryClient();
  const { t } = useTranslation('admin');
  const errorMessage = useAdminError();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result) => {
      await invalidateCatalog(qc);
      toast.success(opts.success ?? t('common.saved'));
      opts.onSuccess?.(result);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export function useAnalytes() {
  return useQuery({ queryKey: adminKeys.analytes(), queryFn: () => api.get<CatalogAnalyte[]>('/catalog/analytes'), staleTime: 60_000 });
}

/* ------------------------------------------------------------------ ages */

export type AgeUnit = 'days' | 'months' | 'years';
export const AGE_UNIT_DAYS: Record<AgeUnit, number> = { days: 1, months: 30, years: 365 };
export type AgeValue = { value: string; unit: AgeUnit };

/** Show stored days in the largest unit that keeps them exact (365 → 1 year, 4381 → 4381 days). */
export function splitAge(days: number | null | undefined): AgeValue {
  if (days === null || days === undefined) return { value: '', unit: 'years' };
  if (days === 0) return { value: '0', unit: 'years' };
  if (days % 365 === 0) return { value: String(days / 365), unit: 'years' };
  if (days % 30 === 0) return { value: String(days / 30), unit: 'months' };
  return { value: String(days), unit: 'days' };
}

/** Days from a number and unit; "" means no value. */
export function ageDays(age: AgeValue): number | null {
  const raw = age.value.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.');
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * AGE_UNIT_DAYS[age.unit]);
}

/** "12 y 1 d" / "12 سنة 1 يوم" from days. */
export function useAgeText() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  return useCallback(
    (days: number | null | undefined) => {
      if (days === null || days === undefined) return t('catalog.ranges.noLimit');
      if (days === 0) return t('catalog.ranges.birth');
      const years = Math.floor(days / 365);
      const months = Math.floor((days % 365) / 30);
      const rest = days - years * 365 - months * 30;
      const parts: string[] = [];
      if (years) parts.push(t('catalog.ranges.ageYears', { n: f.number(years) }));
      if (months) parts.push(t('catalog.ranges.ageMonths', { n: f.number(months) }));
      if (rest) parts.push(t('catalog.ranges.ageDays', { n: f.number(rest) }));
      return parts.join(' ');
    },
    [t, f],
  );
}

/* ------------------------------------------------------------------ small pieces */

const TYPE_TONES: Record<string, Tone> = { numeric: 'info', text: 'neutral', option: 'violet', calculated: 'accent' };

export function AnalyteTypeBadge({ type }: { type: string }) {
  const { t } = useTranslation('admin');
  return <Badge tone={TYPE_TONES[type] ?? 'neutral'}>{t(`catalog.analytes.types.${type}`, { defaultValue: type })}</Badge>;
}

/** Tube cap colour picker: a row of tube swatches with the colour's name. */
export function CapColorPicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const { t } = useTranslation('admin');
  return (
    <div role="radiogroup" aria-label={t('catalog.simple.fields.capColor')} className="flex flex-wrap gap-1.5">
      {CATALOG_CAP_COLORS.map((cap) => {
        const selected = value === cap;
        return (
          <button
            key={cap}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(cap)}
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-lg border px-2 text-[12.5px] transition-colors disabled:opacity-50',
              selected ? 'border-accent bg-accent-soft text-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong',
            )}
          >
            <TubeIcon cap={cap} className="h-5 w-3" title={t(`catalog.caps.${cap}`)} />
            {t(`catalog.caps.${cap}`)}
          </button>
        );
      })}
    </div>
  );
}

/** "Yes" as a small check, "no" as a dash, for dense boolean columns. */
export function YesMark({ value, label }: { value: boolean; label?: string }) {
  const { t } = useTranslation('admin');
  return value ? (
    <span className="text-ok" title={label ?? t('common.yes')} aria-label={label ?? t('common.yes')}>
      ✓
    </span>
  ) : (
    <span className="text-faint" aria-label={t('common.no')}>
      —
    </span>
  );
}

/** A titled block inside an editor drawer, separated from the next by a hairline. */
export function FormSection({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line pb-5 last:border-0 last:pb-0 [&:not(:first-child)]:pt-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
          {description ? <p className="mt-0.5 text-[12.5px] text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

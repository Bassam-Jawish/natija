import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { Input, Select } from './form';

export type DateRange = { from: string; to: string };

function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date range in the lab's time zone. */
export function useTodayRange(): DateRange {
  const f = useFormat();
  const today = f.today();
  return { from: today, to: today };
}

/** Preset + from/to date inputs. Dates are calendar days (YYYY-MM-DD) in the lab's time zone. */
export function DateRangePicker({ value, onChange, className }: { value: DateRange; onChange: (v: DateRange) => void; className?: string }) {
  const { t } = useTranslation();
  const f = useFormat();
  const today = f.today();
  const presets: Record<string, DateRange> = {
    today: { from: today, to: today },
    yesterday: { from: shift(today, -1), to: shift(today, -1) },
    last7: { from: shift(today, -6), to: today },
    last30: { from: shift(today, -29), to: today },
    month: { from: `${today.slice(0, 8)}01`, to: today },
  };
  const current = Object.entries(presets).find(([, r]) => r.from === value.from && r.to === value.to)?.[0] ?? 'custom';
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      <Select
        size="sm"
        value={current}
        onValueChange={(v) => v !== 'custom' && onChange(presets[v]!)}
        className="w-40"
        options={[
          { value: 'today', label: t('dateRange.today') },
          { value: 'yesterday', label: t('dateRange.yesterday') },
          { value: 'last7', label: t('dateRange.last7') },
          { value: 'last30', label: t('dateRange.last30') },
          { value: 'month', label: t('dateRange.month') },
          { value: 'custom', label: t('dateRange.custom') },
        ]}
      />
      <Input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} className="h-8 w-[150px]" aria-label={t('dateRange.from')} />
      <span className="text-muted">–</span>
      <Input type="date" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} className="h-8 w-[150px]" aria-label={t('dateRange.to')} />
    </div>
  );
}

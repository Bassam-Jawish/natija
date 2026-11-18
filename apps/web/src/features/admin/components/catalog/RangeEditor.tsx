import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, Copy, Info, Loader2, Plus, Trash2 } from 'lucide-react';
import type { CatalogLookups, CatalogRange, CatalogRangeCheck, CatalogRangeIssue } from '@natija/contracts';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, Button, EmptyState, Input, Select } from '@/components/ui';
import { numText, toNumber, useAdminError } from '../common';
import { ageDays, splitAge, useAgeText, type AgeUnit, type AgeValue } from './shared';

export type RangeRowState = {
  key: string;
  sex: 'any' | 'male' | 'female';
  ageMin: AgeValue;
  ageMax: AgeValue;
  low: string;
  high: string;
  criticalLow: string;
  criticalHigh: string;
  textRange: string;
  sampleTypeId: string;
  instrumentId: string;
  note: string;
  more: boolean;
};

let seq = 0;
const newKey = () => `r${++seq}`;

export function emptyRow(): RangeRowState {
  return {
    key: newKey(),
    sex: 'any',
    ageMin: { value: '0', unit: 'years' },
    ageMax: { value: '', unit: 'years' },
    low: '',
    high: '',
    criticalLow: '',
    criticalHigh: '',
    textRange: '',
    sampleTypeId: '',
    instrumentId: '',
    note: '',
    more: false,
  };
}

export function rowFromRange(r: CatalogRange): RangeRowState {
  return {
    key: newKey(),
    sex: r.sex,
    ageMin: splitAge(r.ageMinDays),
    ageMax: splitAge(r.ageMaxDays),
    low: numText(r.low),
    high: numText(r.high),
    criticalLow: numText(r.criticalLow),
    criticalHigh: numText(r.criticalHigh),
    textRange: r.textRange ?? '',
    sampleTypeId: r.sampleTypeId ?? '',
    instrumentId: r.instrumentId ?? '',
    note: r.note ?? '',
    more: !!(r.sampleTypeId || r.instrumentId || r.note),
  };
}

/** The row as the API expects it (CatalogRangeInput). */
export function rowToApi(r: RangeRowState) {
  return {
    sex: r.sex,
    ageMinDays: ageDays(r.ageMin) ?? 0,
    ageMaxDays: ageDays(r.ageMax),
    low: toNumber(r.low),
    high: toNumber(r.high),
    criticalLow: toNumber(r.criticalLow),
    criticalHigh: toNumber(r.criticalHigh),
    textRange: r.textRange.trim() || null,
    sampleTypeId: r.sampleTypeId || null,
    instrumentId: r.instrumentId || null,
    note: r.note.trim() || null,
  };
}

/** Server-side errors from a refused save ({'rows.2': ['overlap:0']}) as range issues. */
export function issuesFromErrors(errors: Record<string, string[]> | undefined): CatalogRangeIssue[] {
  const out: CatalogRangeIssue[] = [];
  for (const [field, list] of Object.entries(errors ?? {})) {
    const m = /^rows\.(\d+)$/.exec(field);
    if (!m) continue;
    for (const msg of list) {
      const [code, other] = msg.split(':');
      out.push({ row: Number(m[1]), code: code ?? msg, other: other !== undefined ? Number(other) : undefined });
    }
  }
  return out;
}

function AgeInput({ value, onChange, placeholder, label, disabled }: { value: AgeValue; onChange: (v: AgeValue) => void; placeholder?: string; label: string; disabled?: boolean }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex items-center" role="group" aria-label={label}>
      <Input
        ltr
        type="number"
        min={0}
        step="any"
        value={value.value}
        onChange={(e) => onChange({ ...value, value: e.target.value })}
        placeholder={placeholder}
        disabled={disabled}
        className="h-8 w-16 rounded-e-none px-2 text-center"
        aria-label={label}
      />
      <Select
        size="sm"
        className="w-[86px] rounded-s-none border-s-0"
        value={value.unit}
        onValueChange={(u) => onChange({ ...value, unit: u as AgeUnit })}
        disabled={disabled}
        options={(['days', 'months', 'years'] as const).map((u) => ({ value: u, label: t(`catalog.ranges.units.${u}`) }))}
      />
    </div>
  );
}

function NumberBox({ label, value, onChange, disabled, tone }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; tone?: 'crit' }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className={cn('text-[11.5px] font-medium', tone === 'crit' ? 'text-crit' : 'text-muted')}>{label}</span>
      <Input ltr type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="h-8 px-2" />
    </label>
  );
}

/**
 * Reference ranges of one analyte, edited as a list of rows. Each change is checked on the
 * server (dry run): overlapping rows and inverted limits are errors, critical limits inside the
 * normal range are warnings, and ages left without any range are listed as gaps.
 */
export function RangeEditor({
  analyteId,
  resultType,
  unit,
  rows,
  onChange,
  lookups,
  readOnly,
  serverIssues,
}: {
  analyteId: string;
  resultType: string;
  unit: string;
  rows: RangeRowState[];
  onChange: (rows: RangeRowState[]) => void;
  lookups: CatalogLookups | undefined;
  readOnly?: boolean;
  serverIssues?: CatalogRangeIssue[];
}) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const ageText = useAgeText();
  const numeric = resultType === 'numeric' || resultType === 'calculated';
  const payload = useMemo(() => JSON.stringify(rows.map(rowToApi)), [rows]);
  const debounced = useDebounced(payload, 400);
  const check = useQuery({
    queryKey: ['admin', 'catalog', 'range-check', analyteId, debounced],
    queryFn: () => api.post<CatalogRangeCheck>(`/catalog/analytes/${analyteId}/ranges/check`, { rows: JSON.parse(debounced) as unknown[] }),
    enabled: !readOnly,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const errorMessage = useAdminError();
  const current = debounced === payload && !check.isError ? check.data : undefined;
  const issues = [...(current?.errors ?? []), ...(serverIssues ?? [])];
  const warnings = current?.warnings ?? [];
  const byRow = (list: CatalogRangeIssue[], i: number) => list.filter((x) => x.row === i);

  const update = (key: string, patch: Partial<RangeRowState>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const duplicate = (index: number) => {
    const copy = { ...rows[index]!, key: newKey() };
    onChange([...rows.slice(0, index + 1), copy, ...rows.slice(index + 1)]);
  };
  const remove = (key: string) => onChange(rows.filter((r) => r.key !== key));

  const issueText = (x: CatalogRangeIssue) => t(`catalog.ranges.issues.${x.code}`, { defaultValue: x.code, other: x.other !== undefined ? x.other + 1 : '' });
  const sexOptions = (['any', 'male', 'female'] as const).map((s) => ({ value: s, label: t(`sex.${s}`) }));
  const specimenOptions = [{ value: 'none', label: t('catalog.ranges.anySpecimen') }, ...(lookups?.sampleTypes ?? []).map((s) => ({ value: s.id, label: bi(s, 'name') }))];
  const instrumentOptions = [{ value: 'none', label: t('catalog.ranges.anyAnalyzer') }, ...(lookups?.instruments ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))];

  return (
    <div className="flex flex-col gap-2.5">
      {rows.length === 0 ? (
        <EmptyState
          className="rounded-lg border border-dashed border-line py-8"
          icon={Info}
          title={t('catalog.ranges.empty')}
          description={t('catalog.ranges.emptyHint')}
          action={
            !readOnly ? (
              <Button size="sm" onClick={() => onChange([emptyRow()])}>
                <Plus />
                {t('catalog.ranges.addRow')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        rows.map((r, i) => {
          const errs = byRow(issues, i);
          const warns = byRow(warnings, i);
          const min = ageDays(r.ageMin);
          const max = ageDays(r.ageMax);
          return (
            <div
              key={r.key}
              className={cn(
                'rounded-lg border bg-surface p-3',
                errs.length ? 'border-crit bg-crit-soft/30' : warns.length ? 'border-warn' : 'border-line',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sunken text-[11.5px] font-semibold text-ink-2 tabular ltr-num">{i + 1}</span>
                <Select size="sm" className="w-28" value={r.sex} onValueChange={(v) => update(r.key, { sex: v as RangeRowState['sex'] })} options={sexOptions} disabled={readOnly} />
                <span className="ms-1 text-[12px] text-muted">{t('catalog.ranges.ageFrom')}</span>
                <AgeInput value={r.ageMin} onChange={(v) => update(r.key, { ageMin: v })} label={t('catalog.ranges.ageFrom')} disabled={readOnly} />
                <span className="text-[12px] text-muted">{t('catalog.ranges.ageTo')}</span>
                <AgeInput value={r.ageMax} onChange={(v) => update(r.key, { ageMax: v })} placeholder="∞" label={t('catalog.ranges.ageTo')} disabled={readOnly} />
                <span className="text-[12px] text-muted">{min !== null ? (max !== null ? `${ageText(min)} – ${ageText(max)}` : t('catalog.ranges.andOlder', { age: ageText(min) })) : ''}</span>
                {!readOnly ? (
                  <span className="ms-auto flex items-center">
                    <Button variant="ghost" size="icon-sm" onClick={() => duplicate(i)} aria-label={t('catalog.ranges.duplicateRow')} title={t('catalog.ranges.duplicateRow')}>
                      <Copy />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => remove(r.key)} aria-label={t('catalog.ranges.removeRow')} title={t('catalog.ranges.removeRow')}>
                      <Trash2 />
                    </Button>
                  </span>
                ) : null}
              </div>
              <div className={cn('mt-2.5 grid gap-2', numeric ? 'grid-cols-2 sm:grid-cols-[repeat(4,minmax(0,7.5rem))_1fr]' : 'grid-cols-1')}>
                {numeric ? (
                  <>
                    <NumberBox label={t('catalog.ranges.low')} value={r.low} onChange={(v) => update(r.key, { low: v })} disabled={readOnly} />
                    <NumberBox label={t('catalog.ranges.high')} value={r.high} onChange={(v) => update(r.key, { high: v })} disabled={readOnly} />
                    <NumberBox label={t('catalog.ranges.criticalLow')} value={r.criticalLow} onChange={(v) => update(r.key, { criticalLow: v })} disabled={readOnly} tone="crit" />
                    <NumberBox label={t('catalog.ranges.criticalHigh')} value={r.criticalHigh} onChange={(v) => update(r.key, { criticalHigh: v })} disabled={readOnly} tone="crit" />
                  </>
                ) : null}
                <label className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1">
                  <span className="text-[11.5px] font-medium text-muted">{numeric ? t('catalog.ranges.textRange') : t('catalog.ranges.expected')}</span>
                  <Input
                    value={r.textRange}
                    onChange={(e) => update(r.key, { textRange: e.target.value })}
                    disabled={readOnly}
                    className="h-8 px-2"
                    dir="auto"
                    placeholder={numeric ? t('catalog.ranges.textHint') : t('catalog.ranges.expectedHint')}
                  />
                </label>
              </div>
              {r.more ? (
                <div className="mt-2.5 grid gap-2 sm:grid-cols-[12rem_14rem_1fr]">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-[11.5px] font-medium text-muted">{t('catalog.ranges.specimen')}</span>
                    <Select size="sm" value={r.sampleTypeId || 'none'} onValueChange={(v) => update(r.key, { sampleTypeId: v === 'none' ? '' : v })} options={specimenOptions} disabled={readOnly} />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-[11.5px] font-medium text-muted">{t('catalog.ranges.analyzer')}</span>
                    <Select size="sm" value={r.instrumentId || 'none'} onValueChange={(v) => update(r.key, { instrumentId: v === 'none' ? '' : v })} options={instrumentOptions} disabled={readOnly} />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-[11.5px] font-medium text-muted">{t('catalog.ranges.note')}</span>
                    <Input value={r.note} onChange={(e) => update(r.key, { note: e.target.value })} disabled={readOnly} className="h-8 px-2" dir="auto" />
                  </label>
                </div>
              ) : (
                <button type="button" className="mt-2 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink" onClick={() => update(r.key, { more: true })}>
                  <ChevronDown className="size-3.5" />
                  {t('catalog.ranges.more')}
                </button>
              )}
              {errs.length || warns.length ? (
                <ul className="mt-2 flex flex-col gap-0.5 text-[12.5px]">
                  {errs.map((x, k) => (
                    <li key={`e${k}`} className="flex items-center gap-1.5 text-crit">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      {issueText(x)}
                    </li>
                  ))}
                  {warns.map((x, k) => (
                    <li key={`w${k}`} className="flex items-center gap-1.5 text-warn">
                      <Info className="size-3.5 shrink-0" />
                      {issueText(x)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })
      )}

      {rows.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly ? (
            <Button size="sm" onClick={() => onChange([...rows, emptyRow()])}>
              <Plus />
              {t('catalog.ranges.addRow')}
            </Button>
          ) : null}
          {check.isFetching || debounced !== payload ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
              <Loader2 className="size-3.5 animate-spin" />
              {t('catalog.ranges.checking')}
            </span>
          ) : check.isError ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-crit">
              <AlertTriangle className="size-3.5" />
              {errorMessage(check.error)}
            </span>
          ) : current ? (
            <span className="flex flex-wrap items-center gap-1.5">
              {current.errors.length ? <Badge tone="crit">{t('catalog.ranges.errorsCount', { count: current.errors.length })}</Badge> : <Badge tone="ok">{t('catalog.ranges.valid')}</Badge>}
              {current.warnings.length ? <Badge tone="warn">{t('catalog.ranges.warningsCount', { count: current.warnings.length })}</Badge> : null}
            </span>
          ) : null}
          {unit ? <span className="ms-auto text-[12px] text-muted">{t('catalog.ranges.unitNote', { unit })}</span> : null}
        </div>
      ) : null}

      {current && rows.length ? (
        <div className={cn('rounded-lg border px-3 py-2 text-[12.5px]', current.gaps.length ? 'border-warn bg-warn-soft/40' : 'border-line bg-sunken/50')}>
          {current.gaps.length ? (
            <>
              <p className="mb-1 font-medium text-warn">{t('catalog.ranges.gapsTitle')}</p>
              <ul className="flex flex-col gap-0.5 text-ink-2">
                {current.gaps.map((g, k) => (
                  <li key={k}>
                    <span className="font-medium">{t(`sex.${g.sex}`)}</span>
                    {': '}
                    {g.toDays === null ? t('catalog.ranges.andOlder', { age: ageText(g.fromDays) }) : `${ageText(g.fromDays)} – ${ageText(g.toDays)}`}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-muted">{t('catalog.ranges.gapsHint')}</p>
            </>
          ) : (
            <p className="text-muted">{t('catalog.ranges.noGaps')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

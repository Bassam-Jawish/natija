import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareText, RotateCcw } from 'lucide-react';
import type { BenchResult } from '@natija/contracts';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, Checkbox, FlagChip, StatusChip, Tooltip } from '@/components/ui';
import { PreviousValue, ResultValue, SourceIcon } from './common';

const EDITABLE = new Set(['pending', 'resulted', 'verified']);

export function isEditable(r: BenchResult) {
  return EDITABLE.has(r.status) && r.analyte.resultType !== 'calculated';
}

/** Move focus between result fields (Enter / ↓ forward, Shift+Enter / ↑ back). */
export function focusEntry(from: HTMLElement, delta: 1 | -1) {
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-entry]:not([disabled])'));
  const next = all[all.indexOf(from) + delta];
  if (!next) return;
  next.focus();
  if (next instanceof HTMLInputElement) next.select();
}

function onEntryKey(e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
  const isSelect = e.currentTarget instanceof HTMLSelectElement;
  if (e.key === 'Enter') {
    e.preventDefault();
    focusEntry(e.currentTarget, e.shiftKey ? -1 : 1);
  } else if (!isSelect && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    focusEntry(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
  }
}

const field =
  'h-8 w-full min-w-[96px] rounded-md border bg-surface px-2 text-sm text-ink transition-colors focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 disabled:bg-sunken disabled:text-muted';

function ResultInput({ result, value, onChange, error }: { result: BenchResult; value: string; onChange: (v: string) => void; error?: string }) {
  const bi = useBi();
  const label = bi(result.analyte, 'name');
  const cls = cn(field, error ? 'border-crit' : 'border-line-strong');
  if (result.analyte.resultType === 'option' && result.analyte.options.length) {
    return (
      <select data-entry aria-label={label} aria-invalid={!!error || undefined} className={cls} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onEntryKey}>
        <option value="">—</option>
        {result.analyte.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {value && !result.analyte.options.includes(value) ? <option value={value}>{value}</option> : null}
      </select>
    );
  }
  const numeric = result.analyte.resultType === 'numeric';
  return (
    <input
      data-entry
      aria-label={label}
      aria-invalid={!!error || undefined}
      className={cn(cls, numeric && 'ltr-num text-left tabular')}
      dir={numeric ? 'ltr' : undefined}
      inputMode={numeric ? 'decimal' : undefined}
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onEntryKey}
      onFocus={(e) => e.currentTarget.select()}
    />
  );
}

export type ResultTableProps = {
  results: BenchResult[];
  mode: 'entry' | 'review';
  drafts?: Record<string, string>;
  fieldErrors?: Record<string, string>;
  onDraft?: (result: BenchResult, value: string) => void;
  selected?: Set<string>;
  onSelect?: (ids: string[], on: boolean) => void;
  canSelect?: (result: BenchResult) => boolean;
  actions?: (result: BenchResult) => ReactNode;
};

/**
 * Results of one tube or order, grouped under their test. In entry mode every editable value
 * is a field (numbers, option lists, text); calculated and validated values are read-only.
 */
export function ResultTable({ results, mode, drafts = {}, fieldErrors = {}, onDraft, selected, onSelect, canSelect, actions }: ResultTableProps) {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const selectable = results.filter((r) => onSelect && (canSelect ? canSelect(r) : true));
  const allOn = selectable.length > 0 && selectable.every((r) => selected?.has(r.id));
  const someOn = selectable.some((r) => selected?.has(r.id));
  const multiTest = new Set(results.map((r) => r.orderItemId)).size > 1;
  const cols = 6 + (onSelect ? 1 : 0) + (actions ? 1 : 0);
  const people = (r: BenchResult) =>
    [r.enteredBy ? t('table.enteredBy', { name: bi(r.enteredBy, 'fullName') }) : null, r.verifiedBy ? t('table.verifiedBy', { name: bi(r.verifiedBy, 'fullName') }) : null]
      .filter(Boolean)
      .join(' · ');
  let lastItem = '';

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">
            {onSelect ? (
              <th className="w-8 px-2.5 py-1.5">
                <Checkbox checked={allOn ? true : someOn ? 'indeterminate' : false} disabled={!selectable.length} onCheckedChange={(v) => onSelect(selectable.map((r) => r.id), v)} />
              </th>
            ) : null}
            <th className="px-2.5 py-1.5 text-start">{t('table.test')}</th>
            <th className="px-2.5 py-1.5 text-start">{t('table.result')}</th>
            <th className="px-2.5 py-1.5 text-start">{t('table.flag')}</th>
            <th className="px-2.5 py-1.5 text-start">{t('table.reference')}</th>
            <th className="px-2.5 py-1.5 text-start">{t('table.previous')}</th>
            <th className="px-2.5 py-1.5 text-start">{t('table.status')}</th>
            {actions ? <th className="px-2 py-1.5" /> : null}
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const header = multiTest && r.orderItemId !== lastItem;
            lastItem = r.orderItemId;
            const editable = mode === 'entry' && !!onDraft && isEditable(r);
            const draft = drafts[r.id];
            const dirty = draft !== undefined && draft !== (r.value ?? '');
            const value = draft ?? r.value ?? '';
            const canTick = !!onSelect && (canSelect ? canSelect(r) : true);
            return (
              <Fragment key={r.id}>
                {header ? (
                  <tr className="border-t border-line bg-sunken/60">
                    <td colSpan={cols} className="px-2.5 py-1 text-[12.5px] font-semibold text-ink-2">
                      {bi(r.test, 'name')}
                      <span className="ms-2 ltr-num font-mono text-[11px] font-normal text-faint">{r.test.code}</span>
                    </td>
                  </tr>
                ) : null}
                <tr className={cn('border-t border-line align-middle', r.isCritical && r.status !== 'released' && 'bg-crit-soft/40', dirty && 'bg-accent-soft/40')}>
                  {onSelect ? (
                    <td className="px-2.5 py-1">
                      {canTick ? <Checkbox checked={!!selected?.has(r.id)} onCheckedChange={(v) => onSelect([r.id], v)} /> : null}
                    </td>
                  ) : null}
                  <td className="min-w-[150px] px-2.5 py-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="text-ink">{bi(r.analyte, 'name')}</span>
                      <span className="ltr-num font-mono text-[11px] text-faint">{r.analyte.code}</span>
                      {r.comment ? (
                        <Tooltip content={r.comment}>
                          <MessageSquareText className="size-3.5 text-info" aria-label={t('entry.comment')} />
                        </Tooltip>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-2.5 py-1">
                    <div className="flex items-center gap-1.5">
                      {editable ? (
                        <div className="w-[150px] shrink-0">
                          <ResultInput result={r} value={value} onChange={(v) => onDraft!(r, v)} error={fieldErrors[r.id]} />
                        </div>
                      ) : (
                        <ResultValue result={r} hideFlag />
                      )}
                      {r.unit ? <span className="ltr-num text-[12px] whitespace-nowrap text-muted">{r.unit}</span> : null}
                      {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-accent" title={t('entry.unsaved')} /> : null}
                    </div>
                    {fieldErrors[r.id] ? <div className="mt-0.5 text-[11.5px] text-crit">{fieldErrors[r.id]}</div> : null}
                  </td>
                  <td className="px-2.5 py-1">{dirty ? <span className="text-[11.5px] text-muted">…</span> : <FlagChip flag={r.flag} critical={r.isCritical} />}</td>
                  <td className="px-2.5 py-1 text-[12.5px] whitespace-nowrap text-muted">
                    <span className="ltr-num">{r.refText ?? '—'}</span>
                  </td>
                  <td className="px-2.5 py-1 text-[12.5px]">
                    <PreviousValue result={r} />
                  </td>
                  <td className="px-2.5 py-1">
                    <div className="flex items-center gap-1.5">
                      <Tooltip content={people(r) || null}>
                        <span>
                          <StatusChip kind="result" status={r.status} />
                        </span>
                      </Tooltip>
                      <SourceIcon result={r} />
                      {r.rerunRequested ? (
                        <Badge tone="warn" className="h-[20px] text-[11px]">
                          <RotateCcw className="size-3" />
                          {t('entry.rerun')}
                        </Badge>
                      ) : null}
                      {r.amended ? (
                        <Badge tone="warn" className="h-[20px] text-[11px]">
                          {t('amend.badge')}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  {actions ? <td className="px-2 py-1 text-end whitespace-nowrap">{actions(r)}</td> : null}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

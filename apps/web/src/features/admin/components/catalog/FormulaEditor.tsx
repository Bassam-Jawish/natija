import { useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { CatalogFormulaCheck } from '@natija/contracts';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Input, Textarea } from '@/components/ui';

const FUNCTIONS = ['min( , )', 'max( , )', 'pow( , )', 'abs()', 'sqrt()', 'log()', 'ln()', 'exp()', 'if( , , )'];
const OPERATORS = ['+', '-', '*', '/', '^', '(', ')'];

/**
 * Formula for a calculated analyte, checked as you type: the server parses it and lists unknown
 * codes and circular references. Variables (analyte codes, AGE, FEMALE) insert at the cursor.
 */
export function FormulaEditor({
  value,
  onChange,
  code,
  analyteId,
  readOnly,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  code: string;
  analyteId: string | null;
  readOnly?: boolean;
  error?: string;
}) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [filter, setFilter] = useState('');
  const formula = useDebounced(value, 350);
  const codeParam = /^[A-Za-z_][A-Za-z0-9_.%#]*$/.test(code.trim()) ? code.trim() : undefined;
  const check = useQuery({
    queryKey: ['admin', 'catalog', 'formula-check', analyteId ?? 'new', codeParam ?? '', formula],
    queryFn: () => api.post<CatalogFormulaCheck>('/catalog/formula/check', { formula, analyteId: analyteId ?? undefined, code: codeParam }),
    enabled: !readOnly,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const pending = check.isFetching || formula !== value;
  const result = check.data;

  const allowed = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return (result?.allowed ?? []).filter((a) => !term || a.code.toLowerCase().includes(term) || a.nameEn.toLowerCase().includes(term) || a.nameAr.includes(filter.trim()));
  }, [result?.allowed, filter]);

  const insert = (text: string) => {
    if (readOnly) return;
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const pad = (s: string) => (/[\w%#)]$/.test(before) && /^[A-Za-z_(]/.test(s) ? ` ${s}` : s);
    const piece = pad(text);
    const next = `${before}${piece}${after}`;
    onChange(next);
    const caret = before.length + (piece.includes('(') && piece.endsWith(')') && piece.length > 2 ? piece.indexOf('(') + 1 : piece.length);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  let status: { tone: 'ok' | 'crit' | 'muted'; text: string };
  if (!value.trim()) status = { tone: 'muted', text: t('catalog.formula.empty') };
  else if (pending && !result) status = { tone: 'muted', text: t('catalog.formula.checking') };
  else if (!result) status = { tone: 'muted', text: '' };
  else if (result.error && result.error !== 'empty') status = { tone: 'crit', text: t('catalog.formula.error', { detail: result.error }) };
  else if (result.unknown.length) status = { tone: 'crit', text: t('catalog.formula.unknown', { codes: result.unknown.join(', ') }) };
  else if (result.cycle) status = { tone: 'crit', text: t('catalog.formula.cycle', { path: result.cycle.join(' → ') }) };
  else if (result.ok) status = { tone: 'ok', text: t('catalog.formula.ok', { codes: result.variables.join(', ') || '—' }) };
  else status = { tone: 'muted', text: '' };

  const chip = 'rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink-2 transition-colors hover:border-accent hover:text-ink disabled:opacity-50';

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={ref}
        dir="ltr"
        rows={3}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        invalid={!!error || status.tone === 'crit'}
        placeholder="CHOL - HDL - TG / 5"
        className="font-mono text-[13px]"
        spellCheck={false}
        aria-label={t('fields.formula')}
      />
      <div className={cn('flex min-h-5 items-start gap-1.5 text-[12.5px]', status.tone === 'ok' && 'text-ok', status.tone === 'crit' && 'text-crit', status.tone === 'muted' && 'text-muted')}>
        {pending && value.trim() ? (
          <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
        ) : status.tone === 'ok' ? (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
        ) : status.tone === 'crit' ? (
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        ) : null}
        <span className="min-w-0 break-words">{error ?? status.text}</span>
      </div>
      {!readOnly ? (
        <div className="rounded-lg border border-line bg-sunken/60 p-2.5">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="me-1 text-[12px] font-medium text-muted">{t('catalog.formula.builtins')}</span>
            <button type="button" className={chip} onClick={() => insert('AGE')} title={t('catalog.formula.age')}>
              AGE
            </button>
            <button type="button" className={chip} onClick={() => insert('FEMALE')} title={t('catalog.formula.female')}>
              FEMALE
            </button>
            <span className="mx-1 h-4 w-px bg-line" />
            {OPERATORS.map((op) => (
              <button key={op} type="button" className={cn(chip, 'min-w-7 text-center')} onClick={() => insert(op === '(' || op === ')' ? op : ` ${op} `)}>
                {op}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-line" />
            {FUNCTIONS.map((fn) => (
              <button key={fn} type="button" className={chip} onClick={() => insert(fn.replace(/ /g, ''))}>
                {fn.split('(')[0]}()
              </button>
            ))}
          </div>
          <p className="mb-2 text-[12px] text-muted">{t('catalog.formula.help')}</p>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-medium text-muted">{t('catalog.formula.variables')}</span>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('catalog.formula.searchVariables')} className="h-7 max-w-52 text-[12.5px]" />
          </div>
          <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto" dir="ltr">
            {allowed.map((a) => (
              <button key={a.code} type="button" className={chip} onClick={() => insert(a.code)} title={`${bi(a, 'name')}${a.unit ? ` (${a.unit})` : ''}`}>
                {a.code}
              </button>
            ))}
            {result && !allowed.length ? <span className="text-[12px] text-muted">{t('catalog.formula.noVariables')}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

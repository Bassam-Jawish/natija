import { useEffect, useState, type Ref } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, UserPlus, X } from 'lucide-react';
import type { PatientListItem } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { Button, Input, Kbd, Skeleton } from '@/components/ui';
import { fd, keys } from '../api';
import { FdErrorState, PatientMeta, usePatientName } from './shared';

export type NewPatientPrefill = { firstNameAr?: string; fatherNameAr?: string; lastNameAr?: string; phone?: string };

/** Turn what was typed into a head start for the new-patient form (a phone, or first … family name). */
export function prefillFrom(text: string): NewPatientPrefill {
  const s = text.trim();
  if (!s) return {};
  if (/^[\d\s+()-]{6,}$/.test(s)) return { phone: s };
  const words = s.split(/\s+/);
  if (words.length === 1) return { firstNameAr: words[0] };
  return { firstNameAr: words[0], lastNameAr: words[words.length - 1], fatherNameAr: words.length > 2 ? words.slice(1, -1).join(' ') : undefined };
}

/** Search existing patients by name (Arabic or Latin), phone or MRN; ↑ ↓ to move, Enter to pick. */
export function PatientFinder({
  onSelect,
  onCreate,
  inputRef,
  autoFocus,
  excludeId,
  className,
}: {
  onSelect: (p: PatientListItem) => void;
  onCreate?: (prefill: NewPatientPrefill) => void;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  excludeId?: string;
  className?: string;
}) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const name = usePatientName();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const term = useDebounced(q.trim(), 250);
  const params = { q: term, limit: 8 };
  const list = useQuery({
    queryKey: keys.patients(params),
    queryFn: () => fd.patients(params),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
  });
  const rows = term.length >= 2 ? (list.data?.items ?? []).filter((p) => p.id !== excludeId) : [];
  useEffect(() => setActive(0), [term]);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('finder.placeholder')}
        leading={<Search />}
        trailing={
          q ? (
            <button type="button" className="rounded p-0.5 hover:text-ink" onClick={() => setQ('')} aria-label={t('common:actions.clear')}>
              <X />
            </button>
          ) : null
        }
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, Math.max(rows.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (rows[active]) onSelect(rows[active]!);
            else if (term.length >= 2 && !list.isFetching && onCreate) onCreate(prefillFrom(q));
          } else if (e.key === 'Escape') setQ('');
        }}
        aria-label={t('finder.placeholder')}
      />
      {term.length < 2 ? (
        <p className="px-1 text-[12.5px] text-muted">
          {t('finder.hint')} {onCreate ? <span className="whitespace-nowrap">· <Kbd>F2</Kbd> {t('finder.newShortcut')}</span> : null}
        </p>
      ) : list.isLoading ? (
        <div className="flex flex-col gap-1.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : list.error ? (
        <FdErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length ? (
        <ul className="flex max-h-[320px] flex-col overflow-y-auto rounded-lg border border-line" role="listbox" aria-label={t('finder.results')}>
          {rows.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => onSelect(p)}
                className={cn('flex w-full items-center gap-3 border-b border-line px-3 py-2 text-start last:border-0', i === active ? 'bg-accent-soft' : 'hover:bg-sunken')}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">
                    {name(p)}
                    {p.fullNameEn && name(p) !== p.fullNameEn ? <span className="ms-2 text-[12.5px] font-normal text-muted">{p.fullNameEn}</span> : null}
                  </p>
                  <PatientMeta p={p} />
                </div>
                <div className="shrink-0 text-end text-[12px] text-muted">
                  {p.lastVisitAt ? (
                    <>
                      <span className="block">{t('finder.lastVisit')}</span>
                      <span className="tabular">{f.date(p.lastVisitAt)}</span>
                    </>
                  ) : (
                    <span>{t('finder.noVisits')}</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center">
          <p className="text-[13.5px] text-ink">{t('finder.none')}</p>
          {onCreate ? (
            <Button size="sm" variant="secondary" onClick={() => onCreate(prefillFrom(q))}>
              <UserPlus />
              {t('finder.createFromSearch')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

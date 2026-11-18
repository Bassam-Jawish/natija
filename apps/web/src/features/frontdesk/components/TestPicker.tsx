import { useMemo, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Package, Search, Star, X } from 'lucide-react';
import { normalizeText, priceTest } from '@natija/domain';
import type { FormPackage, FormTest, OrderFormData, OrderItemInput } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EmptyState, Input, Kbd, TubeIcon } from '@/components/ui';

type Tab = 'favorites' | 'packages' | 'all' | string;

export function itemKey(i: OrderItemInput): string {
  return 'testId' in i ? `t:${i.testId}` : `p:${i.packageId}`;
}

/** Client-side price preview for the picker (the quote from the server is what gets billed). */
export function usePricePreview(form: OrderFormData | undefined, payerGroupId: string | null) {
  return useMemo(() => {
    const payer = form?.payerGroups.find((p) => p.id === payerGroupId);
    const overrides = new Map((form?.priceOverrides ?? []).filter((o) => o.payerGroupId === payerGroupId).map((o) => [o.testId, o.price]));
    const test = (t: FormTest) => (payer ? priceTest({ units: t.units, fixedPrice: t.fixedPrice, overridePrice: overrides.get(t.id) ?? null }, payer).price : null);
    const pkg = (p: FormPackage) => {
      if (!payer || !form) return null;
      if (p.priceMode === 'units' && p.units !== null) return Math.round(p.units * payer.unitPrice);
      if (p.priceMode === 'fixed' && p.fixedPrice !== null) return p.fixedPrice;
      return p.testIds.reduce((a, id) => {
        const tt = form.tests.find((x) => x.id === id);
        return a + (tt ? test(tt) ?? 0 : 0);
      }, 0);
    };
    return { test, pkg };
  }, [form, payerGroupId]);
}

/**
 * The test catalogue at the desk: type a code or a name (Enter adds the first match), or browse
 * favourites, packages and departments. Tests inside a chosen package show as included.
 */
export function TestPicker({
  form,
  payerGroupId,
  selected,
  onToggle,
  searchRef,
  inOrderTestIds,
  maxHeight = 'max-h-[340px]',
}: {
  form: OrderFormData;
  payerGroupId: string | null;
  selected: OrderItemInput[];
  onToggle: (item: OrderItemInput) => void;
  searchRef?: Ref<HTMLInputElement>;
  /** Tests already in the order (when adding tests later): shown as done. */
  inOrderTestIds?: Set<string>;
  maxHeight?: string;
}) {
  const { t } = useTranslation('frontdesk');
  const bi = useBi();
  const f = useFormat();
  const price = usePricePreview(form, payerGroupId);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('favorites');

  const chosen = useMemo(() => new Set(selected.map(itemKey)), [selected]);
  const inPackage = useMemo(() => {
    const m = new Map<string, FormPackage>();
    for (const s of selected) {
      if ('packageId' in s) {
        const p = form.packages.find((x) => x.id === s.packageId);
        p?.testIds.forEach((id) => m.set(id, p));
      }
    }
    return m;
  }, [selected, form.packages]);

  const term = normalizeText(q);
  const match = (code: string, ar: string, en: string) => !term || code.toLowerCase().startsWith(term) || normalizeText(`${ar} ${en} ${code}`).includes(term);
  const tests = useMemo(() => {
    if (term) return form.tests.filter((x) => match(x.code, x.nameAr, x.nameEn)).sort((a, b) => Number(!a.code.toLowerCase().startsWith(term)) - Number(!b.code.toLowerCase().startsWith(term)));
    if (tab === 'favorites') return form.tests.filter((x) => x.isFavorite);
    if (tab === 'packages') return [];
    if (tab === 'all') return form.tests;
    return form.tests.filter((x) => x.departmentId === tab);
  }, [form.tests, term, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const packages = useMemo(() => {
    if (term) return form.packages.filter((p) => match(p.code, p.nameAr, p.nameEn));
    return tab === 'packages' || tab === 'favorites' ? form.packages : [];
  }, [form.packages, term, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const departments = form.departments.filter((d) => form.tests.some((x) => x.departmentId === d.id));
  const tabs: Array<{ value: Tab; label: string; icon?: typeof Star }> = [
    { value: 'favorites', label: t('tests.favorites'), icon: Star },
    { value: 'packages', label: t('tests.packages'), icon: Package },
    { value: 'all', label: t('tests.all') },
    ...departments.map((d) => ({ value: d.id, label: bi(d) })),
  ];

  const first = (): OrderItemInput | null => {
    const p = packages[0];
    const x = tests.find((tt) => !inOrderTestIds?.has(tt.id));
    if (x && (!p || x.code.toLowerCase().startsWith(term))) return { testId: x.id };
    return p ? { packageId: p.id } : null;
  };

  const codesOf = (p: FormPackage) => p.testIds.map((id) => form.tests.find((x) => x.id === id)?.code).filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-2.5">
      <Input
        ref={searchRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        leading={<Search />}
        trailing={
          q ? (
            <button type="button" className="rounded p-0.5 hover:text-ink" onClick={() => setQ('')} aria-label={t('common:actions.clear')}>
              <X />
            </button>
          ) : (
            <Kbd>F4</Kbd>
          )
        }
        placeholder={t('tests.search')}
        aria-label={t('tests.search')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const it = first();
            if (it) {
              onToggle(it);
              setQ('');
            }
          } else if (e.key === 'Escape') setQ('');
        }}
      />
      {!term ? (
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5" role="tablist" aria-label={t('tests.categories')}>
          {tabs.map((x) => (
            <button
              key={x.value}
              type="button"
              role="tab"
              aria-selected={tab === x.value}
              onClick={() => setTab(x.value)}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors',
                tab === x.value ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:border-line-strong hover:text-ink',
              )}
            >
              {x.icon ? <x.icon className="size-3.5" /> : null}
              {x.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className={cn('overflow-y-auto rounded-lg border border-line', maxHeight)}>
        {packages.length === 0 && tests.length === 0 ? (
          <EmptyState title={t('tests.noMatch')} className="py-8" />
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2">
            {packages.map((p) => {
              const on = chosen.has(`p:${p.id}`);
              const value = price.pkg(p);
              return (
                <li key={p.id} className="border-b border-line md:odd:border-e">
                  <button
                    type="button"
                    onClick={() => onToggle({ packageId: p.id })}
                    aria-pressed={on}
                    className={cn('flex w-full items-center gap-2.5 px-2.5 py-2 text-start transition-colors', on ? 'bg-accent-soft' : 'hover:bg-sunken')}
                  >
                    <CheckMark on={on} />
                    <Package className="size-4 shrink-0 text-violet" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">{bi(p)}</span>
                      <span className="block truncate font-mono text-[11px] text-muted ltr-num">{codesOf(p)}</span>
                    </span>
                    {value !== null ? <span className="shrink-0 text-[12.5px] text-ink-2 tabular ltr-num">{f.money(value)}</span> : null}
                  </button>
                </li>
              );
            })}
            {tests.map((x) => {
              const on = chosen.has(`t:${x.id}`);
              const pkg = inPackage.get(x.id);
              const done = inOrderTestIds?.has(x.id);
              const value = price.test(x);
              return (
                <li key={x.id} className="border-b border-line md:odd:border-e">
                  <button
                    type="button"
                    disabled={done || (!!pkg && !on)}
                    onClick={() => onToggle({ testId: x.id })}
                    aria-pressed={on}
                    title={pkg ? t('tests.inPackage', { name: bi(pkg) }) : done ? t('tests.inOrder') : undefined}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-2.5 py-1.5 text-start transition-colors disabled:cursor-default',
                      on ? 'bg-accent-soft' : pkg || done ? 'bg-sunken/60' : 'hover:bg-sunken',
                    )}
                  >
                    <CheckMark on={on || !!pkg || !!done} muted={!on} />
                    <TubeIcon cap={x.capColor} title={bi({ nameAr: x.containerNameAr, nameEn: x.containerNameEn })} className="h-5 w-3" />
                    <span className="w-14 shrink-0 truncate font-mono text-[12px] font-medium text-ink ltr-num">{x.code}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                      {bi(x)}
                      {pkg ? <span className="ms-1.5 text-[11.5px] text-muted">· {pkg.code}</span> : null}
                      {done ? <span className="ms-1.5 text-[11.5px] text-muted">· {t('tests.inOrder')}</span> : null}
                    </span>
                    {x.isFavorite && tab !== 'favorites' && !term ? <Star className="size-3 shrink-0 text-warn" aria-label={t('tests.favorite')} /> : null}
                    {value !== null ? <span className="shrink-0 text-[12px] text-ink-2 tabular ltr-num">{f.money(value)}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function CheckMark({ on, muted }: { on: boolean; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-[18px] shrink-0 place-items-center rounded-[5px] border',
        on ? (muted ? 'border-line-strong bg-line-strong text-surface' : 'border-accent bg-accent text-accent-ink') : 'border-line-strong bg-surface',
      )}
    >
      {on ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

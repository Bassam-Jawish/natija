import { useTranslation } from 'react-i18next';
import { FlaskConical, Package, X } from 'lucide-react';
import type { OrderItemInput, OrderQuote, QuoteLine, QuoteWarning } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button, EmptyState, Skeleton, TubeIcon } from '@/components/ui';
import { Notice } from './shared';

export function useWarningText() {
  const { t } = useTranslation('frontdesk');
  return (w: QuoteWarning) =>
    w.kind === 'duplicate_test'
      ? t('quote.warn.duplicate', { code: w.code })
      : w.kind === 'package_covered'
        ? t('quote.warn.packageCovered', { code: w.code })
        : t('quote.warn.overlap', { analyte: w.analyteCode, tests: w.testCodes.join(' · ') });
}

/** Tubes the order needs, as cap-coloured icons with their tests. */
export function TubeStrip({ tubes, className }: { tubes: OrderQuote['tubes']; className?: string }) {
  const bi = useBi();
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {tubes.map((tube) => (
        <span key={tube.seq} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface py-1 ps-1.5 pe-2.5" title={bi({ nameAr: tube.containerNameAr, nameEn: tube.containerNameEn })}>
          <TubeIcon cap={tube.capColor} className="h-5 w-3" />
          <span className="font-mono text-[11.5px] font-medium text-ink ltr-num">{tube.containerCode}</span>
          <span className="max-w-[180px] truncate font-mono text-[11px] text-muted ltr-num">{tube.testCodes.join(' ')}</span>
        </span>
      ))}
    </div>
  );
}

function LineRow({ line, onRemove, nested }: { line: QuoteLine; onRemove?: () => void; nested?: boolean }) {
  const { t } = useTranslation('frontdesk');
  const bi = useBi();
  const f = useFormat();
  return (
    <li className={cn('flex items-center gap-2.5 border-b border-line py-1.5 last:border-0', nested ? 'ps-7 pe-2' : 'px-2')}>
      <TubeIcon cap={line.capColor} className="h-5 w-3" />
      <span className="w-14 shrink-0 font-mono text-[12px] font-medium text-ink ltr-num">{line.code}</span>
      <span className={cn('min-w-0 flex-1 truncate text-[13px]', nested ? 'text-ink-2' : 'text-ink')}>{bi(line)}</span>
      <span className="shrink-0 text-end">
        <span className={cn('block text-[12.5px] tabular ltr-num', nested ? 'text-muted' : 'text-ink')}>{f.money(line.price)}</span>
        {line.discount > 0 ? <span className="block text-[11px] text-ok tabular ltr-num">−{f.money(line.discount)}</span> : null}
      </span>
      {onRemove ? (
        <Button variant="ghost" size="icon-sm" className="size-7" onClick={onRemove} aria-label={t('quote.remove', { code: line.code })}>
          <X />
        </Button>
      ) : (
        <span className="w-7 shrink-0" />
      )}
    </li>
  );
}

/** The lines of the order being built, priced by the server's quote. */
export function QuoteLines({
  quote,
  loading,
  stale,
  onRemove,
  showTubes = true,
}: {
  quote: OrderQuote | undefined;
  loading: boolean;
  stale?: boolean;
  onRemove: (item: OrderItemInput) => void;
  /** Off when adding to an order whose existing tubes may be reused. */
  showTubes?: boolean;
}) {
  const { t } = useTranslation('frontdesk');
  const bi = useBi();
  const f = useFormat();
  const warningText = useWarningText();

  if (!quote && loading) {
    return (
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (!quote || !quote.lines.length) {
    return <EmptyState icon={FlaskConical} title={t('quote.empty')} description={t('quote.emptyHint')} className="py-6" />;
  }

  const standalone = quote.lines.filter((l) => !l.packageId);
  return (
    <div className={cn('flex flex-col gap-3 transition-opacity', stale && 'opacity-60')} aria-busy={stale || undefined}>
      <ul className="rounded-lg border border-line">
        {quote.packages.map((p) => (
          <li key={p.packageId} className="border-b border-line last:border-0">
            <div className="flex items-center gap-2.5 bg-sunken/60 px-2 py-1.5">
              <Package className="size-4 shrink-0 text-violet" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                {bi(p)} <span className="font-mono text-[11.5px] font-normal text-muted ltr-num">{p.code}</span>
              </span>
              <span className="shrink-0 text-[12.5px] font-medium text-ink tabular ltr-num">{f.money(p.price)}</span>
              <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => onRemove({ packageId: p.packageId })} aria-label={t('quote.remove', { code: p.code })}>
                <X />
              </Button>
            </div>
            <ul>
              {quote.lines
                .filter((l) => l.packageId === p.packageId)
                .map((l) => (
                  <LineRow key={l.key} line={l} nested />
                ))}
            </ul>
          </li>
        ))}
        {standalone.map((l) => (
          <LineRow key={l.key} line={l} onRemove={() => onRemove({ testId: l.testId })} />
        ))}
      </ul>
      {showTubes ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-medium text-muted">{t('quote.tubes', { count: quote.tubes.length })}</span>
          <TubeStrip tubes={quote.tubes} />
        </div>
      ) : null}
      {quote.warnings.length ? (
        <Notice tone="warn" title={t('quote.warn.title')}>
          <ul className="list-disc ps-4">
            {quote.warnings.map((w, i) => (
              <li key={i}>{warningText(w)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}

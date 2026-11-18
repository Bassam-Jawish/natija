import { useTranslation } from 'react-i18next';
import { ArrowRight, Info, OctagonAlert } from 'lucide-react';
import type { WireFrame } from '@natija/contracts';
import { cn } from '@/lib/utils';
import { WireText } from './common';

/**
 * What crossed the simulated link, in order. Always left-to-right: the analyzer on the left
 * sends to the host (the Lab Agent role) on the right; host replies point back.
 */
export function WireTrace({ frames, labels }: { frames: WireFrame[]; labels?: Record<number, string> }) {
  const { t } = useTranslation('instruments');
  const groups = new Map<number, WireFrame[]>();
  for (const f of frames) groups.set(f.exchange, [...(groups.get(f.exchange) ?? []), f]);
  return (
    <div dir="ltr" className="flex flex-col gap-3 text-start">
      <div className="flex items-center justify-between rounded-md bg-sunken px-3 py-1.5 text-[12px] font-medium text-muted">
        <span>{t('wire.analyzer')}</span>
        <span>{t('wire.host')}</span>
      </div>
      {[...groups.entries()].map(([exchange, list]) => (
        <section key={exchange} className="rounded-lg border border-line">
          <header className="border-b border-line bg-sunken/60 px-3 py-1.5 text-[12px] font-semibold text-ink-2">
            {labels?.[exchange] ?? t('wire.transmission', { n: exchange + 1 })}
          </header>
          <ol className="max-h-[420px] overflow-auto px-2 py-1">
            {list.map((f, i) => (
              <WireLine key={i} frame={f} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function WireLine({ frame }: { frame: WireFrame }) {
  const { t } = useTranslation('instruments');
  const time = <span className="w-14 shrink-0 pt-1 text-end font-mono text-[11px] text-faint tabular">+{frame.t}ms</span>;
  if (frame.dir === 'note') {
    const error = frame.kind === 'error';
    return (
      <li className="flex items-start gap-2 py-0.5">
        {time}
        <span className={cn('flex min-w-0 items-start gap-1.5 rounded px-2 py-1 text-[12px]', error ? 'bg-crit-soft text-crit' : 'text-muted')}>
          {error ? <OctagonAlert className="mt-0.5 size-3.5 shrink-0" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
          <span className="min-w-0 break-words">
            <span className="font-medium">{frame.side === 'host' ? t('wire.hostNote') : t('wire.analyzerNote')}:</span> {frame.text}
          </span>
        </span>
      </li>
    );
  }
  const fromAnalyzer = frame.side === 'instrument';
  return (
    <li className={cn('flex items-start gap-2 py-0.5', fromAnalyzer ? 'justify-start' : 'justify-end')}>
      {fromAnalyzer ? time : null}
      <div className={cn('flex min-w-0 max-w-[85%] items-start gap-1.5', fromAnalyzer ? 'flex-row' : 'flex-row-reverse')}>
        <ArrowRight className={cn('mt-1 size-3.5 shrink-0', fromAnalyzer ? 'text-info' : 'rotate-180 text-ok')} aria-label={fromAnalyzer ? t('wire.toHost') : t('wire.toAnalyzer')} />
        <div className={cn('min-w-0 rounded-md border px-2 py-0.5', fromAnalyzer ? 'border-info/25 bg-info-soft/50' : 'border-ok/25 bg-ok-soft/50', frame.ok === false && 'border-crit bg-crit-soft')}>
          <WireText text={frame.text} />
          {frame.ok === false ? <span className="ms-2 text-[11px] font-semibold text-crit">{t('wire.corrupted')}</span> : null}
        </div>
      </div>
      {fromAnalyzer ? null : time}
    </li>
  );
}

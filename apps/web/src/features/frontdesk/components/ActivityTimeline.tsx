import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, ChevronDown, ClipboardList, FileText, FlaskConical, History, Receipt, Send, TestTube, Wallet, type LucideIcon } from 'lucide-react';
import type { ActivityEntry } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EmptyState, Skeleton } from '@/components/ui';
import { fd, keys } from '../api';
import { FdErrorState } from './shared';

const ICONS: Record<string, LucideIcon> = {
  order: ClipboardList,
  order_item: ClipboardList,
  sample: TestTube,
  result: FlaskConical,
  invoice: Receipt,
  payment: Wallet,
  approval: BadgeCheck,
  report: FileText,
  delivery: Send,
};

function humanize(action: string): string {
  return action.replace(/[._]/g, ' ');
}

function Entry({ e }: { e: ActivityEntry }) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const Icon = ICONS[e.entityType] ?? History;
  const hasDetail = e.before !== null || e.after !== null;
  return (
    <li className="relative ps-9 pb-4 last:pb-0">
      <span className="absolute start-0 top-0 grid size-7 place-items-center rounded-full border border-line bg-surface text-muted">
        <Icon className="size-3.5" />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[13.5px] font-medium text-ink">{t(`activity.actions.${e.action}`, { defaultValue: humanize(e.action) })}</span>
        <span className="text-[12px] text-muted tabular" title={f.dateTime(e.at)}>
          {f.dateTime(e.at)}
        </span>
        {e.actorName ? <span className="text-[12px] text-muted">· {e.actorName}</span> : null}
      </div>
      {e.summary ? <p className="mt-0.5 text-[12.5px] break-words text-ink-2">{e.summary}</p> : null}
      {hasDetail ? (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 inline-flex items-center gap-1 text-[12px] text-accent hover:underline" aria-expanded={open}>
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          {open ? t('activity.hideDetails') : t('activity.showDetails')}
        </button>
      ) : null}
      {open ? (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {e.before !== null ? (
            <div>
              <p className="mb-1 text-[11.5px] font-medium text-muted">{t('activity.before')}</p>
              <pre className="max-h-48 overflow-auto rounded-md bg-sunken p-2 text-[11.5px] leading-relaxed text-ink-2" dir="ltr">
                {JSON.stringify(e.before, null, 2)}
              </pre>
            </div>
          ) : null}
          {e.after !== null ? (
            <div>
              <p className="mb-1 text-[11.5px] font-medium text-muted">{t('activity.after')}</p>
              <pre className="max-h-48 overflow-auto rounded-md bg-sunken p-2 text-[11.5px] leading-relaxed text-ink-2" dir="ltr">
                {JSON.stringify(e.after, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Audit trail of an order and its tubes, results, invoice and payments (newest first). */
export function ActivityTimeline({ orderId }: { orderId: string }) {
  const { t } = useTranslation('frontdesk');
  const q = useQuery({ queryKey: keys.activity(orderId), queryFn: () => fd.activity(orderId) });
  if (q.isLoading)
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  if (q.error) return <FdErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.items.length) return <EmptyState icon={History} title={t('activity.empty')} />;
  return (
    <ol className="relative before:absolute before:inset-y-1 before:start-[13px] before:w-px before:bg-line">
      {q.data.items.map((e) => (
        <Entry key={e.id} e={e} />
      ))}
    </ol>
  );
}

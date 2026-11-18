import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, CheckCheck, Printer, RefreshCw, Syringe, Utensils } from 'lucide-react';
import type { BenchCollectOutcome, CollectionQueueOrder } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { openPrint } from '@/lib/print';
import { cn } from '@/lib/utils';
import { Badge, Button, buttonVariants, Card, EmptyState, ErrorState, PageHeader, SearchInput, Skeleton, StatusChip, toast } from '@/components/ui';
import { benchApi, benchKeys } from '../api';
import { ltr, PatientCell, PriorityBadge, TubeCell, useBenchError, WaitTime } from '../components/common';
import { ScanBox, type ScanBoxHandle } from '../components/ScanBox';

const OUTCOME_TONE: Record<BenchCollectOutcome, 'ok' | 'warn' | 'crit'> = {
  collected: 'ok',
  already_collected: 'warn',
  not_found: 'crit',
  rejected: 'crit',
  order_cancelled: 'crit',
};

/** Phlebotomy queue: orders with tubes still to draw, STAT first, live waiting time. */
export default function CollectionPage() {
  const { t } = useTranslation('bench');
  const qc = useQueryClient();
  const errorMessage = useBenchError();
  const scan = useRef<ScanBoxHandle>(null);
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);
  const params = { q: search || undefined };
  const query = useQuery({ queryKey: benchKeys.queue(params), queryFn: () => benchApi.collectionQueue(params), refetchInterval: 60_000 });

  const collect = useMutation({
    mutationFn: (body: { sampleIds?: string[]; barcodes?: string[] }) => benchApi.collect(body),
    onSuccess: (res) => {
      const done = res.items.filter((i) => i.outcome === 'collected').length;
      for (const item of res.items) {
        if (item.outcome !== 'collected') toast.warning(t(`collect.outcome.${item.outcome}`, { barcode: ltr(item.sample?.barcode ?? item.key) }));
      }
      if (done) toast.success(t('collect.done', { count: done }));
      const worst = res.items.some((i) => OUTCOME_TONE[i.outcome] === 'crit') ? 'crit' : res.items.some((i) => OUTCOME_TONE[i.outcome] === 'warn') ? 'warn' : 'ok';
      scan.current?.flash(worst);
      void qc.invalidateQueries({ queryKey: ['samples'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (err) => {
      scan.current?.flash('crit');
      toast.error(errorMessage(err));
    },
  });

  const items = query.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('collection.title')}
        description={t('collection.description')}
        actions={
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()} loading={query.isFetching && !query.isLoading}>
            <RefreshCw />
            {t('common:actions.refresh')}
          </Button>
        }
      />
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <ScanBox ref={scan} size="md" label={t('collection.scanLabel')} busy={collect.isPending} onScan={(codes) => collect.mutate({ barcodes: codes })} />
        <SearchInput value={q} onChange={setQ} placeholder={t('collection.search')} className="h-full min-h-11" />
      </div>
      {query.isLoading ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : !items.length ? (
        <Card>
          <EmptyState icon={Syringe} title={t('collection.empty')} description={t('collection.emptyHint')} />
        </Card>
      ) : (
        <>
          <div className="text-[12.5px] text-muted">{t('collection.count', { count: query.data!.total })}</div>
          <div className="grid gap-3 xl:grid-cols-2">
            {items.map((o) => (
              <QueueCard key={o.order.id} entry={o} busy={collect.isPending} onCollect={(ids) => collect.mutate({ sampleIds: ids })} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function QueueCard({ entry, busy, onCollect }: { entry: CollectionQueueOrder; busy: boolean; onCollect: (ids: string[]) => void }) {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const { can } = useAuth();
  const pending = entry.tubes.filter((tube) => tube.status === 'pending');
  const urgent = entry.order.priority !== 'routine';
  return (
    <section className={cn('rounded-[var(--radius-card)] border bg-surface', entry.order.priority === 'stat' ? 'border-crit/50' : urgent ? 'border-warn/50' : 'border-line')}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <PatientCell patient={entry.patient} orderId={entry.order.id} accession={entry.order.accession} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge priority={entry.order.priority} />
          {entry.order.fasting ? (
            <Badge tone="info">
              <Utensils className="size-3" />
              {t('collection.fasting')}
            </Badge>
          ) : null}
          <span className="inline-flex items-center gap-1 text-[12.5px] text-muted">
            {t('collection.waiting')} <WaitTime since={entry.order.createdAt} warnAfter={20} critAfter={45} className="font-medium" />
          </span>
        </div>
      </header>
      {entry.order.notes || entry.order.clinicalInfo ? (
        <p className="border-b border-line bg-sunken/60 px-4 py-1.5 text-[12.5px] text-ink-2">{[entry.order.clinicalInfo, entry.order.notes].filter(Boolean).join(' · ')}</p>
      ) : null}
      <ul className="divide-y divide-line">
        {entry.tubes.map((tube) => (
          <li key={tube.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-2', tube.status !== 'pending' && 'opacity-60')}>
            <TubeCell container={tube.container} barcode={tube.barcode} sub={`${bi(tube.container, 'name')} · ${bi(tube.sampleType, 'name')}`} />
            <div className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2" title={tube.tests.map((x) => bi(x, 'name')).join('، ')}>
              {tube.tests.map((x) => x.code).join(' · ')}
            </div>
            {tube.recollectOfId ? <Badge tone="warn">{t('collection.recollect')}</Badge> : null}
            {tube.status === 'pending' ? (
              can('samples.collect') ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onCollect([tube.id])}>
                  <Check />
                  {t('collection.markCollected')}
                </Button>
              ) : null
            ) : (
              <StatusChip kind="sample" status={tube.status} />
            )}
          </li>
        ))}
      </ul>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <span className="text-[12.5px] text-muted">{t('collection.progress', { done: entry.totalCount - entry.pendingCount, total: entry.totalCount })}</span>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => openPrint(`/print/labels/${entry.order.id}`)}>
            <Printer />
            {t('collection.printLabels')}
          </Button>
          <Link to={`/orders/${entry.order.id}`} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
            {t('collection.openOrder')}
          </Link>
          {pending.length > 1 && can('samples.collect') ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onCollect(pending.map((p) => p.id))}>
              <CheckCheck />
              {t('collection.collectAll', { count: pending.length })}
            </Button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

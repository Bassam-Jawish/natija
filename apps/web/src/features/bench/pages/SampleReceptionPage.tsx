import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Archive, Ban, CircleCheck, CircleX, PackageCheck, Trash2, TriangleAlert, Truck } from 'lucide-react';
import type { BenchReceiveOutcome, BenchSample, BenchSampleStatus } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DateRangePicker,
  PageHeader,
  SearchInput,
  StatusChip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  Tooltip,
  useTodayRange,
  type ColumnDef,
  type DateRange,
} from '@/components/ui';
import { benchApi, benchKeys, useBenchMeta } from '../api';
import { ltr, PatientCell, PriorityBadge, TubeCell, useBenchError, WaitTime } from '../components/common';
import { LocationDialog, RejectDialog } from '../components/SampleDialogs';
import { ScanBox, type ScanBoxHandle } from '../components/ScanBox';

type Feedback = { key: string; barcode: string; outcome: BenchReceiveOutcome; sample: BenchSample | null; at: Date };
const OUTCOME: Record<BenchReceiveOutcome, { tone: 'ok' | 'warn' | 'crit'; icon: typeof CircleCheck }> = {
  received: { tone: 'ok', icon: CircleCheck },
  already_received: { tone: 'warn', icon: TriangleAlert },
  not_collected: { tone: 'warn', icon: TriangleAlert },
  not_found: { tone: 'crit', icon: CircleX },
  rejected: { tone: 'crit', icon: CircleX },
  order_cancelled: { tone: 'crit', icon: CircleX },
};

/** Bench reception: scan tubes one after another; tabs for what is still coming, today's, rejected and stored tubes. */
export default function SampleReceptionPage() {
  const { t } = useTranslation('bench');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const f = useFormat();
  const bi = useBi();
  const { can } = useAuth();
  const meta = useBenchMeta();
  const errorMessage = useBenchError();
  const scan = useRef<ScanBoxHandle>(null);
  const today = useTodayRange();
  const [tab, setTab] = useState('incoming');
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [rejectRange, setRejectRange] = useState<DateRange>(today);
  const [storageQ, setStorageQ] = useState('');
  const storageSearch = useDebounced(storageQ, 300);
  const [rejecting, setRejecting] = useState<BenchSample | null>(null);
  const [locating, setLocating] = useState<{ tube: BenchSample; mode: 'store' | 'transfer' } | null>(null);
  const [disposing, setDisposing] = useState<BenchSample | null>(null);

  const incomingStatuses: BenchSampleStatus[] = meta.data?.settings.requireCollectionStep === false ? ['pending', 'collected', 'in_transit'] : ['collected', 'in_transit'];
  const queries = {
    incoming: { status: incomingStatuses.join(','), sort: 'asc', limit: 200 },
    today: { status: 'received,in_analysis,stored', dateBy: 'received', from: today.from, to: today.to, limit: 300 },
    rejected: { status: 'rejected', dateBy: 'rejected', from: rejectRange.from, to: rejectRange.to, limit: 300 },
    storage: { status: 'stored', q: storageSearch || undefined, limit: 300 },
  } as const;
  const incoming = useQuery({ queryKey: benchKeys.samples(queries.incoming), queryFn: () => benchApi.samples(queries.incoming), enabled: meta.isSuccess });
  const received = useQuery({ queryKey: benchKeys.samples(queries.today), queryFn: () => benchApi.samples(queries.today) });
  const rejected = useQuery({ queryKey: benchKeys.samples(queries.rejected), queryFn: () => benchApi.samples(queries.rejected) });
  const stored = useQuery({ queryKey: benchKeys.samples(queries.storage), queryFn: () => benchApi.samples(queries.storage) });

  const receive = useMutation({
    mutationFn: (barcodes: string[]) => benchApi.receive(barcodes),
    onSuccess: (res) => {
      const now = new Date();
      setFeedback((list) => [...res.items.map((i, n) => ({ key: `${now.getTime()}-${n}-${i.barcode}`, barcode: i.barcode, outcome: i.outcome, sample: i.sample, at: now })).reverse(), ...list].slice(0, 40));
      const tones = res.items.map((i) => OUTCOME[i.outcome].tone);
      scan.current?.flash(tones.includes('crit') ? 'crit' : tones.includes('warn') ? 'warn' : 'ok');
      void qc.invalidateQueries({ queryKey: ['samples'] });
      void qc.invalidateQueries({ queryKey: ['worklists'] });
    },
    onError: (err) => {
      scan.current?.flash('crit');
      toast.error(errorMessage(err));
    },
  });
  const dispose = useMutation({
    mutationFn: (s: BenchSample) => benchApi.dispose(s.id),
    onSuccess: (s) => {
      toast.success(t('storage.disposed', { barcode: ltr(s.barcode) }));
      void qc.invalidateQueries({ queryKey: ['samples'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const open = (s: BenchSample) => navigate(`/orders/${s.order.id}?tube=${encodeURIComponent(s.barcode)}`);
  const base = useMemo<ColumnDef<BenchSample>[]>(
    () => [
      { id: 'tube', header: t('table.tube'), cell: ({ row }) => <TubeCell container={row.original.container} barcode={row.original.barcode} /> },
      { id: 'patient', header: t('table.patient'), cell: ({ row }) => <PatientCell patient={row.original.patient} accession={row.original.order.accession} /> },
      {
        id: 'tests',
        header: t('table.tests'),
        cell: ({ row }) => (
          <span className="text-[12.5px] text-ink-2" title={row.original.tests.map((x) => bi(x, 'name')).join('، ')}>
            {row.original.tests.map((x) => x.code).join(' · ')}
          </span>
        ),
      },
      { id: 'priority', header: t('table.priority'), cell: ({ row }) => <PriorityBadge priority={row.original.order.priority} showRoutine /> },
    ],
    [t, bi],
  );
  const stop = (fn: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    fn();
  };
  const rejectButton = (s: BenchSample) =>
    can('samples.reject') ? (
      <Tooltip content={t('reject.title')}>
        <Button size="icon-sm" variant="ghost" onClick={stop(() => setRejecting(s))} aria-label={t('reject.title')}>
          <Ban className="text-crit" />
        </Button>
      </Tooltip>
    ) : null;

  const incomingCols: ColumnDef<BenchSample>[] = [
    ...base,
    { id: 'wait', header: t('table.waiting'), cell: ({ row }) => <WaitTime since={row.original.collectedAt ?? row.original.createdAt} warnAfter={45} critAfter={120} /> },
    { id: 'status', header: t('table.status'), cell: ({ row }) => <StatusChip kind="sample" status={row.original.status} /> },
    {
      id: 'actions',
      header: '',
      meta: { align: 'end' },
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="secondary" disabled={receive.isPending} onClick={stop(() => receive.mutate([row.original.barcode]))}>
            <PackageCheck />
            {t('reception.receive')}
          </Button>
          {rejectButton(row.original)}
        </div>
      ),
    },
  ];
  const todayCols: ColumnDef<BenchSample>[] = [
    ...base,
    { id: 'received', header: t('table.receivedAt'), cell: ({ row }) => <span className="tabular text-[12.5px]">{f.time(row.original.receivedAt)}</span> },
    { id: 'status', header: t('table.status'), cell: ({ row }) => <StatusChip kind="sample" status={row.original.status} /> },
    {
      id: 'actions',
      header: '',
      meta: { align: 'end' },
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          {can('samples.store') ? (
            <Button size="sm" variant="ghost" onClick={stop(() => setLocating({ tube: row.original, mode: 'store' }))}>
              <Archive />
              {t('storage.store')}
            </Button>
          ) : null}
          {rejectButton(row.original)}
        </div>
      ),
    },
  ];
  const rejectedCols: ColumnDef<BenchSample>[] = [
    ...base.slice(0, 3),
    {
      id: 'reason',
      header: t('table.reason'),
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="text-ink">{row.original.rejectionReason ? bi(row.original.rejectionReason, 'name') : '—'}</div>
          {row.original.rejectionNote ? <div className="truncate text-[12px] text-muted">{row.original.rejectionNote}</div> : null}
        </div>
      ),
    },
    { id: 'at', header: t('table.rejectedAt'), cell: ({ row }) => <span className="tabular text-[12.5px]">{f.dateTime(row.original.rejectedAt)}</span> },
    {
      id: 'recollect',
      header: t('table.recollectedAs'),
      cell: ({ row }) => (row.original.recollectedAs ? <span className="ltr-num font-mono text-[12.5px]">{row.original.recollectedAs.barcode}</span> : <span className="text-faint">—</span>),
    },
    {
      id: 'actions',
      header: '',
      meta: { align: 'end' },
      cell: ({ row }) =>
        row.original.disposedAt ? (
          <span className="text-[12px] text-muted">{t('storage.disposedAt', { time: f.dateTime(row.original.disposedAt) })}</span>
        ) : can('samples.store') ? (
          <Button size="sm" variant="ghost" onClick={stop(() => setDisposing(row.original))}>
            <Trash2 />
            {t('storage.dispose')}
          </Button>
        ) : null,
    },
  ];
  const storageCols: ColumnDef<BenchSample>[] = [
    ...base.slice(0, 3),
    { id: 'location', header: t('storage.location'), cell: ({ row }) => <span className="font-medium text-ink">{row.original.storageLocation ?? '—'}</span> },
    { id: 'storedAt', header: t('table.storedAt'), cell: ({ row }) => <span className="tabular text-[12.5px]">{f.dateTime(row.original.storedAt)}</span> },
    {
      id: 'actions',
      header: '',
      meta: { align: 'end' },
      cell: ({ row }) =>
        can('samples.store') ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={stop(() => setLocating({ tube: row.original, mode: 'store' }))}>
              <Archive />
              {t('storage.move')}
            </Button>
            <Button size="sm" variant="ghost" onClick={stop(() => setLocating({ tube: row.original, mode: 'transfer' }))}>
              <Truck />
              {t('storage.transfer')}
            </Button>
            <Button size="sm" variant="ghost" onClick={stop(() => setDisposing(row.original))}>
              <Trash2 />
              {t('storage.dispose')}
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('reception.title')} description={t('reception.description')} />
      <ScanBox ref={scan} label={t('reception.scanLabel')} busy={receive.isPending} onScan={(codes) => receive.mutate(codes)} />
      {feedback.length ? (
        <Card padded={false} title={t('reception.feedbackTitle')} actions={<Button size="sm" variant="ghost" onClick={() => setFeedback([])}>{t('common:actions.clear')}</Button>}>
          <ul className="max-h-[280px] divide-y divide-line overflow-y-auto">
            {feedback.map((fb) => {
              const o = OUTCOME[fb.outcome];
              const Icon = o.icon;
              return (
                <li key={fb.key} className={cn('flex flex-wrap items-center gap-3 px-4 py-2', o.tone === 'crit' ? 'bg-crit-soft/50' : o.tone === 'warn' ? 'bg-warn-soft/50' : null)}>
                  <Icon className={cn('size-5 shrink-0', o.tone === 'ok' ? 'text-ok' : o.tone === 'warn' ? 'text-warn' : 'text-crit')} />
                  <span className="w-44 shrink-0 ltr-num font-mono text-[13px]">{fb.barcode}</span>
                  <span className={cn('w-40 shrink-0 text-[13px] font-medium', o.tone === 'ok' ? 'text-ok' : o.tone === 'warn' ? 'text-warn' : 'text-crit')}>{t(`reception.outcome.${fb.outcome}`)}</span>
                  {fb.sample ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                        {bi(fb.sample.patient, 'fullName')} · <span className="text-muted">{fb.sample.tests.map((x) => x.code).join(' · ')}</span>
                      </span>
                      <PriorityBadge priority={fb.sample.order.priority} />
                      {fb.outcome === 'received' && can('samples.reject') ? (
                        <Button size="sm" variant="ghost" onClick={() => setRejecting(fb.sample)}>
                          <Ban className="text-crit" />
                          {t('reject.short')}
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <span className="text-[12px] text-muted tabular">{f.time(fb.at)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="incoming" count={incoming.data?.total}>
            {t('reception.tabs.incoming')}
          </TabsTrigger>
          <TabsTrigger value="today" count={received.data?.total}>
            {t('reception.tabs.today')}
          </TabsTrigger>
          <TabsTrigger value="rejected" count={rejected.data?.total}>
            {t('reception.tabs.rejected')}
          </TabsTrigger>
          <TabsTrigger value="storage" count={stored.data?.total}>
            {t('reception.tabs.storage')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="incoming">
          <DataTable
            columns={incomingCols}
            data={incoming.data?.items}
            loading={incoming.isLoading || meta.isLoading}
            error={incoming.error}
            onRetry={() => void incoming.refetch()}
            onRowClick={open}
            getRowId={(s) => s.id}
            empty={{ title: t('reception.emptyIncoming'), icon: PackageCheck }}
            dense
            maxHeight="60vh"
          />
        </TabsContent>
        <TabsContent value="today">
          <DataTable columns={todayCols} data={received.data?.items} loading={received.isLoading} error={received.error} onRetry={() => void received.refetch()} onRowClick={open} getRowId={(s) => s.id} empty={{ title: t('reception.emptyToday') }} dense maxHeight="60vh" />
        </TabsContent>
        <TabsContent value="rejected">
          <div className="mb-3">
            <DateRangePicker value={rejectRange} onChange={setRejectRange} />
          </div>
          <DataTable columns={rejectedCols} data={rejected.data?.items} loading={rejected.isLoading} error={rejected.error} onRetry={() => void rejected.refetch()} onRowClick={open} getRowId={(s) => s.id} empty={{ title: t('reception.emptyRejected') }} dense maxHeight="60vh" />
        </TabsContent>
        <TabsContent value="storage">
          <div className="mb-3 max-w-sm">
            <SearchInput value={storageQ} onChange={setStorageQ} placeholder={t('storage.search')} />
          </div>
          <DataTable columns={storageCols} data={stored.data?.items} loading={stored.isLoading} error={stored.error} onRetry={() => void stored.refetch()} onRowClick={open} getRowId={(s) => s.id} empty={{ title: t('reception.emptyStorage'), icon: Archive }} dense maxHeight="60vh" />
        </TabsContent>
      </Tabs>

      <RejectDialog tube={rejecting} onOpenChange={(o) => !o && setRejecting(null)} />
      <LocationDialog tube={locating?.tube ?? null} mode={locating?.mode ?? 'store'} onOpenChange={(o) => !o && setLocating(null)} />
      <ConfirmDialog
        open={!!disposing}
        onOpenChange={(o) => !o && setDisposing(null)}
        title={t('storage.disposeTitle')}
        description={disposing ? t('storage.disposeHint', { barcode: ltr(disposing.barcode) }) : undefined}
        tone="danger"
        confirmLabel={t('storage.dispose')}
        onConfirm={() => dispose.mutateAsync(disposing!).then(
          () => undefined,
          () => undefined,
        )}
      />
    </div>
  );
}

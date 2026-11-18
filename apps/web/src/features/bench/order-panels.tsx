/**
 * Tabs for the front desk's order page: the order's tubes, its results and its reports.
 * Each reads `?tube=<barcode>` from the URL to highlight a scanned tube.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Ban,
  CheckCheck,
  FileCheck,
  FilePen,
  FlaskConical,
  History,
  MessageSquareText,
  PackageCheck,
  PhoneCall,
  Plus,
  Printer,
  RotateCcw,
  Save,
  ShieldCheck,
  Syringe,
  TestTubes,
  Trash2,
  Truck,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { BenchResult, BenchSample } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { openPrint } from '@/lib/print';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ESignDialog,
  QrCode,
  Skeleton,
  StatusChip,
  toast,
  Tooltip,
} from '@/components/ui';
import { benchApi, benchKeys, useBenchMeta } from './api';
import { ltr, TubeCell, useBenchError, useSignedAction } from './components/common';
import { DeliverActions } from './components/DeliverActions';
import { AmendDialog, CommentDialog, CriticalCallDialog, ResultHistoryDrawer } from './components/ResultDialogs';
import { ResultTable } from './components/ResultTable';
import { LocationDialog, RejectDialog } from './components/SampleDialogs';
import { useInvalidateBench, useResultEntry, useVerify } from './components/useResultEntry';

function PanelLoading() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}

/* ================================================================== tubes */

const EVENT_ICON: Record<string, LucideIcon> = {
  created: Plus,
  collected: Syringe,
  received: PackageCheck,
  rejected: Ban,
  moved: Truck,
  stored: Archive,
  disposed: Trash2,
  recollect_requested: RotateCcw,
  label_printed: Printer,
  in_analysis: FlaskConical,
};

export function OrderSamplesPanel({ orderId }: { orderId: string }) {
  const { t } = useTranslation('bench');
  const f = useFormat();
  const bi = useBi();
  const qc = useQueryClient();
  const { can } = useAuth();
  const meta = useBenchMeta();
  const errorMessage = useBenchError();
  const [params] = useSearchParams();
  const highlight = params.get('tube');
  const query = useQuery({ queryKey: benchKeys.orderSamples(orderId), queryFn: () => benchApi.orderSamples(orderId) });
  const [rejecting, setRejecting] = useState<BenchSample | null>(null);
  const [locating, setLocating] = useState<{ tube: BenchSample; mode: 'store' | 'transfer' } | null>(null);
  const [disposing, setDisposing] = useState<BenchSample | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (highlight && query.data) refs.current.get(highlight)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight, query.data]);

  const refresh = () => {
    for (const key of [['samples'], ['orders'], ['worklists'], ['results']]) void qc.invalidateQueries({ queryKey: key });
  };
  const collect = useMutation({
    mutationFn: (ids: string[]) => benchApi.collect({ sampleIds: ids }),
    onSuccess: (res) => {
      const n = res.items.filter((i) => i.outcome === 'collected').length;
      if (n) toast.success(t('collect.done', { count: n }));
      for (const i of res.items) if (i.outcome !== 'collected') toast.warning(t(`collect.outcome.${i.outcome}`, { barcode: ltr(i.sample?.barcode ?? i.key) }));
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const receive = useMutation({
    mutationFn: (barcodes: string[]) => benchApi.receive(barcodes),
    onSuccess: (res) => {
      for (const i of res.items) {
        if (i.outcome === 'received') toast.success(t('reception.receivedOne', { barcode: ltr(i.barcode) }));
        else toast.warning(`${ltr(i.barcode) }: ${t(`reception.outcome.${i.outcome}`)}`);
      }
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const dispose = useMutation({
    mutationFn: (s: BenchSample) => benchApi.dispose(s.id),
    onSuccess: (s) => {
      toast.success(t('storage.disposed', { barcode: ltr(s.barcode) }));
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (query.isLoading) return <PanelLoading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const tubes = query.data?.items ?? [];
  if (!tubes.length) return <EmptyState icon={TestTubes} title={t('orderPanels.noTubes')} />;
  const requireCollection = meta.data?.settings.requireCollectionStep !== false;
  const pending = tubes.filter((s) => s.status === 'pending');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-muted">{t('orderPanels.tubesCount', { count: tubes.length })}</span>
        <div className="flex flex-wrap gap-2">
          {can('samples.collect') ? (
            <Button size="sm" variant="ghost" onClick={() => openPrint(`/print/labels/${orderId}`)}>
              <Printer />
              {t('collection.printLabels')}
            </Button>
          ) : null}
          {can('samples.collect') && pending.length > 1 ? (
            <Button size="sm" variant="secondary" loading={collect.isPending} onClick={() => collect.mutate(pending.map((p) => p.id))}>
              <CheckCheck />
              {t('collection.collectAll', { count: pending.length })}
            </Button>
          ) : null}
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {tubes.map((s) => {
          const active = highlight === s.barcode;
          const canReceive = can('samples.receive') && (s.status === 'collected' || s.status === 'in_transit' || (s.status === 'pending' && !requireCollection));
          return (
            <li
              key={s.id}
              ref={(el) => {
                if (el) refs.current.set(s.barcode, el);
              }}
              className={cn('rounded-[var(--radius-card)] border bg-surface', active ? 'border-accent ring-2 ring-accent/30' : 'border-line')}
            >
              <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <TubeCell container={s.container} barcode={s.barcode} sub={`${bi(s.container, 'name')} · ${bi(s.sampleType, 'name')}`} />
                <StatusChip kind="sample" status={s.status} />
                {s.recollectOfId ? <Badge tone="warn">{t('collection.recollect')}</Badge> : null}
                {s.recollectedAs ? <Badge tone="muted">{t('orderPanels.replacedBy', { barcode: ltr(s.recollectedAs.barcode) })}</Badge> : null}
                {s.storageLocation && s.status === 'stored' ? <Badge tone="neutral">{s.storageLocation}</Badge> : null}
                <div className="ms-auto flex flex-wrap items-center gap-1.5">
                  {s.status === 'pending' && can('samples.collect') ? (
                    <Button size="sm" variant="secondary" disabled={collect.isPending} onClick={() => collect.mutate([s.id])}>
                      <Syringe />
                      {t('collection.markCollected')}
                    </Button>
                  ) : null}
                  {canReceive ? (
                    <Button size="sm" variant="secondary" disabled={receive.isPending} onClick={() => receive.mutate([s.barcode])}>
                      <PackageCheck />
                      {t('reception.receive')}
                    </Button>
                  ) : null}
                  {['received', 'in_analysis', 'stored'].includes(s.status) && can('samples.store') ? (
                    <Button size="sm" variant="ghost" onClick={() => setLocating({ tube: s, mode: 'store' })}>
                      <Archive />
                      {s.status === 'stored' ? t('storage.move') : t('storage.store')}
                    </Button>
                  ) : null}
                  {['collected', 'received', 'stored'].includes(s.status) && can('samples.store', 'samples.collect', 'samples.receive') ? (
                    <Button size="sm" variant="ghost" onClick={() => setLocating({ tube: s, mode: 'transfer' })}>
                      <Truck />
                      {t('storage.transfer')}
                    </Button>
                  ) : null}
                  {!['rejected', 'disposed'].includes(s.status) && can('samples.reject') ? (
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(s)}>
                      <Ban className="text-crit" />
                      {t('reject.short')}
                    </Button>
                  ) : null}
                  {['stored', 'rejected'].includes(s.status) && !s.disposedAt && can('samples.store') ? (
                    <Button size="sm" variant="ghost" onClick={() => setDisposing(s)}>
                      <Trash2 />
                      {t('storage.dispose')}
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-2">
                {s.tests.map((x) => (
                  <Badge key={x.orderItemId} tone="neutral">
                    {bi(x, 'name')}
                    <StatusChip kind="item" status={x.status} className="ms-1 h-[18px] text-[11px]" />
                  </Badge>
                ))}
                {s.status === 'rejected' && s.rejectionReason ? (
                  <span className="text-[12.5px] text-crit">
                    {bi(s.rejectionReason, 'name')}
                    {s.rejectionNote ? ` · ${s.rejectionNote}` : ''}
                  </span>
                ) : null}
              </div>
              {s.events?.length ? (
                <ol className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-line px-4 py-2">
                  {s.events.map((e) => {
                    const Icon = EVENT_ICON[e.type] ?? Plus;
                    return (
                      <li key={e.id} className="flex items-center gap-1.5 text-[12px]">
                        <Icon className={cn('size-3.5', e.type === 'rejected' ? 'text-crit' : 'text-muted')} />
                        <span className="font-medium text-ink-2">{t(`events.${e.type}`, { defaultValue: e.type })}</span>
                        <span className="text-muted tabular">{f.dateTime(e.at)}</span>
                        {e.user ? <span className="text-muted">· {bi(e.user, 'fullName')}</span> : null}
                        {e.toLocation ? <span className="text-muted">→ {e.toLocation}</span> : null}
                        {e.note && e.type !== 'rejected' ? <span className="text-faint">({e.note})</span> : null}
                      </li>
                    );
                  })}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ul>
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

/* ================================================================== results */

const AWAITING = new Set(['resulted', 'verified']);

export function OrderResultsPanel({ orderId }: { orderId: string }) {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const highlight = params.get('tube');
  const errorMessage = useBenchError();
  const signed = useSignedAction();
  const invalidate = useInvalidateBench();
  const query = useQuery({ queryKey: benchKeys.orderResults(orderId), queryFn: () => benchApi.orderResults(orderId) });
  const entry = useResultEntry();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const verify = useVerify(() => setSelected(new Set()));
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [calling, setCalling] = useState<BenchResult | null>(null);
  const [commenting, setCommenting] = useState<BenchResult | null>(null);
  const [rerunning, setRerunning] = useState<BenchResult | null>(null);
  const [amending, setAmending] = useState<BenchResult | null>(null);
  const [signing, setSigning] = useState(false);
  const all = useMemo(() => query.data?.sections.flatMap((s) => s.items.flatMap((i) => i.results)) ?? [], [query.data]);
  useEffect(() => {
    setSelected((s) => {
      const next = new Set([...s].filter((id) => AWAITING.has(all.find((r) => r.id === id)?.status ?? '')));
      return next.size === s.size ? s : next;
    });
  }, [all]);
  const rerun = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => benchApi.rerun(id, reason),
    onSuccess: () => {
      toast.success(t('entry.rerunDone'));
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (query.isLoading) return <PanelLoading />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data;
  if (!data.sections.length) return <EmptyState icon={FlaskConical} title={t('orderPanels.noResults')} />;

  const canPick = can('results.verify', 'results.validate');
  const toVerify = all.filter((r) => selected.has(r.id) && r.status === 'resulted').map((r) => r.id);
  const toValidate = all.filter((r) => selected.has(r.id) && AWAITING.has(r.status)).map((r) => r.id);
  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const actions = (r: BenchResult): ReactNode => (
    <div className="inline-flex items-center gap-0.5">
      {r.isCritical && !r.criticalCalled && r.status !== 'released' && can('results.enter', 'results.verify', 'results.validate') ? (
        <Tooltip content={t('critical.record')}>
          <Button size="icon-sm" variant="ghost" onClick={() => setCalling(r)} aria-label={t('critical.record')}>
            <PhoneCall className="text-crit" />
          </Button>
        </Tooltip>
      ) : null}
      {can('results.enter') && ['pending', 'resulted', 'verified'].includes(r.status) ? (
        <Tooltip content={t('entry.comment')}>
          <Button size="icon-sm" variant="ghost" onClick={() => setCommenting(r)} aria-label={t('entry.comment')}>
            <MessageSquareText className={r.comment ? 'text-info' : undefined} />
          </Button>
        </Tooltip>
      ) : null}
      {AWAITING.has(r.status) && r.analyte.resultType !== 'calculated' && can('results.enter', 'results.verify', 'results.validate') ? (
        <Tooltip content={t('entry.rerunAction')}>
          <Button size="icon-sm" variant="ghost" onClick={() => setRerunning(r)} aria-label={t('entry.rerunAction')}>
            <RotateCcw />
          </Button>
        </Tooltip>
      ) : null}
      {r.status === 'released' && r.analyte.resultType !== 'calculated' && can('results.amend') ? (
        <Tooltip content={t('amend.title')}>
          <Button size="icon-sm" variant="ghost" onClick={() => setAmending(r)} aria-label={t('amend.title')}>
            <FilePen />
          </Button>
        </Tooltip>
      ) : null}
      <Tooltip content={t('history.title')}>
        <Button size="icon-sm" variant="ghost" onClick={() => setHistoryId(r.id)} aria-label={t('history.title')}>
          <History />
        </Button>
      </Tooltip>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {(['pending', 'resulted', 'verified', 'validated', 'released'] as const)
            .filter((k) => data.summary[k] > 0)
            .map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <StatusChip kind="result" status={k} />
                <span className="tabular text-muted">{data.summary[k]}</span>
              </span>
            ))}
          {data.summary.criticalUncalled ? <Badge tone="crit">{t('critical.banner', { count: data.summary.criticalUncalled })}</Badge> : null}
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {entry.dirtyCount ? (
            <Button size="sm" variant="ghost" onClick={entry.discard}>
              <Undo2 />
              {t('worklist.discard')}
            </Button>
          ) : null}
          {can('results.enter') ? (
            <Button size="sm" variant="primary" disabled={!entry.dirtyCount} loading={entry.saving} onClick={entry.save}>
              <Save />
              {t('worklist.save', { count: entry.dirtyCount })}
            </Button>
          ) : null}
          {can('results.verify') ? (
            <Button size="sm" variant="secondary" disabled={!toVerify.length || entry.dirtyCount > 0} loading={verify.isPending} onClick={() => verify.mutate(toVerify)}>
              <CheckCheck />
              {t('worklist.verifySelected', { count: toVerify.length })}
            </Button>
          ) : null}
          {can('results.validate') ? (
            <Button size="sm" variant="secondary" disabled={!toValidate.length || entry.dirtyCount > 0} onClick={() => setSigning(true)}>
              <ShieldCheck />
              {t('validation.validateSelected', { count: toValidate.length })}
            </Button>
          ) : null}
        </div>
      </div>
      {data.sections.map((section) => {
        const tubes = [...new Set(section.items.map((i) => i.sample?.barcode).filter((x): x is string => !!x))];
        const active = !!highlight && tubes.includes(highlight);
        return (
          <Card
            key={section.department.id}
            padded={false}
            className={active ? 'border-accent ring-2 ring-accent/30' : undefined}
            title={bi(section.department, 'name')}
            actions={
              <span className="flex flex-wrap gap-1">
                {tubes.map((b) => (
                  <Badge key={b} tone={b === highlight ? 'accent' : 'neutral'} className="ltr-num font-mono">
                    {b}
                  </Badge>
                ))}
              </span>
            }
          >
            <ResultTable
              results={section.items.flatMap((i) => i.results)}
              mode={can('results.enter') ? 'entry' : 'review'}
              drafts={entry.drafts}
              fieldErrors={entry.fieldErrors}
              onDraft={can('results.enter') ? entry.setDraft : undefined}
              selected={selected}
              onSelect={canPick ? toggle : undefined}
              canSelect={(r) => AWAITING.has(r.status)}
              actions={actions}
            />
          </Card>
        );
      })}
      <ESignDialog
        open={signing}
        onOpenChange={setSigning}
        title={t('validation.signTitle')}
        confirmLabel={t('validation.signConfirm', { count: toValidate.length })}
        onConfirm={signed(async (password) => {
          const res = await benchApi.validate(toValidate, password);
          toast.success(t('validation.done', { count: res.done.length }));
          if (res.skipped.length) toast.info(t('validation.skipped', { count: res.skipped.length }));
          setSelected(new Set());
          invalidate();
        })}
      >
        <p className="text-[13px] text-ink-2">{t('validation.signSummary', { count: toValidate.length, accession: ltr(data.order.accession) })}</p>
      </ESignDialog>
      <ResultHistoryDrawer resultId={historyId} onOpenChange={(o) => !o && setHistoryId(null)} />
      <CriticalCallDialog result={calling} defaultRecipient={data.doctor ? bi(data.doctor, 'name') : null} onOpenChange={(o) => !o && setCalling(null)} />
      <CommentDialog result={commenting} onOpenChange={(o) => !o && setCommenting(null)} />
      <AmendDialog result={amending} onOpenChange={(o) => !o && setAmending(null)} />
      <ConfirmDialog
        open={!!rerunning}
        onOpenChange={(o) => !o && setRerunning(null)}
        title={t('entry.rerunTitle')}
        description={rerunning ? t('entry.rerunHint', { name: bi(rerunning.analyte, 'name'), value: ltr(rerunning.value ?? '') }) : undefined}
        reason="required"
        reasonLabel={t('entry.rerunReason')}
        confirmLabel={t('entry.rerunAction')}
        onConfirm={(reason) => rerun.mutateAsync({ id: rerunning!.id, reason: reason! }).then(
          () => undefined,
          () => undefined,
        )}
      />
    </div>
  );
}

/* ================================================================== reports */

export function OrderReportsPanel({ orderId }: { orderId: string }) {
  const { t } = useTranslation('bench');
  const f = useFormat();
  const bi = useBi();
  const { can } = useAuth();
  const errorMessage = useBenchError();
  const invalidate = useInvalidateBench();
  const query = useQuery({ queryKey: benchKeys.orderReports(orderId), queryFn: () => benchApi.orderReports(orderId) });
  const release = useMutation({
    mutationFn: () => benchApi.release(orderId),
    onSuccess: (r) => {
      toast.success(t('reports.released', { version: r.version, code: ltr(r.verifyCode) }));
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (query.isLoading) return <PanelLoading />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { report, versions, deliveries, releasable } = query.data;
  const origin = window.location.origin;
  const releaseButton =
    can('results.validate') && releasable.validated > 0 ? (
      <Tooltip content={releasable.criticalUncalled ? t('critical.releaseBlocked') : null}>
        <span>
          <Button variant="primary" size="sm" disabled={releasable.criticalUncalled > 0} loading={release.isPending} onClick={() => release.mutate()}>
            <FileCheck />
            {t('reports.release', { count: releasable.validated })}
          </Button>
        </span>
      </Tooltip>
    ) : null;

  if (!report) {
    return <EmptyState icon={FileCheck} title={t('reports.none')} description={releasable.validated ? t('reports.readyToRelease', { count: releasable.validated }) : t('reports.noneHint')} action={releaseButton} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            {t('reports.current', { version: report.version })}
            <Badge tone="ok">{t('reports.status.released')}</Badge>
            {report.snapshot.partial ? <Badge tone="warn">{t('delivery.partial')}</Badge> : null}
          </span>
        }
        description={t('reports.releasedBy', { time: f.dateTime(report.releasedAt), name: report.releasedBy ? bi(report.releasedBy, 'fullName') : '—' })}
        actions={
          <>
            {releaseButton}
            <DeliverActions orderId={orderId} labels />
          </>
        }
      >
        <div className="flex flex-wrap items-start gap-5">
          <a href={`${origin}/verify/${report.verifyCode}`} target="_blank" rel="noreferrer" className="shrink-0 rounded-lg border border-line bg-white p-2" title={t('reports.verifyLink')}>
            <QrCode value={`${origin}/verify/${report.verifyCode}`} size={84} />
          </a>
          <dl className="grid min-w-0 flex-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[12px] text-muted">{t('reports.verifyCode')}</dt>
              <dd className="ltr-num font-mono text-[15px] font-semibold tracking-wider">{report.verifyCode}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">{t('reports.tests')}</dt>
              <dd>{report.snapshot.sections.reduce((n, s) => n + s.tests.length, 0)}</dd>
            </div>
            {report.amendReason ? (
              <div className="sm:col-span-2">
                <dt className="text-[12px] text-muted">{t('reports.amendReason')}</dt>
                <dd className="text-warn">{report.amendReason}</dd>
              </div>
            ) : null}
            {report.snapshot.pendingTests.length ? (
              <div className="sm:col-span-2">
                <dt className="text-[12px] text-muted">{t('reports.pendingTests')}</dt>
                <dd>{report.snapshot.pendingTests.map((p) => bi(p, 'name')).join(' · ')}</dd>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <dt className="text-[12px] text-muted">{t('reports.hash')}</dt>
              <dd className="ltr-num font-mono text-[11.5px] break-all text-muted">{report.contentHash}</dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card title={t('reports.versions')} padded={false}>
        <ul className="divide-y divide-line">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <Badge tone="neutral" className="ltr-num">
                v{v.version}
              </Badge>
              <Badge tone={v.status === 'released' ? 'ok' : 'muted'}>{t(`reports.status.${v.status}`)}</Badge>
              <span className="text-muted tabular">{f.dateTime(v.releasedAt)}</span>
              <span className="text-muted">{v.releasedBy ? bi(v.releasedBy, 'fullName') : ''}</span>
              {v.amendReason ? <span className="text-[12.5px] text-warn">{v.amendReason}</span> : null}
              <span className="ms-auto ltr-num font-mono text-[12px] text-muted">{v.verifyCode}</span>
              {can('reports.print', 'results.read') ? (
                <Button size="sm" variant="ghost" onClick={() => openPrint(`/print/report/${orderId}?version=${v.version}`)}>
                  <Printer />
                  {t('common:actions.print')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t('reports.deliveries')} padded={false}>
        {deliveries.length ? (
          <ul className="divide-y divide-line">
            {deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className="font-medium">{t(`delivery.channels.${d.channel}`)}</span>
                <StatusChip kind="delivery" status={d.status} />
                {d.toAddress ? <span className="ltr-num text-muted">{d.toAddress}</span> : null}
                {d.reportVersion ? <span className="ltr-num text-[12px] text-muted">v{d.reportVersion}</span> : null}
                <span className="ms-auto text-[12px] text-muted">
                  {d.createdBy ? `${bi(d.createdBy, 'fullName')} · ` : ''}
                  {f.dateTime(d.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-4 text-[13px] text-muted">{t('delivery.notYet')}</p>
        )}
      </Card>
    </div>
  );
}

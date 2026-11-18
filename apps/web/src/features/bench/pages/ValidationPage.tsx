import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FileCheck, History, PhoneCall, Printer, RotateCcw, ShieldCheck, Siren, Stethoscope } from 'lucide-react';
import type { BenchOrderResults, BenchResult, ValidationQueueRow } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { openPrint } from '@/lib/print';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ESignDialog,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  StatusChip,
  Switch,
  toast,
  Tooltip,
} from '@/components/ui';
import { benchApi, benchKeys, useBenchMeta } from '../api';
import { ltr, PatientCell, PriorityBadge, ResultValue, SexAge, useBenchError, useSignedAction } from '../components/common';
import { CriticalCallDialog, ResultHistoryDrawer } from '../components/ResultDialogs';
import { ResultTable } from '../components/ResultTable';
import { useInvalidateBench } from '../components/useResultEntry';

const AWAITING = new Set(['resulted', 'verified']);

/** Medical validation: the queue on one side, the order's results to review, sign and release on the other. */
export default function ValidationPage() {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const meta = useBenchMeta();
  const [department, setDepartment] = useState('');
  const [priority, setPriority] = useState('');
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);
  const params = { departmentId: department || undefined, priority: priority || undefined, critical: criticalOnly || undefined, q: search || undefined };
  const queue = useQuery({ queryKey: benchKeys.validationQueue(params), queryFn: () => benchApi.validationQueue(params), refetchInterval: 60_000 });
  const items = queue.data?.items ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && items.length) setSelectedId(items[0]!.order.id);
  }, [items, selectedId]);
  const next = () => {
    const i = items.findIndex((r) => r.order.id === selectedId);
    setSelectedId(items[i + 1]?.order.id ?? items.find((r) => r.order.id !== selectedId)?.order.id ?? null);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('validation.title')} description={t('validation.description')} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(270px,330px)_1fr]">
        <Card padded={false} className="lg:sticky lg:top-0">
          <div className="flex flex-col gap-2 border-b border-line p-3">
            <SearchInput value={q} onChange={setQ} placeholder={t('validation.search')} />
            <div className="grid grid-cols-2 gap-2">
              <Select
                size="sm"
                value={department || 'any'}
                onValueChange={(v) => setDepartment(v === 'any' ? '' : v)}
                options={[{ value: 'any', label: t('worklist.allDepartments') }, ...(meta.data?.departments ?? []).map((d) => ({ value: d.id, label: bi(d, 'name') }))]}
              />
              <Select
                size="sm"
                value={priority || 'any'}
                onValueChange={(v) => setPriority(v === 'any' ? '' : v)}
                options={[
                  { value: 'any', label: t('validation.anyPriority') },
                  { value: 'stat', label: t('common:status.priority.stat') },
                  { value: 'urgent', label: t('common:status.priority.urgent') },
                  { value: 'routine', label: t('common:status.priority.routine') },
                ]}
              />
            </div>
            <Switch checked={criticalOnly} onCheckedChange={setCriticalOnly} label={t('validation.criticalOnly')} />
          </div>
          <div className="max-h-[calc(100dvh-280px)] overflow-y-auto">
            {queue.isLoading ? (
              <div className="flex flex-col gap-2 p-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            ) : queue.isError ? (
              <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
            ) : !items.length ? (
              <EmptyState icon={ShieldCheck} title={t('validation.empty')} description={t('validation.emptyHint')} />
            ) : (
              <ul className="divide-y divide-line">
                {items.map((row) => (
                  <QueueItem key={row.order.id} row={row} active={row.order.id === selectedId} onSelect={() => setSelectedId(row.order.id)} />
                ))}
              </ul>
            )}
          </div>
        </Card>
        {selectedId ? (
          <ReviewPanel key={selectedId} orderId={selectedId} onDone={next} />
        ) : (
          <Card>
            <EmptyState icon={Stethoscope} title={t('validation.pick')} />
          </Card>
        )}
      </div>
    </div>
  );
}

function QueueItem({ row, active, onSelect }: { row: ValidationQueueRow; active: boolean; onSelect: () => void }) {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const f = useFormat();
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn('flex w-full flex-col gap-1 px-3 py-2.5 text-start transition-colors hover:bg-sunken', active && 'bg-accent-soft hover:bg-accent-soft')}
        aria-current={active || undefined}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{bi(row.patient, 'fullName')}</span>
          <PriorityBadge priority={row.order.priority} />
          {row.critical ? (
            <Badge tone="crit">
              <Siren className="size-3" />
              {row.critical}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
          <span className="ltr-num font-mono">{row.order.accession}</span>
          <SexAge patient={row.patient} />
          <span>· {row.departments.map((d) => d.code).join(', ')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <Badge tone="violet" className="h-[20px] text-[11px]">
            {t('validation.awaiting', { count: row.awaiting })}
          </Badge>
          {row.abnormal ? (
            <Badge tone="warn" className="h-[20px] text-[11px]">
              {t('validation.abnormal', { count: row.abnormal })}
            </Badge>
          ) : null}
          {!row.allReady ? (
            <Badge tone="muted" className="h-[20px] text-[11px]">
              {t('validation.stillPending', { count: row.counts.pending })}
            </Badge>
          ) : null}
          <span className="ms-auto text-muted">{f.relative(row.readySince ?? row.order.createdAt)}</span>
        </div>
      </button>
    </li>
  );
}

function ReviewPanel({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const { can } = useAuth();
  const errorMessage = useBenchError();
  const signed = useSignedAction();
  const invalidate = useInvalidateBench();
  const query = useQuery({ queryKey: benchKeys.orderResults(orderId), queryFn: () => benchApi.orderResults(orderId) });
  const reports = useQuery({ queryKey: benchKeys.orderReports(orderId), queryFn: () => benchApi.orderReports(orderId) });
  const data = query.data;
  const all = useMemo(() => data?.sections.flatMap((s) => s.items.flatMap((i) => i.results)) ?? [], [data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data && !seeded) {
      setSelected(new Set(all.filter((r) => AWAITING.has(r.status)).map((r) => r.id)));
      setSeeded(true);
    }
  }, [data, all, seeded]);
  useEffect(() => {
    setSelected((s) => {
      const next = new Set([...s].filter((id) => AWAITING.has(all.find((r) => r.id === id)?.status ?? '')));
      return next.size === s.size ? s : next;
    });
  }, [all]);
  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const [signing, setSigning] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [calling, setCalling] = useState<BenchResult | null>(null);
  const [rerunning, setRerunning] = useState<BenchResult | null>(null);
  const rerun = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => benchApi.rerun(id, reason),
    onSuccess: () => {
      toast.success(t('entry.rerunDone'));
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const release = useMutation({
    mutationFn: () => benchApi.release(orderId),
    onSuccess: (r) => {
      toast.success(t('reports.released', { version: r.version, code: ltr(r.verifyCode) }), {
        action: { label: t('common:actions.print'), onClick: () => openPrint(`/print/report/${orderId}`) },
      });
      invalidate();
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (query.isLoading) {
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-64" />
        </div>
      </Card>
    );
  }
  if (query.isError || !data) return <Card><ErrorState error={query.error} onRetry={() => void query.refetch()} /></Card>;

  const uncalled = all.filter((r) => r.isCritical && !r.criticalCalled && r.status !== 'released');
  const releasable = reports.data?.releasable;
  const canRelease = can('results.validate') && !!releasable && releasable.validated > 0 && releasable.criticalUncalled === 0;
  const selectedResults = all.filter((r) => selected.has(r.id));
  const actions = (r: BenchResult) => (
    <div className="inline-flex items-center gap-0.5">
      {r.isCritical && !r.criticalCalled && r.status !== 'released' ? (
        <Tooltip content={t('critical.record')}>
          <Button size="icon-sm" variant="ghost" onClick={() => setCalling(r)} aria-label={t('critical.record')}>
            <PhoneCall className="text-crit" />
          </Button>
        </Tooltip>
      ) : null}
      {AWAITING.has(r.status) && r.analyte.resultType !== 'calculated' ? (
        <Tooltip content={t('validation.returnForRerun')}>
          <Button size="icon-sm" variant="ghost" onClick={() => setRerunning(r)} aria-label={t('validation.returnForRerun')}>
            <RotateCcw />
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
    <div className="flex min-w-0 flex-col gap-3">
      <Card padded={false}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
          <PatientCell patient={data.patient} orderId={data.order.id} accession={data.order.accession} />
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={data.order.priority} />
            <StatusChip kind="order" status={data.order.status} />
            {data.doctor ? (
              <span className="inline-flex items-center gap-1 text-[12.5px] text-muted">
                <Stethoscope className="size-3.5" />
                {bi(data.doctor, 'name')}
              </span>
            ) : null}
            <Link to={`/orders/${orderId}`} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
              {t('worklist.openOrder')}
            </Link>
          </div>
        </div>
        {data.order.clinicalInfo || data.order.notes ? (
          <p className="border-t border-line bg-sunken/60 px-4 py-1.5 text-[12.5px] text-ink-2">{[data.order.clinicalInfo, data.order.notes].filter(Boolean).join(' · ')}</p>
        ) : null}
        <Summary data={data} />
      </Card>

      {uncalled.length ? (
        <div className="rounded-[var(--radius-card)] border border-crit/50 bg-crit-soft px-4 py-3" role="alert">
          <div className="flex items-center gap-2 font-semibold text-crit">
            <Siren className="size-5" />
            {t('critical.banner', { count: uncalled.length })}
          </div>
          <p className="mt-0.5 text-[12.5px] text-ink-2">{t('critical.bannerHint')}</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {uncalled.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-surface px-3 py-1.5">
                <span className="font-medium">{bi(r.analyte, 'name')}</span>
                <ResultValue result={r} />
                <span className="ltr-num text-[12px] text-muted">{r.unit}</span>
                <Button size="sm" variant="danger" className="ms-auto" onClick={() => setCalling(r)}>
                  <PhoneCall />
                  {t('critical.record')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.sections.map((section) => (
        <Card key={section.department.id} padded={false} title={bi(section.department, 'name')}>
          <ResultTable
            results={section.items.flatMap((i) => i.results)}
            mode="review"
            selected={selected}
            onSelect={can('results.validate') ? toggle : undefined}
            canSelect={(r) => AWAITING.has(r.status)}
            actions={actions}
          />
        </Card>
      ))}

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface/95 px-4 py-3 shadow-pop backdrop-blur">
        <span className="text-[12.5px] text-muted">{t('validation.selected', { count: selected.size })}</span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {reports.data?.report ? (
            <Button size="sm" variant="ghost" onClick={() => openPrint(`/print/report/${orderId}`)}>
              <Printer />
              {t('reports.printLatest', { version: reports.data.report.version })}
            </Button>
          ) : null}
          {can('results.validate') ? (
            <>
              <Button variant="secondary" disabled={!selected.size} onClick={() => setSigning(true)}>
                <ShieldCheck />
                {t('validation.validateSelected', { count: selected.size })}
              </Button>
              <Tooltip content={releasable?.criticalUncalled ? t('critical.releaseBlocked') : !releasable?.validated ? t('reports.nothingToRelease') : null}>
                <span>
                  <Button variant="primary" disabled={!canRelease} loading={release.isPending} onClick={() => release.mutate()}>
                    <FileCheck />
                    {t('reports.release', { count: releasable?.validated ?? 0 })}
                  </Button>
                </span>
              </Tooltip>
            </>
          ) : null}
        </div>
      </div>

      <ESignDialog
        open={signing}
        onOpenChange={setSigning}
        title={t('validation.signTitle')}
        confirmLabel={t('validation.signConfirm', { count: selected.size })}
        onConfirm={signed(async (password) => {
          const res = await benchApi.validate([...selected], password);
          toast.success(t('validation.done', { count: res.done.length }));
          if (res.skipped.length) toast.info(t('validation.skipped', { count: res.skipped.length }));
          setSelected(new Set());
          invalidate();
        })}
      >
        <div className="rounded-lg border border-line bg-sunken px-3 py-2 text-[13px]">
          <div className="font-medium text-ink">{t('validation.signSummary', { count: selectedResults.length, accession: ltr(data.order.accession) })}</div>
          <div className="mt-1 text-[12.5px] text-muted">
            {selectedResults
              .slice(0, 8)
              .map((r) => `${r.analyte.code} ${r.value ?? ''}`)
              .join(' · ')}
            {selectedResults.length > 8 ? ' …' : ''}
          </div>
          {selectedResults.some((r) => r.isCritical) ? <div className="mt-1 text-[12.5px] font-medium text-crit">{t('validation.includesCritical')}</div> : null}
        </div>
      </ESignDialog>
      <ResultHistoryDrawer resultId={historyId} onOpenChange={(o) => !o && setHistoryId(null)} />
      <CriticalCallDialog result={calling} defaultRecipient={data.doctor ? bi(data.doctor, 'name') : null} onOpenChange={(o) => !o && setCalling(null)} />
      <ConfirmDialog
        open={!!rerunning}
        onOpenChange={(o) => !o && setRerunning(null)}
        title={t('validation.returnForRerun')}
        description={rerunning ? t('entry.rerunHint', { name: bi(rerunning.analyte, 'name'), value: ltr(rerunning.value ?? '') }) : undefined}
        reason="required"
        reasonLabel={t('entry.rerunReason')}
        confirmLabel={t('validation.returnForRerun')}
        onConfirm={(reason) => rerun.mutateAsync({ id: rerunning!.id, reason: reason! }).then(
          () => undefined,
          () => undefined,
        )}
      />
    </div>
  );
}

function Summary({ data }: { data: BenchOrderResults }) {
  const { t } = useTranslation('bench');
  const s = data.summary;
  const parts: Array<[string, number]> = [
    ['pending', s.pending],
    ['resulted', s.resulted],
    ['verified', s.verified],
    ['validated', s.validated],
    ['released', s.released],
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-[12px]">
      {parts
        .filter(([, n]) => n > 0)
        .map(([k, n]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <StatusChip kind="result" status={k} />
            <span className="tabular text-muted">{n}</span>
          </span>
        ))}
      <span className="ms-auto text-muted">{t('validation.total', { count: s.total })}</span>
    </div>
  );
}

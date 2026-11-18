import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CheckCheck, FlaskConical, History, MessageSquareText, PhoneCall, RotateCcw, Save, Undo2 } from 'lucide-react';
import type { BenchResult, WorklistGroup } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DateRangePicker,
  EmptyState,
  ErrorState,
  Kbd,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
  Tooltip,
  useTodayRange,
  type DateRange,
} from '@/components/ui';
import { benchApi, benchKeys, useBenchMeta } from '../api';
import { ltr, PatientCell, PriorityBadge, TubeCell, useBenchError, WaitTime } from '../components/common';
import { CommentDialog, CriticalCallDialog, ResultHistoryDrawer } from '../components/ResultDialogs';
import { ResultTable } from '../components/ResultTable';
import { useInvalidateBench, useResultEntry, useVerify } from '../components/useResultEntry';

type Status = 'pending' | 'to_verify' | 'all';

/** Bench result entry: tubes for a department, values typed straight into the grid, Ctrl+S to save. */
export default function WorklistPage() {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const { can } = useAuth();
  const meta = useBenchMeta();
  const today = useTodayRange();
  const [dept, setDept] = useState<string>('');
  const [status, setStatus] = useState<Status>('pending');
  const [instrumentId, setInstrumentId] = useState('');
  const [range, setRange] = useState<DateRange>(today);
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);

  const departments = useMemo(() => {
    const all = meta.data?.departments ?? [];
    const mine = meta.data?.myDepartmentIds ?? [];
    return mine.length ? all.filter((d) => mine.includes(d.id)) : all;
  }, [meta.data]);
  const showAll = departments.length > 1;
  useEffect(() => {
    if (!dept && departments.length === 1) setDept(departments[0]!.id);
  }, [dept, departments]);
  const instruments = (meta.data?.instruments ?? []).filter((i) => !dept || !i.departmentId || i.departmentId === dept);

  const params = {
    departmentId: dept || undefined,
    instrumentId: instrumentId || undefined,
    status,
    q: search || undefined,
    from: status === 'all' ? range.from : undefined,
    to: status === 'all' ? range.to : undefined,
  };
  const query = useQuery({ queryKey: benchKeys.worklist(params), queryFn: () => benchApi.worklist(params), enabled: meta.isSuccess });

  const entry = useResultEntry();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const verify = useVerify(() => setSelected(new Set()));
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<BenchResult | null>(null);
  const [rerunning, setRerunning] = useState<BenchResult | null>(null);
  const [calling, setCalling] = useState<BenchResult | null>(null);
  const errorMessage = useBenchError();
  const invalidate = useInvalidateBench();
  const rerun = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => benchApi.rerun(id, reason),
    onSuccess: () => {
      toast.success(t('entry.rerunDone'));
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const groups = query.data?.groups ?? [];
  const resultsById = useMemo(() => new Map(groups.flatMap((g) => g.results.map((r) => [r.id, r] as const))), [groups]);
  useEffect(() => {
    setSelected((s) => {
      const next = new Set([...s].filter((id) => resultsById.get(id)?.status === 'resulted'));
      return next.size === s.size ? s : next;
    });
  }, [resultsById]);
  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const actions = (r: BenchResult) => (
    <div className="inline-flex items-center gap-0.5">
      {r.isCritical && !r.criticalCalled && r.status !== 'released' ? (
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
      {['resulted', 'verified'].includes(r.status) && r.analyte.resultType !== 'calculated' ? (
        <Tooltip content={t('entry.rerunAction')}>
          <Button size="icon-sm" variant="ghost" onClick={() => setRerunning(r)} aria-label={t('entry.rerunAction')}>
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
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('worklist.title')}
        description={t('worklist.description')}
        actions={
          <span className="hidden items-center gap-1.5 text-[12px] text-muted md:inline-flex">
            <Kbd>Enter</Kbd> {t('worklist.nextField')} · <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> {t('worklist.saveAll')}
          </span>
        }
      />
      {departments.length ? (
        <Tabs value={dept || 'all'} onValueChange={(v) => setDept(v === 'all' ? '' : v)}>
          <TabsList>
            {showAll ? <TabsTrigger value="all">{meta.data?.myDepartmentIds.length ? t('worklist.myDepartments') : t('worklist.allDepartments')}</TabsTrigger> : null}
            {departments.map((d) => (
              <TabsTrigger key={d.id} value={d.id}>
                {bi(d, 'name')}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}

      <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface/95 px-3 py-2 shadow-sm backdrop-blur">
        <Segmented
          size="sm"
          value={status}
          onChange={(v) => setStatus(v)}
          options={[
            { value: 'pending', label: t('worklist.status.pending'), count: query.data?.counts.pending },
            { value: 'to_verify', label: t('worklist.status.to_verify'), count: query.data?.counts.toVerify },
            { value: 'all', label: t('worklist.status.all') },
          ]}
        />
        <Select
          size="sm"
          className="w-48"
          value={instrumentId || 'any'}
          onValueChange={(v) => setInstrumentId(v === 'any' ? '' : v)}
          options={[{ value: 'any', label: t('worklist.anyInstrument') }, ...instruments.map((i) => ({ value: i.id, label: i.name, hint: i.code }))]}
        />
        {status === 'all' ? <DateRangePicker value={range} onChange={setRange} /> : null}
        <div className="w-56">
          <SearchInput value={q} onChange={setQ} placeholder={t('worklist.search')} />
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {entry.dirtyCount ? (
            <Button size="sm" variant="ghost" onClick={entry.discard}>
              <Undo2 />
              {t('worklist.discard')}
            </Button>
          ) : null}
          {can('results.verify') ? (
            <Button size="sm" variant="secondary" disabled={!selected.size || verify.isPending || entry.dirtyCount > 0} loading={verify.isPending} onClick={() => verify.mutate([...selected])}>
              <CheckCheck />
              {t('worklist.verifySelected', { count: selected.size })}
            </Button>
          ) : null}
          {can('results.enter') ? (
            <Button size="sm" variant="primary" disabled={!entry.dirtyCount} loading={entry.saving} onClick={entry.save}>
              <Save />
              {t('worklist.save', { count: entry.dirtyCount })}
            </Button>
          ) : null}
        </div>
      </div>

      {query.isLoading || meta.isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : !groups.length ? (
        <Card>
          <EmptyState icon={FlaskConical} title={t(`worklist.empty.${status}`)} description={t('worklist.emptyHint')} />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {query.data!.total > groups.length ? <p className="text-[12.5px] text-muted">{t('worklist.showing', { shown: groups.length, total: query.data!.total })}</p> : null}
          {groups.map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              entry={entry}
              selected={selected}
              onSelect={can('results.verify') ? toggle : undefined}
              actions={actions}
              editable={can('results.enter')}
            />
          ))}
        </div>
      )}

      <ResultHistoryDrawer resultId={historyId} onOpenChange={(o) => !o && setHistoryId(null)} />
      <CommentDialog result={commenting} onOpenChange={(o) => !o && setCommenting(null)} />
      <CriticalCallDialog result={calling} onOpenChange={(o) => !o && setCalling(null)} />
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

function GroupCard({
  group,
  entry,
  selected,
  onSelect,
  actions,
  editable,
}: {
  group: WorklistGroup;
  entry: ReturnType<typeof useResultEntry>;
  selected: Set<string>;
  onSelect?: (ids: string[], on: boolean) => void;
  actions: (r: BenchResult) => ReactNode;
  editable: boolean;
}) {
  const { t } = useTranslation('bench');
  const bi = useBi();
  const critical = group.results.some((r) => r.isCritical && r.status !== 'released');
  return (
    <section className={cn('rounded-[var(--radius-card)] border bg-surface', critical ? 'border-crit/50' : group.order.priority === 'stat' ? 'border-crit/40' : group.order.priority === 'urgent' ? 'border-warn/50' : 'border-line')}>
      <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-2.5">
        <TubeCell container={group.sample.container} barcode={group.sample.barcode} sub={bi(group.sample.sampleType, 'name')} />
        <PatientCell patient={group.patient} orderId={group.order.id} accession={group.order.accession} />
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge priority={group.order.priority} />
          {group.order.fasting ? <Badge tone="info">{t('collection.fasting')}</Badge> : null}
          {group.order.pregnant ? <Badge tone="violet">{t('worklist.pregnant')}</Badge> : null}
          {critical ? <Badge tone="crit">{t('critical.label')}</Badge> : null}
        </div>
        <div className="ms-auto flex items-center gap-3 text-[12.5px] text-muted">
          <span>
            {t('worklist.waiting')} <WaitTime since={group.waitingSince} className="font-medium" />
          </span>
          <Link to={`/orders/${group.order.id}?tube=${encodeURIComponent(group.sample.barcode)}`} className="text-accent hover:underline">
            {t('worklist.openOrder')}
          </Link>
        </div>
      </header>
      {group.order.clinicalInfo || group.order.notes ? (
        <p className="border-b border-line bg-sunken/60 px-4 py-1.5 text-[12.5px] text-ink-2">{[group.order.clinicalInfo, group.order.notes].filter(Boolean).join(' · ')}</p>
      ) : null}
      <ResultTable
        results={group.results}
        mode="entry"
        drafts={entry.drafts}
        fieldErrors={entry.fieldErrors}
        onDraft={editable ? entry.setDraft : undefined}
        selected={selected}
        onSelect={onSelect}
        canSelect={(r) => r.status === 'resulted'}
        actions={actions}
      />
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, CalendarClock, Pencil, Plus, Wrench } from 'lucide-react';
import type { MaintenanceItem, QcMaterialItem, QcRunItem } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, PageHeader, Segmented, Select, Skeleton, StatusChip, type ColumnDef } from '@/components/ui';
import { ins, keys, useFormData } from '../api';
import { Code } from '../components/common';
import { LeveyJennings } from '../components/LeveyJennings';
import { MaintenanceDialog, MaintenanceOutcome } from '../components/Maintenance';
import { MaterialDialog, RunDialog } from '../components/QcDialogs';

const ALL = 'all';

/** QC materials, Levey-Jennings charts with Westgard verdicts, and maintenance that is due. */
export default function QcPage() {
  const { t } = useTranslation('instruments');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const form = useFormData();
  const [instrument, setInstrument] = useState(ALL);
  const [active, setActive] = useState<'true' | 'all'>('true');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<QcMaterialItem | 'new' | null>(null);
  const [running, setRunning] = useState<QcMaterialItem | null>(null);
  const [maintaining, setMaintaining] = useState(false);
  const write = can('qc.write');

  const params = useMemo(() => ({ instrumentId: instrument === ALL ? undefined : instrument, active }), [instrument, active]);
  const materials = useQuery({ queryKey: keys.qcMaterials(params), queryFn: () => ins.qcMaterials(params) });
  useEffect(() => {
    if (materials.data && (!selected || !materials.data.some((m) => m.id === selected))) setSelected(materials.data[0]?.id ?? null);
  }, [materials.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const material = materials.data?.find((m) => m.id === selected) ?? null;

  const columns = useMemo<ColumnDef<QcMaterialItem>[]>(
    () => [
      {
        id: 'analyte',
        header: t('qc.col.analyte'),
        accessorFn: (m) => m.analyte.code,
        cell: ({ row }) => (
          <span className="flex flex-col">
            <Code className="font-semibold">{row.original.analyte.code}</Code>
            <span className="text-[11.5px] text-muted">{bi(row.original.analyte, 'name')}</span>
          </span>
        ),
      },
      {
        id: 'material',
        header: t('qc.col.material'),
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="text-[13px] text-ink">
              {row.original.name} <Code className="text-muted">{row.original.level}</Code>
            </span>
            <span className="text-[11.5px] text-muted">
              {t('qc.col.lot')} <Code className="whitespace-nowrap">{row.original.lot}</Code>
              {row.original.instrument ? (
                <>
                  {' · '}
                  <Code>{row.original.instrument.code}</Code>
                </>
              ) : null}
            </span>
          </span>
        ),
      },
      {
        id: 'target',
        header: t('qc.col.target'),
        meta: { align: 'end' },
        cell: ({ row }) => (
          <span className="flex flex-col items-end">
            <Code className="whitespace-nowrap">{`${f.number(row.original.targetMean)} ± ${f.number(row.original.targetSd)}`}</Code>
            {row.original.unit ? <Code className="text-[11.5px] text-muted">{row.original.unit}</Code> : null}
          </span>
        ),
      },
      {
        id: 'last',
        header: t('qc.col.last'),
        cell: ({ row }) => {
          const m = row.original;
          const expired = !!m.expiresOn && m.expiresOn < f.today();
          return (
            <span className="flex flex-col items-start gap-1">
              {m.lastRun ? <StatusChip kind="qc" status={m.lastRun.status} /> : <span className="text-[12px] text-muted">{t('qc.noRuns')}</span>}
              {expired ? <Badge tone="crit">{t('qc.expired')}</Badge> : null}
              {!m.isActive ? <Badge tone="muted">{t('qc.inactive')}</Badge> : null}
            </span>
          );
        },
      },
      ...(write
        ? [
            {
              id: 'edit',
              header: '',
              cell: ({ row }: { row: { original: QcMaterialItem } }) => (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('common:actions.edit')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(row.original);
                  }}
                >
                  <Pencil />
                </Button>
              ),
            } satisfies ColumnDef<QcMaterialItem>,
          ]
        : []),
    ],
    [t, f, bi, write],
  );

  return (
    <div>
      <PageHeader
        title={t('qc.title')}
        description={t('qc.description')}
        actions={
          write ? (
            <>
              <Button onClick={() => setMaintaining(true)}>
                <Wrench />
                {t('maintenance.add')}
              </Button>
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus />
                {t('qc.addMaterial')}
              </Button>
            </>
          ) : null
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-56">
              <Select
                value={instrument}
                onValueChange={setInstrument}
                options={[{ value: ALL, label: t('qc.allInstruments') }, ...(form.data?.instruments ?? []).map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))]}
              />
            </div>
            <Segmented
              size="sm"
              value={active}
              onChange={setActive}
              options={[
                { value: 'true', label: t('qc.activeOnly') },
                { value: 'all', label: t('qc.allMaterials') },
              ]}
            />
          </div>
          <DataTable
            dense
            columns={columns}
            data={materials.data}
            loading={materials.isLoading}
            error={materials.error}
            onRetry={() => void materials.refetch()}
            onRowClick={(m) => setSelected(m.id)}
            rowClassName={(m) => (m.id === selected ? 'bg-accent-soft/60' : undefined)}
            empty={{ icon: Activity, title: t('qc.emptyMaterials'), description: write ? t('qc.emptyMaterialsHint') : undefined }}
            maxHeight="70vh"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {material ? (
            <MaterialPanel material={material} onRun={write ? () => setRunning(material) : undefined} />
          ) : materials.isLoading ? (
            <Skeleton className="h-80" />
          ) : (
            <Card>
              <EmptyState icon={Activity} title={t('qc.pickMaterial')} />
            </Card>
          )}
        </div>
      </div>
      <MaintenanceDue />
      <MaterialDialog value={editing} onClose={() => setEditing(null)} />
      <RunDialog material={running} onClose={() => setRunning(null)} />
      <MaintenanceDialog open={maintaining} onClose={() => setMaintaining(false)} instruments={form.data?.instruments} />
    </div>
  );
}

function MaterialPanel({ material, onRun }: { material: QcMaterialItem; onRun?: () => void }) {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const bi = useBi();
  const chart = useQuery({ queryKey: keys.qcChart(material.id, {}), queryFn: () => ins.chart(material.id, {}) });
  const runsParams = useMemo(() => ({ materialId: material.id, limit: 50 }), [material.id]);
  const runs = useQuery({ queryKey: keys.qcRuns(runsParams), queryFn: () => ins.runs(runsParams), placeholderData: keepPreviousData });
  const columns = useMemo<ColumnDef<QcRunItem>[]>(
    () => [
      { id: 'at', header: t('qc.col.runAt'), cell: ({ row }) => <span className="whitespace-nowrap tabular">{f.dateTime(row.original.runAt)}</span> },
      { id: 'value', header: t('qc.value'), meta: { align: 'end' }, cell: ({ row }) => <Code className="font-semibold">{f.number(row.original.value)}</Code> },
      { id: 'z', header: 'z', meta: { align: 'end' }, cell: ({ row }) => <Code className="text-muted">{row.original.z === null ? '—' : f.number(row.original.z, 2)}</Code> },
      { id: 'status', header: t('qc.col.status'), cell: ({ row }) => <StatusChip kind="qc" status={row.original.status} /> },
      {
        id: 'rules',
        header: t('qc.col.rules'),
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            {row.original.violations.map((v) => (
              <Badge key={v} tone={row.original.status === 'rejected' ? 'crit' : 'warn'} className="ltr-num">
                <span title={t(`qc.rules.${v}`, { defaultValue: v })}>{v}</span>
              </Badge>
            ))}
          </span>
        ),
      },
      { id: 'source', header: t('qc.col.source'), cell: ({ row }) => <span className="text-[12.5px]">{t(`qc.sources.${row.original.source}`)}</span> },
      { id: 'user', header: t('qc.col.user'), cell: ({ row }) => <span className="text-[12.5px] text-muted">{bi(row.original.user, 'fullName') || '—'}</span> },
    ],
    [t, f, bi],
  );
  const s = chart.data?.stats;
  return (
    <>
      <Card
        title={
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <Code className="text-[15px] font-semibold">{material.analyte.code}</Code>
            {bi(material.analyte, 'name')} · {material.name} <Code className="text-muted">{material.level}</Code>
          </span>
        }
        description={t('qc.chartHint', { mean: f.number(material.targetMean), sd: f.number(material.targetSd), unit: material.unit ?? '' })}
        actions={
          onRun ? (
            <Button variant="primary" onClick={onRun} disabled={!material.isActive}>
              <Plus />
              {t('qc.enterRun')}
            </Button>
          ) : null
        }
      >
        {chart.isLoading ? (
          <Skeleton className="h-72" />
        ) : chart.error ? (
          <ErrorState error={chart.error} onRetry={() => void chart.refetch()} />
        ) : chart.data && chart.data.points.length ? (
          <>
            <LeveyJennings chart={chart.data} />
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted">
              <span>
                {t('qc.stats.n')} <span className="font-semibold text-ink tabular">{s?.n}</span>
              </span>
              <span>
                {t('qc.stats.mean')} <Code className="font-semibold text-ink">{f.number(s?.observedMean ?? null)}</Code>
              </span>
              <span>
                {t('qc.stats.sd')} <Code className="font-semibold text-ink">{f.number(s?.observedSd ?? null)}</Code>
              </span>
              <span>
                CV <Code className="font-semibold text-ink">{f.percent(s?.cvPct ?? null, 1)}</Code>
              </span>
              <span className="ms-auto inline-flex items-center gap-3">
                <Legend shape="circle" label={t('common:status.qc.accepted')} color="var(--c-ok)" />
                <Legend shape="triangle" label={t('common:status.qc.warning')} color="var(--c-warn)" />
                <Legend shape="square" label={t('common:status.qc.rejected')} color="var(--c-crit)" />
              </span>
            </div>
          </>
        ) : (
          <EmptyState icon={Activity} title={t('qc.noRuns')} description={onRun ? t('qc.noRunsHint') : undefined} />
        )}
      </Card>
      <DataTable
        dense
        columns={columns}
        data={runs.data?.items}
        loading={runs.isLoading}
        error={runs.error}
        onRetry={() => void runs.refetch()}
        empty={{ title: t('qc.noRuns') }}
        maxHeight="40vh"
      />
    </>
  );
}

function Legend({ shape, label, color }: { shape: 'circle' | 'triangle' | 'square'; label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
        {shape === 'circle' ? <circle cx="5" cy="5" r="4.5" fill={color} /> : shape === 'square' ? <rect width="10" height="10" fill={color} /> : <path d="M5,0 L10,10 L0,10 Z" fill={color} />}
      </svg>
      {label}
    </span>
  );
}

/** The latest log per analyzer and kind whose next date is overdue or within two weeks. */
function MaintenanceDue() {
  const { t } = useTranslation('instruments');
  const f = useFormat();
  const params = { limit: 200 };
  const q = useQuery({ queryKey: keys.maintenance(params), queryFn: () => ins.maintenance(params) });
  const due = useMemo(() => {
    const latest = new Map<string, MaintenanceItem>();
    for (const m of q.data?.items ?? []) {
      const key = `${m.instrument.id}:${m.kind}`;
      const prev = latest.get(key);
      if (!prev || prev.performedAt < m.performedAt) latest.set(key, m);
    }
    const soon = Date.now() + 14 * 86_400_000;
    return [...latest.values()].filter((m) => m.nextDueAt && new Date(m.nextDueAt).getTime() <= soon).sort((a, b) => (a.nextDueAt! < b.nextDueAt! ? -1 : 1));
  }, [q.data]);
  const columns: ColumnDef<MaintenanceItem>[] = [
    {
      id: 'instrument',
      header: t('maintenance.instrument'),
      cell: ({ row }) => (
        <Link to={`/instruments/${row.original.instrument.id}?tab=maintenance`} className="hover:underline">
          <Code className="font-semibold">{row.original.instrument.code}</Code> <span className="text-[12.5px] text-muted">{row.original.instrument.name}</span>
        </Link>
      ),
    },
    { id: 'kind', header: t('maintenance.col.kind'), cell: ({ row }) => t(`maintenance.kinds.${row.original.kind}`) },
    {
      id: 'next',
      header: t('maintenance.col.nextDue'),
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="tabular">{f.date(row.original.nextDueAt)}</span>
          {row.original.overdue ? <Badge tone="crit">{t('maintenance.overdue')}</Badge> : <Badge tone="warn">{t('maintenance.dueSoon')}</Badge>}
        </span>
      ),
    },
    {
      id: 'last',
      header: t('maintenance.lastDone'),
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-2">
          <span className="tabular">{f.date(row.original.performedAt)}</span>
          <MaintenanceOutcome outcome={row.original.outcome} />
        </span>
      ),
    },
  ];
  return (
    <Card className="mt-4" title={t('maintenance.dueTitle')} description={t('maintenance.dueHint')} padded={false}>
      <DataTable
        dense
        className="rounded-none border-0"
        columns={columns}
        data={due}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={{ icon: CalendarClock, title: t('maintenance.noneDue') }}
      />
    </Card>
  );
}

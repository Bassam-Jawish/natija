import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Beaker, Plus } from 'lucide-react';
import { CATALOG_ANALYTE_TYPES, type CatalogAnalyte } from '@natija/contracts';
import { normalizeText } from '@natija/domain';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, DataTable, SearchInput, Select, Switch, type ColumnDef } from '@/components/ui';
import { ActiveBadge, Code, FilterBar } from '../common';
import { AnalyteEditor } from './AnalyteEditor';
import { AnalyteTypeBadge, useAnalytes } from './shared';

/** Analytes (the measured components) with their reference-range coverage. */
export function AnalytesTab() {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const manage = can('catalog.manage');
  const bi = useBi();
  const f = useFormat();
  const analytes = useAnalytes();
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);

  const rows = useMemo(() => {
    const raw = q.trim().toLowerCase();
    const term = normalizeText(q);
    return (analytes.data ?? []).filter((a) => {
      if (!showInactive && !a.isActive) return false;
      if (type !== 'all' && a.resultType !== type) return false;
      if (!raw) return true;
      return a.code.toLowerCase().startsWith(raw) || a.nameEn.toLowerCase().includes(raw) || normalizeText(a.nameAr).includes(term) || (a.loinc ?? '').startsWith(raw);
    });
  }, [analytes.data, q, type, showInactive]);

  const columns = useMemo<ColumnDef<CatalogAnalyte>[]>(
    () => [
      { accessorKey: 'code', header: t('catalog.analytes.cols.code'), cell: ({ row }) => <Code className="font-medium text-ink">{row.original.code}</Code>, size: 110 },
      { id: 'name', accessorFn: (r) => bi(r, 'name'), header: t('catalog.analytes.cols.name'), cell: ({ getValue }) => <span className="truncate">{getValue<string>()}</span> },
      { accessorKey: 'resultType', header: t('catalog.analytes.cols.type'), cell: ({ row }) => <AnalyteTypeBadge type={row.original.resultType} />, size: 110 },
      { accessorKey: 'unit', header: t('catalog.analytes.cols.unit'), cell: ({ row }) => <span className="text-ink-2 ltr-num">{row.original.unit || '—'}</span>, size: 110 },
      {
        accessorKey: 'decimals',
        header: t('catalog.analytes.cols.decimals'),
        cell: ({ row }) => <span className="tabular ltr-num text-ink-2">{row.original.resultType === 'numeric' || row.original.resultType === 'calculated' ? f.number(row.original.decimals) : '—'}</span>,
        meta: { align: 'end' },
        size: 80,
      },
      {
        accessorKey: 'rangeCount',
        header: t('catalog.analytes.cols.ranges'),
        cell: ({ row }) => {
          const a = row.original;
          const numeric = a.resultType === 'numeric' || a.resultType === 'calculated';
          if (!a.rangeCount && numeric) return <Badge tone="warn">{t('catalog.analytes.noRange')}</Badge>;
          return <span className="tabular ltr-num text-ink-2">{f.number(a.rangeCount)}</span>;
        },
        meta: { align: 'end' },
        size: 100,
      },
      {
        id: 'tests',
        accessorFn: (r) => r.testCodes.join(' '),
        header: t('catalog.analytes.cols.tests'),
        cell: ({ row }) =>
          row.original.testCodes.length ? (
            <span className="block max-w-56 truncate font-mono text-[12px] text-muted ltr-num" title={row.original.testCodes.join(', ')}>
              {row.original.testCodes.join(', ')}
            </span>
          ) : (
            <span className="text-[12.5px] text-faint">{t('catalog.analytes.notUsed')}</span>
          ),
      },
      { id: 'status', accessorFn: (r) => (r.isActive ? 1 : 0), header: t('catalog.analytes.cols.status'), cell: ({ row }) => <ActiveBadge active={row.original.isActive} />, size: 90 },
    ],
    [t, bi, f],
  );

  return (
    <div>
      <FilterBar
        end={
          manage ? (
            <Button variant="primary" size="sm" onClick={() => setEditing({ id: null })}>
              <Plus />
              {t('catalog.actions.newAnalyte')}
            </Button>
          ) : null
        }
      >
        <SearchInput value={q} onChange={setQ} placeholder={t('catalog.analytes.search')} className="h-8 w-72" />
        <Select
          size="sm"
          className="w-44"
          value={type}
          onValueChange={setType}
          options={[{ value: 'all', label: t('catalog.analytes.allTypes') }, ...CATALOG_ANALYTE_TYPES.map((x) => ({ value: x, label: t(`catalog.analytes.types.${x}`) }))]}
        />
        <Switch checked={showInactive} onCheckedChange={setShowInactive} label={t('common.showInactive')} />
        <span className="text-[12.5px] text-muted tabular">{t('catalog.analytes.count', { count: rows.length })}</span>
      </FilterBar>
      <DataTable
        columns={columns}
        data={rows}
        loading={analytes.isLoading}
        error={analytes.error}
        onRetry={() => void analytes.refetch()}
        onRowClick={(r) => setEditing({ id: r.id })}
        rowClassName={(r) => (!r.isActive ? 'opacity-60' : undefined)}
        dense
        maxHeight="calc(100vh - 290px)"
        empty={{ icon: Beaker, title: q || type !== 'all' ? t('catalog.analytes.noMatches') : t('catalog.analytes.empty') }}
      />
      {editing ? <AnalyteEditor analyteId={editing.id} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

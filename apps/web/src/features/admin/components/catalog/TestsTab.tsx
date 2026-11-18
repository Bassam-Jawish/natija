import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlaskConical, Plus, Star } from 'lucide-react';
import type { CatalogTest } from '@natija/contracts';
import { normalizeText } from '@natija/domain';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Button, DataTable, Money, SearchInput, Select, Switch, TubeIcon, type ColumnDef } from '@/components/ui';
import { useCatalogTests, useLookups } from '../../api';
import { ActiveBadge, Code, FilterBar } from '../common';
import { TestEditor } from './TestEditor';

/** Every test in the catalog, filtered in the browser (the catalog is small). */
export function TestsTab() {
  const { t } = useTranslation('admin');
  const { can } = useAuth();
  const manage = can('catalog.manage');
  const bi = useBi();
  const f = useFormat();
  const tests = useCatalogTests({ active: 'all' });
  const lookups = useLookups();
  const [q, setQ] = useState('');
  const [departmentId, setDepartmentId] = useState('all');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);

  const departments = useMemo(() => new Map((lookups.data?.departments ?? []).map((d) => [d.id, d])), [lookups.data]);
  const containers = useMemo(() => new Map((lookups.data?.containers ?? []).map((c) => [c.id, c])), [lookups.data]);

  const rows = useMemo(() => {
    const term = normalizeText(q);
    const raw = q.trim().toLowerCase();
    return (tests.data ?? []).filter((x) => {
      if (!showInactive && !x.isActive) return false;
      if (departmentId !== 'all' && x.departmentId !== departmentId) return false;
      if (!raw) return true;
      return (
        x.code.toLowerCase().startsWith(raw) ||
        x.nameEn.toLowerCase().includes(raw) ||
        normalizeText(x.nameAr).includes(term) ||
        (x.method ?? '').toLowerCase().includes(raw)
      );
    });
  }, [tests.data, q, departmentId, showInactive]);

  const columns = useMemo<ColumnDef<CatalogTest>[]>(
    () => [
      {
        accessorKey: 'code',
        header: t('catalog.tests.cols.code'),
        cell: ({ row }) => <Code className="font-medium text-ink">{row.original.code}</Code>,
        size: 110,
      },
      {
        id: 'name',
        accessorFn: (r) => bi(r, 'name'),
        header: t('catalog.tests.cols.name'),
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            {row.original.isFavorite ? <Star className="size-3.5 shrink-0 fill-current text-warn" aria-label={t('catalog.tests.favourite')} /> : null}
            <span className="truncate">{bi(row.original, 'name')}</span>
            {row.original.isExternal ? <span className="shrink-0 rounded bg-sunken px-1.5 text-[11px] text-muted">{t('catalog.tests.externalShort')}</span> : null}
          </span>
        ),
      },
      {
        id: 'department',
        accessorFn: (r) => bi(departments.get(r.departmentId), 'name'),
        header: t('catalog.tests.cols.department'),
        cell: ({ getValue }) => <span className="text-ink-2">{getValue<string>()}</span>,
      },
      {
        id: 'tube',
        accessorFn: (r) => containers.get(r.containerId)?.code ?? '',
        header: t('catalog.tests.cols.tube'),
        cell: ({ row }) => {
          const c = containers.get(row.original.containerId);
          return (
            <span className="inline-flex items-center gap-1.5">
              <TubeIcon cap={row.original.capColor} className="h-5 w-3" title={c ? bi(c, 'name') : row.original.capColor} />
              <Code>{c?.code ?? ''}</Code>
            </span>
          );
        },
        size: 110,
      },
      {
        accessorKey: 'units',
        header: t('catalog.tests.cols.units'),
        cell: ({ row }) => <span className="tabular ltr-num">{f.number(row.original.units)}</span>,
        meta: { align: 'end' },
        size: 80,
      },
      {
        accessorKey: 'fixedPrice',
        header: t('catalog.tests.cols.fixedPrice'),
        cell: ({ row }) => (row.original.fixedPrice === null ? <span className="text-faint">—</span> : <Money value={row.original.fixedPrice} />),
        meta: { align: 'end' },
        size: 120,
      },
      {
        accessorKey: 'tatHours',
        header: t('catalog.tests.cols.tat'),
        cell: ({ row }) => <span className="tabular ltr-num text-ink-2">{t('catalog.tests.hours', { n: f.number(row.original.tatHours) })}</span>,
        meta: { align: 'end' },
        size: 80,
      },
      {
        accessorKey: 'analyteCount',
        header: t('catalog.tests.cols.analytes'),
        cell: ({ row }) => <span className="tabular ltr-num text-ink-2">{f.number(row.original.analyteCount)}</span>,
        meta: { align: 'end' },
        size: 80,
      },
      {
        id: 'status',
        accessorFn: (r) => (r.isActive ? 1 : 0),
        header: t('catalog.tests.cols.status'),
        cell: ({ row }) => <ActiveBadge active={row.original.isActive} />,
        size: 90,
      },
    ],
    [t, bi, f, departments, containers],
  );

  return (
    <div>
      <FilterBar
        end={
          manage ? (
            <Button variant="primary" size="sm" onClick={() => setEditing({ id: null })}>
              <Plus />
              {t('catalog.actions.newTest')}
            </Button>
          ) : null
        }
      >
        <SearchInput value={q} onChange={setQ} placeholder={t('catalog.tests.search')} className="h-8 w-72" />
        <Select
          size="sm"
          className="w-52"
          value={departmentId}
          onValueChange={setDepartmentId}
          options={[{ value: 'all', label: t('catalog.tests.allDepartments') }, ...(lookups.data?.departments ?? []).map((d) => ({ value: d.id, label: bi(d, 'name') }))]}
        />
        <Switch checked={showInactive} onCheckedChange={setShowInactive} label={t('common.showInactive')} />
        <span className="text-[12.5px] text-muted tabular">{t('catalog.tests.count', { count: rows.length })}</span>
      </FilterBar>
      <DataTable
        columns={columns}
        data={rows}
        loading={tests.isLoading}
        error={tests.error}
        onRetry={() => void tests.refetch()}
        onRowClick={(r) => setEditing({ id: r.id })}
        rowClassName={(r) => (!r.isActive ? 'opacity-60' : undefined)}
        dense
        maxHeight="calc(100vh - 290px)"
        empty={{
          icon: FlaskConical,
          title: q || departmentId !== 'all' ? t('catalog.tests.noMatches') : t('catalog.tests.empty'),
          description: q || departmentId !== 'all' ? undefined : t('catalog.tests.emptyHint'),
        }}
      />
      {editing ? <TestEditor testId={editing.id} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

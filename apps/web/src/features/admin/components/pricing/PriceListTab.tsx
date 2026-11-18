import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PricingPriceList } from '@natija/contracts';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, DataTable, Money, SearchInput, Select, type ColumnDef } from '@/components/ui';
import { adminKeys, useLookups, usePayerGroups } from '../../api';
import { Code, ExportButton } from '../common';

type Row = PricingPriceList['rows'][number];

/** Every active test priced for every payer group: units × unit price, a fixed price, or a payer override. */
export function PriceListTab() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const lookups = useLookups();
  const payers = usePayerGroups();
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('all');
  const [payer, setPayer] = useState('all');
  const dq = useDebounced(q.trim(), 300);
  const query = { q: dq || undefined, departmentId: dept === 'all' ? undefined : dept, payerGroupId: payer === 'all' ? undefined : payer };
  const list = useQuery({
    queryKey: adminKeys.priceList(query),
    queryFn: () => api.get<PricingPriceList>('/pricing/price-list', query),
    placeholderData: keepPreviousData,
  });
  const deptName = new Map((lookups.data?.departments ?? []).map((d) => [d.id, bi(d, 'name')]));

  const columns: ColumnDef<Row>[] = [
    {
      id: 'test',
      accessorFn: (r) => r.code,
      header: t('pricing.list.test'),
      cell: ({ row }) => (
        <div className="min-w-48">
          <Code className="me-2">{row.original.code}</Code>
          <span className="font-medium">{bi(row.original, 'name')}</span>
        </div>
      ),
    },
    { id: 'dept', accessorFn: (r) => deptName.get(r.departmentId) ?? '', header: t('fields.departmentId'), cell: ({ row }) => <span className="text-[12.5px] text-ink-2">{deptName.get(row.original.departmentId) ?? '—'}</span> },
    {
      accessorKey: 'units',
      header: t('fields.units'),
      meta: { align: 'end' },
      cell: ({ row }) => <span className="tabular ltr-num text-ink-2">{row.original.fixedPrice !== null ? '—' : f.number(row.original.units)}</span>,
    },
    ...(list.data?.payers ?? []).map<ColumnDef<Row>>((p) => ({
      id: p.id,
      accessorFn: (r) => r.prices[p.id]?.price ?? 0,
      meta: { align: 'end', headerClassName: 'min-w-36' },
      header: () => (
        <span className="inline-flex flex-col items-end gap-0.5 normal-case tracking-normal">
          <span className="text-ink-2">{bi(p, 'name')}</span>
          <span className="font-normal text-faint ltr-num">
            {f.money(p.unitPrice)} / {t('common.perUnit')}
          </span>
        </span>
      ),
      cell: ({ row }) => {
        const c = row.original.prices[p.id];
        if (!c) return '—';
        const split = p.patientSharePct < 100 || p.discountPct > 0;
        return (
          <div className="flex flex-col items-end leading-tight">
            <span className="inline-flex items-center gap-1">
              {c.source === 'override' ? (
                <Badge tone="violet" className="h-[18px] px-1.5 text-[10.5px]">
                  {t('pricing.list.override')}
                </Badge>
              ) : c.source === 'fixed' ? (
                <Badge tone="muted" className="h-[18px] px-1.5 text-[10.5px]">
                  {t('pricing.list.fixed')}
                </Badge>
              ) : null}
              <Money value={c.price} className={cn(c.source === 'override' && 'font-semibold')} />
            </span>
            {split ? <span className="text-[11.5px] text-muted">{t('pricing.list.patientPays', { amount: f.money(c.patientShare) })}</span> : null}
          </div>
        );
      },
    })),
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder={t('pricing.list.search')} className="w-64" />
        <Select
          size="sm"
          className="w-48"
          value={dept}
          onValueChange={setDept}
          options={[{ value: 'all', label: t('pricing.list.allDepartments') }, ...(lookups.data?.departments ?? []).map((d) => ({ value: d.id, label: bi(d, 'name') }))]}
        />
        <Select
          size="sm"
          className="w-56"
          value={payer}
          onValueChange={setPayer}
          options={[{ value: 'all', label: t('pricing.list.allPayers') }, ...(payers.data ?? []).filter((p) => p.isActive).map((p) => ({ value: p.id, label: bi(p, 'name') }))]}
        />
        <div className="ms-auto">
          <ExportButton path="/pricing/price-list/export" query={{ q: query.q, departmentId: query.departmentId, payerGroupId: query.payerGroupId }} />
        </div>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Badge tone="violet" className="h-[18px] px-1.5 text-[10.5px]">
            {t('pricing.list.override')}
          </Badge>
          {t('pricing.list.overrideHint')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Badge tone="muted" className="h-[18px] px-1.5 text-[10.5px]">
            {t('pricing.list.fixed')}
          </Badge>
          {t('pricing.list.fixedHint')}
        </span>
        <span>{t('pricing.list.unitsHint')}</span>
      </div>
      <div className={cn('transition-opacity', list.isFetching && list.data && 'opacity-60')}>
        <DataTable
          dense
          columns={columns}
          data={list.data?.rows}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          getRowId={(r) => r.testId}
          maxHeight="66vh"
          empty={{ title: dq ? t('common:empty.noMatches') : t('pricing.list.empty') }}
        />
      </div>
    </div>
  );
}

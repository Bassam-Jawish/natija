import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calculator, Plus } from 'lucide-react';
import type { PricingPayerGroup } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, DataTable, Money, Switch, type ColumnDef, type Tone } from '@/components/ui';
import { usePayerGroups } from '../../api';
import { ActiveBadge, Code } from '../common';
import { BulkPriceDialog } from './BulkPriceDialog';
import { PayerDrawer } from './PayerDrawer';

export const KIND_TONE: Record<string, Tone> = { public: 'neutral', insurer: 'info', client_lab: 'violet', other: 'muted' };

export function PayersTab() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const payers = usePayerGroups();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<PricingPayerGroup | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);
  const rows = useMemo(() => (payers.data ?? []).filter((p) => showInactive || p.isActive), [payers.data, showInactive]);
  const inactive = (payers.data ?? []).filter((p) => !p.isActive).length;

  const columns: ColumnDef<PricingPayerGroup>[] = [
    { accessorKey: 'code', header: t('fields.code'), cell: ({ row }) => <Code>{row.original.code}</Code>, size: 110 },
    {
      id: 'name',
      accessorFn: (p) => bi(p, 'name'),
      header: t('common.name'),
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium">{bi(row.original, 'name')}</div>
          {row.original.organization ? <div className="truncate text-[12px] text-muted">{row.original.organization}</div> : null}
        </div>
      ),
    },
    { accessorKey: 'kind', header: t('pricing.payers.kind'), cell: ({ row }) => <Badge tone={KIND_TONE[row.original.kind]}>{t(`kinds.${row.original.kind}`)}</Badge> },
    { accessorKey: 'unitPrice', header: t('fields.unitPrice'), meta: { align: 'end' }, cell: ({ row }) => <Money value={row.original.unitPrice} className="font-medium" /> },
    {
      accessorKey: 'patientSharePct',
      header: t('fields.patientSharePct'),
      meta: { align: 'end' },
      cell: ({ row }) => <span className="tabular ltr-num">{f.percent(row.original.patientSharePct, 1)}</span>,
    },
    {
      accessorKey: 'discountPct',
      header: t('fields.discountPct'),
      meta: { align: 'end' },
      cell: ({ row }) => <span className="tabular ltr-num text-ink-2">{row.original.discountPct ? f.percent(row.original.discountPct, 1) : '—'}</span>,
    },
    {
      accessorKey: 'onAccount',
      header: t('pricing.payers.onAccountShort'),
      cell: ({ row }) => (row.original.onAccount ? <Badge tone="info">{t('pricing.payers.onAccountShort')}</Badge> : <span className="text-faint">—</span>),
    },
    { accessorKey: 'overrideCount', header: t('pricing.payers.overrides'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num text-ink-2">{row.original.overrideCount || '—'}</span> },
    { accessorKey: 'orderCount', header: t('pricing.payers.orders'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{f.number(row.original.orderCount)}</span> },
    { id: 'active', accessorFn: (p) => (p.isActive ? 0 : 1), header: t('common.status'), cell: ({ row }) => <ActiveBadge active={row.original.isActive} /> },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="max-w-2xl text-[13px] text-muted">{t('pricing.payers.intro')}</p>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {inactive ? <Switch checked={showInactive} onCheckedChange={setShowInactive} label={t('common.showInactive')} /> : null}
          <Button variant="secondary" size="sm" disabled={!payers.data?.length} onClick={() => setBulk(true)}>
            <Calculator />
            {t('pricing.bulk.open')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <Plus />
            {t('pricing.payers.new')}
          </Button>
        </div>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        loading={payers.isLoading}
        error={payers.error}
        onRetry={() => void payers.refetch()}
        onRowClick={(p) => setEditing(p)}
        getRowId={(p) => p.id}
        rowClassName={(p) => (!p.isActive ? 'opacity-60' : undefined)}
        empty={{ title: t('pricing.payers.empty') }}
      />
      {editing ? <PayerDrawer key={editing === 'new' ? 'new' : editing.id} payer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {bulk && payers.data ? <BulkPriceDialog payers={payers.data} onClose={() => setBulk(false)} /> : null}
    </div>
  );
}

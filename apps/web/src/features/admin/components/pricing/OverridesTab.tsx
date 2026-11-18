import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import type { PricingOverride, PricingPayerGroup } from '@natija/contracts';
import { roundMoney } from '@natija/domain';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Combobox, ConfirmDialog, DataTable, Dialog, EmptyState, Field, Money, Select, toast, type ColumnDef } from '@/components/ui';
import { adminKeys, useCatalogTests, usePayerGroups } from '../../api';
import { Code, Metric, NumberField, numText, toNumber, useAdminError } from '../common';
import { settle } from '../common';
import { KIND_TONE } from './PayersTab';

function OverrideDialog({ payer, existing, taken, onClose }: { payer: PricingPayerGroup; existing: PricingOverride | null; taken: Set<string>; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const tests = useCatalogTests({ active: 'true' });
  const [testId, setTestId] = useState<string | null>(existing?.testId ?? null);
  const [price, setPrice] = useState(numText(existing?.price));
  const test = tests.data?.find((x) => x.id === testId);
  const computed = test ? (test.fixedPrice ?? roundMoney(test.units * payer.unitPrice, f.currency)) : (existing?.computedPrice ?? null);
  const value = toNumber(price);
  const save = useMutation({
    mutationFn: () => api.put('/pricing/overrides', { payerGroupId: payer.id, testId, price: value }),
    onSuccess: async () => {
      toast.success(t('common.saved'));
      await qc.invalidateQueries({ queryKey: ['admin', 'pricing'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const valid = !!testId && value !== null && value >= 0;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={existing ? t('pricing.overrides.edit') : t('pricing.overrides.new')}
      description={bi(payer, 'name')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <Field label={t('pricing.list.test')} required>
          {(id) => (
            <Combobox
              id={id}
              value={testId}
              onChange={setTestId}
              disabled={!!existing}
              loading={tests.isLoading}
              placeholder={t('pricing.overrides.pickTest')}
              options={(tests.data ?? []).map((x) => ({
                value: x.id,
                label: `${x.code} · ${bi(x, 'name')}`,
                hint: taken.has(x.id) && x.id !== existing?.testId ? t('pricing.overrides.hasOne') : undefined,
              }))}
            />
          )}
        </Field>
        <NumberField label={t('pricing.overrides.price')} required value={price} onChange={setPrice} suffix={f.currencyLabel()} />
        {computed !== null ? (
          <div className="rounded-lg border border-line bg-sunken/50 px-3 py-1.5">
            <Metric label={t('pricing.overrides.computed')} value={f.money(computed)} />
            {value !== null && computed ? <Metric label={t('pricing.overrides.difference')} value={`${value >= computed ? '+' : ''}${f.number(((value - computed) / computed) * 100, 1)}%`} /> : null}
          </div>
        ) : null}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

/** Special prices for one payer group: what a test costs that payer instead of units × unit price. */
export function OverridesTab() {
  const { t } = useTranslation('admin');
  const f = useFormat();
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const payers = usePayerGroups();
  const [chosen, setChosen] = useState('');
  const payerId = chosen || payers.data?.find((p) => p.isActive && p.kind !== 'public')?.id || payers.data?.[0]?.id || '';
  const payer = payers.data?.find((p) => p.id === payerId) ?? null;
  const list = useQuery({
    queryKey: adminKeys.overrides(payerId),
    queryFn: () => api.get<PricingOverride[]>('/pricing/overrides', { payerGroupId: payerId }),
    enabled: !!payerId,
  });
  const [editing, setEditing] = useState<PricingOverride | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PricingOverride | null>(null);
  const taken = useMemo(() => new Set((list.data ?? []).map((o) => o.testId)), [list.data]);
  const remove = useMutation({
    mutationFn: (o: PricingOverride) => api.del(`/pricing/overrides/${o.id}`),
    onSuccess: async () => {
      toast.success(t('common.deleted'));
      await qc.invalidateQueries({ queryKey: ['admin', 'pricing'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const columns: ColumnDef<PricingOverride>[] = [
    {
      id: 'test',
      accessorFn: (o) => o.testCode,
      header: t('pricing.list.test'),
      cell: ({ row }) => (
        <span>
          <Code className="me-2">{row.original.testCode}</Code>
          <span className="font-medium">{bi({ nameAr: row.original.testNameAr, nameEn: row.original.testNameEn }, 'name')}</span>
        </span>
      ),
    },
    { accessorKey: 'computedPrice', header: t('pricing.overrides.computed'), meta: { align: 'end' }, cell: ({ row }) => <Money value={row.original.computedPrice} className="text-muted" /> },
    { accessorKey: 'price', header: t('pricing.overrides.price'), meta: { align: 'end' }, cell: ({ row }) => <Money value={row.original.price} className="font-semibold" /> },
    {
      id: 'diff',
      accessorFn: (o) => (o.computedPrice ? (o.price - o.computedPrice) / o.computedPrice : 0),
      header: t('pricing.overrides.difference'),
      meta: { align: 'end' },
      cell: ({ row }) => {
        const o = row.original;
        if (!o.computedPrice) return '—';
        const pct = ((o.price - o.computedPrice) / o.computedPrice) * 100;
        return (
          <span className="tabular ltr-num text-ink-2">
            {pct > 0 ? '+' : ''}
            {f.number(pct, 1)}%
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      meta: { align: 'end' },
      cell: ({ row }) => (
        <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.edit')} onClick={() => setEditing(row.original)}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.delete')} className="text-crit" onClick={() => setDeleting(row.original)}>
            <Trash2 />
          </Button>
        </span>
      ),
    },
  ];

  if (payers.data && !payers.data.length) return <EmptyState icon={Tags} title={t('pricing.payers.empty')} />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          className="w-64"
          value={payerId}
          onValueChange={setChosen}
          placeholder={t('fields.payerGroupId')}
          options={(payers.data ?? []).map((p) => ({ value: p.id, label: bi(p, 'name'), hint: t(`kinds.${p.kind}`) }))}
        />
        {payer ? (
          <span className="inline-flex items-center gap-2 text-[12.5px] text-muted">
            <Badge tone={KIND_TONE[payer.kind]}>{t(`kinds.${payer.kind}`)}</Badge>
            {t('pricing.overrides.unitPrice', { price: f.money(payer.unitPrice) })}
          </span>
        ) : null}
        <Button variant="primary" size="sm" className="ms-auto" disabled={!payer} onClick={() => setEditing('new')}>
          <Plus />
          {t('pricing.overrides.new')}
        </Button>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">{t('pricing.overrides.intro')}</p>
      <DataTable
        columns={columns}
        data={list.data}
        loading={list.isLoading || payers.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(o) => setEditing(o)}
        getRowId={(o) => o.id}
        empty={{ icon: Tags, title: t('pricing.overrides.empty'), description: t('pricing.overrides.emptyHint') }}
      />
      {editing && payer ? (
        <OverrideDialog key={editing === 'new' ? 'new' : editing.id} payer={payer} existing={editing === 'new' ? null : editing} taken={taken} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={t('pricing.overrides.deleteTitle', { code: deleting?.testCode ?? '' })}
        description={t('pricing.overrides.deleteBody')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => (deleting ? settle(remove.mutateAsync(deleting)) : undefined)}
      />
    </div>
  );
}

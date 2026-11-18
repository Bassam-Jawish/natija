import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Banknote, CreditCard, Pencil, Plus, Trash2 } from 'lucide-react';
import type { SettingsPaymentMethod } from '@natija/contracts';
import { api } from '@/lib/api';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Card, ConfirmDialog, DataTable, Dialog, Field, Input, Switch, toast, type ColumnDef } from '@/components/ui';
import { adminKeys, usePaymentMethods } from '../../api';
import { ActiveBadge, BilingualFields, Code, NumberField, numText, toNumber, useAdminError, useFieldErrors } from '../common';
import { settle } from '../common';

function MethodDialog({ method, onClose }: { method: SettingsPaymentMethod | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [code, setCode] = useState(method?.code ?? '');
  const [nameAr, setNameAr] = useState(method?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(method?.nameEn ?? '');
  const [isCash, setIsCash] = useState(method?.isCash ?? false);
  const [isActive, setIsActive] = useState(method?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(numText(method?.sortOrder ?? 0));
  const save = useMutation({
    mutationFn: () => {
      const body = { code: code.trim().toUpperCase(), nameAr, nameEn, isCash, isActive, sortOrder: toNumber(sortOrder) ?? 0 };
      return method ? api.put(`/settings/payment-methods/${method.id}`, body) : api.post('/settings/payment-methods', body);
    },
    onSuccess: async () => {
      toast.success(method ? t('common.saved') : t('common.created'));
      await qc.invalidateQueries({ queryKey: adminKeys.methods });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const errors = useFieldErrors(save.error);
  const valid = code.trim() && nameAr.trim() && nameEn.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={method ? t('settings.methods.edit') : t('settings.methods.new')}
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
        <Field label={t('fields.code')} required error={errors.code} hint={t('settings.methods.codeHint')}>
          {(id) => <Input id={id} ltr className="w-40 font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} autoFocus={!method} invalid={!!errors.code} />}
        </Field>
        <BilingualFields ar={nameAr} en={nameEn} onAr={setNameAr} onEn={setNameEn} errorAr={errors.nameAr} errorEn={errors.nameEn} />
        <div className="flex flex-wrap items-center gap-6 pt-1">
          <Switch checked={isCash} onCheckedChange={setIsCash} label={t('settings.methods.isCash')} disabled={!!method && method.useCount > 0} />
          <Switch checked={isActive} onCheckedChange={setIsActive} label={t('common.active')} />
        </div>
        <p className="text-[12.5px] text-muted">{method && method.useCount > 0 ? t('settings.methods.cashLocked') : t('settings.methods.cashHint')}</p>
        <NumberField className="w-32" label={t('settings.sortOrder')} value={sortOrder} onChange={setSortOrder} step="1" />
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

export function PaymentMethodsTab() {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const methods = usePaymentMethods();
  const [editing, setEditing] = useState<SettingsPaymentMethod | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SettingsPaymentMethod | null>(null);
  const remove = useMutation({
    mutationFn: (m: SettingsPaymentMethod) => api.del(`/settings/payment-methods/${m.id}`),
    onSuccess: async () => {
      toast.success(t('common.deleted'));
      await qc.invalidateQueries({ queryKey: adminKeys.methods });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const columns: ColumnDef<SettingsPaymentMethod>[] = [
    { accessorKey: 'code', header: t('fields.code'), cell: ({ row }) => <Code>{row.original.code}</Code>, size: 110 },
    { id: 'name', accessorFn: (m) => bi(m, 'name'), header: t('common.name'), cell: ({ row }) => <span className="font-medium">{bi(row.original, 'name')}</span> },
    {
      id: 'kind',
      accessorFn: (m) => (m.isCash ? 0 : 1),
      header: t('settings.methods.kind'),
      cell: ({ row }) =>
        row.original.isCash ? (
          <Badge tone="ok">
            <Banknote className="size-3.5" />
            {t('settings.methods.cash')}
          </Badge>
        ) : (
          <Badge tone="info">
            <CreditCard className="size-3.5" />
            {t('settings.methods.nonCash')}
          </Badge>
        ),
    },
    { id: 'active', accessorFn: (m) => (m.isActive ? 0 : 1), header: t('common.status'), cell: ({ row }) => <ActiveBadge active={row.original.isActive} /> },
    { accessorKey: 'useCount', header: t('settings.methods.payments'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{row.original.useCount}</span> },
    { accessorKey: 'sortOrder', header: t('settings.sortOrder'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num text-muted">{row.original.sortOrder}</span> },
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
          <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.delete')} onClick={() => setDeleting(row.original)} className="text-crit">
            <Trash2 />
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Card
      title={t('settings.methods.title')}
      description={t('settings.methods.description')}
      padded={false}
      actions={
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus />
          {t('settings.methods.new')}
        </Button>
      }
    >
      <DataTable
        className="rounded-none border-0"
        columns={columns}
        data={methods.data}
        loading={methods.isLoading}
        error={methods.error}
        onRetry={() => void methods.refetch()}
        onRowClick={(m) => setEditing(m)}
        getRowId={(m) => m.id}
        rowClassName={(m) => (!m.isActive ? 'opacity-60' : undefined)}
        empty={{ title: t('settings.methods.empty') }}
      />
      {editing ? <MethodDialog key={editing === 'new' ? 'new' : editing.id} method={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={t('common.deleteTitle', { name: deleting ? bi(deleting, 'name') : '' })}
        description={deleting && deleting.useCount > 0 ? t('settings.methods.deleteUsed') : t('common.deleteBody')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => (deleting ? settle(remove.mutateAsync(deleting)) : undefined)}
      />
    </Card>
  );
}

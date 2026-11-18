import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Star, Trash2 } from 'lucide-react';
import type { SettingsBranch } from '@natija/contracts';
import { api } from '@/lib/api';
import { useBi } from '@/lib/i18n';
import { Badge, Button, Card, ConfirmDialog, DataTable, Dialog, Field, Input, Switch, toast, Tooltip, type ColumnDef } from '@/components/ui';
import { adminKeys, useBranches } from '../../api';
import { BilingualFields, Code, useAdminError, useFieldErrors } from '../common';
import { settle } from '../common';

function BranchDialog({ branch, onClose }: { branch: SettingsBranch | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [code, setCode] = useState(branch?.code ?? '');
  const [nameAr, setNameAr] = useState(branch?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(branch?.nameEn ?? '');
  const [addressAr, setAddressAr] = useState(branch?.addressAr ?? '');
  const [addressEn, setAddressEn] = useState(branch?.addressEn ?? '');
  const [phone, setPhone] = useState(branch?.phone ?? '');
  const [isMain, setIsMain] = useState(branch?.isMain ?? false);
  const save = useMutation({
    mutationFn: () => {
      const body = { code: code.trim().toUpperCase(), nameAr, nameEn, addressAr, addressEn, phone, isMain };
      return branch ? api.put(`/settings/branches/${branch.id}`, body) : api.post('/settings/branches', body);
    },
    onSuccess: async () => {
      toast.success(branch ? t('common.saved') : t('common.created'));
      await qc.invalidateQueries({ queryKey: adminKeys.branches });
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
      title={branch ? t('settings.branches.edit') : t('settings.branches.new')}
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
        <Field label={t('fields.code')} required error={errors.code}>
          {(id) => <Input id={id} ltr className="w-40 font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} autoFocus={!branch} invalid={!!errors.code} />}
        </Field>
        <BilingualFields ar={nameAr} en={nameEn} onAr={setNameAr} onEn={setNameEn} errorAr={errors.nameAr} errorEn={errors.nameEn} />
        <BilingualFields
          ar={addressAr}
          en={addressEn}
          onAr={setAddressAr}
          onEn={setAddressEn}
          labelAr={t('settings.profile.addressAr')}
          labelEn={t('settings.profile.addressEn')}
          required={false}
        />
        <Field label={t('settings.profile.phone')}>{(id) => <Input id={id} ltr className="sm:w-60" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Switch checked={isMain} onCheckedChange={setIsMain} label={t('settings.branches.isMain')} disabled={!!branch?.isMain} />
        <p className="text-[12.5px] text-muted">{branch?.isMain ? t('settings.branches.mainLocked') : t('settings.branches.mainHint')}</p>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

export function BranchesTab() {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const branches = useBranches();
  const [editing, setEditing] = useState<SettingsBranch | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SettingsBranch | null>(null);
  const remove = useMutation({
    mutationFn: (b: SettingsBranch) => api.del(`/settings/branches/${b.id}`),
    onSuccess: async () => {
      toast.success(t('common.deleted'));
      await qc.invalidateQueries({ queryKey: adminKeys.branches });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const columns: ColumnDef<SettingsBranch>[] = [
    { accessorKey: 'code', header: t('fields.code'), cell: ({ row }) => <Code>{row.original.code}</Code>, size: 110 },
    {
      id: 'name',
      accessorFn: (b) => bi(b, 'name'),
      header: t('common.name'),
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-2 font-medium">
          {bi(row.original, 'name')}
          {row.original.isMain ? (
            <Badge tone="accent">
              <Star className="size-3" />
              {t('settings.branches.main')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    { id: 'address', accessorFn: (b) => bi(b, 'address'), header: t('settings.branches.address'), cell: ({ row }) => <span className="text-ink-2">{bi(row.original, 'address') || '—'}</span> },
    { accessorKey: 'phone', header: t('settings.profile.phone'), cell: ({ row }) => <span className="ltr-num text-ink-2">{row.original.phone ?? '—'}</span> },
    { accessorKey: 'orderCount', header: t('settings.branches.orders'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{row.original.orderCount}</span> },
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
          <Tooltip content={row.original.isMain ? t('settings.branches.mainLocked') : null}>
            <span>
              <Button variant="ghost" size="icon-sm" aria-label={t('common:actions.delete')} disabled={row.original.isMain} onClick={() => setDeleting(row.original)} className="text-crit">
                <Trash2 />
              </Button>
            </span>
          </Tooltip>
        </span>
      ),
    },
  ];

  return (
    <Card
      title={t('settings.branches.title')}
      description={t('settings.branches.description')}
      padded={false}
      actions={
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus />
          {t('settings.branches.new')}
        </Button>
      }
    >
      <DataTable
        className="rounded-none border-0"
        columns={columns}
        data={branches.data}
        loading={branches.isLoading}
        error={branches.error}
        onRetry={() => void branches.refetch()}
        onRowClick={(b) => setEditing(b)}
        getRowId={(b) => b.id}
        empty={{ title: t('settings.branches.empty') }}
      />
      {editing ? <BranchDialog key={editing === 'new' ? 'new' : editing.id} branch={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={t('common.deleteTitle', { name: deleting ? bi(deleting, 'name') : '' })}
        description={deleting && deleting.orderCount > 0 ? t('settings.branches.deleteUsed') : t('common.deleteBody')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => (deleting ? settle(remove.mutateAsync(deleting)) : undefined)}
      />
    </Card>
  );
}

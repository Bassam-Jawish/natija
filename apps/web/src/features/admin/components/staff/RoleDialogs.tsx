import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { StaffRole } from '@natija/contracts';
import { api } from '@/lib/api';
import { useBi } from '@/lib/i18n';
import { Button, Dialog, Field, Input, Select, toast } from '@/components/ui';
import { adminKeys } from '../../api';
import { BilingualFields, useAdminError, useFieldErrors } from '../common';

const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** New role: a key, names, and optionally the permissions of an existing role to start from. */
export function NewRoleDialog({ roles, onClose, onCreated }: { roles: StaffRole[]; onClose: () => void; onCreated: (r: StaffRole) => void }) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [key, setKey] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [copyFrom, setCopyFrom] = useState('none');
  const save = useMutation({
    mutationFn: () =>
      api.post<StaffRole>('/staff/roles', {
        key: key.trim().toLowerCase(),
        nameAr,
        nameEn,
        permissions: roles.find((r) => r.id === copyFrom)?.permissions ?? [],
      }),
    onSuccess: async (role) => {
      toast.success(t('common.created'));
      await qc.invalidateQueries({ queryKey: adminKeys.roles });
      onCreated(role);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const errors = useFieldErrors(save.error);
  const keyError = key && !KEY.test(key.trim().toLowerCase()) ? t('fieldErrors.invalid_key') : errors.key;
  const valid = KEY.test(key.trim().toLowerCase()) && nameAr.trim() && nameEn.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('staff.roles.new')}
      description={t('staff.roles.newHint')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            {t('common:actions.create')}
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
        <BilingualFields ar={nameAr} en={nameEn} onAr={setNameAr} onEn={setNameEn} errorAr={errors.nameAr} errorEn={errors.nameEn} autoFocus />
        <Field label={t('fields.key')} required hint={t('staff.roles.keyHint')} error={keyError}>
          {(id) => <Input id={id} ltr className="w-56 font-mono" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} invalid={!!keyError} />}
        </Field>
        <Field label={t('staff.roles.copyFrom')} hint={t('staff.roles.copyFromHint')}>
          {(id) => (
            <Select
              id={id}
              value={copyFrom}
              onValueChange={setCopyFrom}
              options={[
                { value: 'none', label: t('staff.roles.startEmpty') },
                ...roles.map((r) => ({ value: r.id, label: bi(r, 'name'), hint: t('staff.roles.permissionCount', { count: r.permissions.length }) })),
              ]}
            />
          )}
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

/** Rename a role (system roles too); its permissions are edited in the matrix. */
export function RenameRoleDialog({ role, onClose }: { role: StaffRole; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [nameAr, setNameAr] = useState(role.nameAr);
  const [nameEn, setNameEn] = useState(role.nameEn);
  const save = useMutation({
    mutationFn: () => api.put<StaffRole>(`/staff/roles/${role.id}`, { nameAr, nameEn, permissions: role.permissions }),
    onSuccess: async () => {
      toast.success(t('common.saved'));
      await Promise.all([qc.invalidateQueries({ queryKey: adminKeys.roles }), qc.invalidateQueries({ queryKey: adminKeys.users })]);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const valid = nameAr.trim() && nameEn.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={t('staff.roles.rename')}
      description={<span className="font-mono ltr-num">{role.key}</span>}
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
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <BilingualFields ar={nameAr} en={nameEn} onAr={setNameAr} onEn={setNameEn} autoFocus />
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}

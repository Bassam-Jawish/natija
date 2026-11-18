import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { DoctorRow } from '@natija/contracts';
import { api } from '@/lib/api';
import { useBi } from '@/lib/i18n';
import { Button, ConfirmDialog, Drawer, Field, Input, Switch, Textarea, toast } from '@/components/ui';
import { BilingualFields, useAdminError, useFieldErrors } from '../common';
import { settle } from '../common';

/** Add or edit a referring doctor. */
export function DoctorDrawer({ doctor, onClose }: { doctor: DoctorRow | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const bi = useBi();
  const qc = useQueryClient();
  const errorMessage = useAdminError();
  const [nameAr, setNameAr] = useState(doctor?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(doctor?.nameEn ?? '');
  const [specialtyAr, setSpecialtyAr] = useState(doctor?.specialtyAr ?? '');
  const [specialtyEn, setSpecialtyEn] = useState(doctor?.specialtyEn ?? '');
  const [clinic, setClinic] = useState(doctor?.clinic ?? '');
  const [phone, setPhone] = useState(doctor?.phone ?? '');
  const [notes, setNotes] = useState(doctor?.notes ?? '');
  const [isActive, setIsActive] = useState(doctor?.isActive ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin', 'doctors'] });
  const save = useMutation({
    mutationFn: () => {
      const body = { nameAr, nameEn, specialtyAr, specialtyEn, clinic, phone, notes, isActive };
      return doctor ? api.put<DoctorRow>(`/doctors/${doctor.id}`, body) : api.post<DoctorRow>('/doctors', body);
    },
    onSuccess: async () => {
      toast.success(doctor ? t('common.saved') : t('common.created'));
      await invalidate();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/doctors/${doctor!.id}`),
    onSuccess: async () => {
      toast.success(t('common.deleted'));
      await invalidate();
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const errors = useFieldErrors(save.error);
  const valid = nameAr.trim().length > 0;

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="md"
      title={doctor ? t('doctors.edit') : t('doctors.new')}
      description={doctor ? t('doctors.ordersSoFar', { count: doctor.orderCount }) : t('doctors.newHint')}
      footer={
        <>
          {doctor ? (
            <Button variant="ghost" className="me-auto text-crit" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
              {t('common:actions.delete')}
            </Button>
          ) : null}
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fields.nameAr')} required error={errors.nameAr}>
            {(id) => <Input id={id} dir="rtl" autoFocus value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder={t('doctors.namePlaceholder')} invalid={!!errors.nameAr} />}
          </Field>
          <Field label={t('fields.nameEn')} error={errors.nameEn}>
            {(id) => <Input id={id} dir="ltr" className="text-left" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
          </Field>
        </div>
        <BilingualFields
          ar={specialtyAr}
          en={specialtyEn}
          onAr={setSpecialtyAr}
          onEn={setSpecialtyEn}
          labelAr={t('doctors.specialtyAr')}
          labelEn={t('doctors.specialtyEn')}
          required={false}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('doctors.clinic')} hint={t('doctors.clinicHint')}>
            {(id) => <Input id={id} value={clinic} onChange={(e) => setClinic(e.target.value)} />}
          </Field>
          <Field label={t('settings.profile.phone')}>{(id) => <Input id={id} ltr value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        </div>
        <Field label={t('common.notes')}>{(id) => <Textarea id={id} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <Switch checked={isActive} onCheckedChange={setIsActive} label={t('common.active')} />
        <p className="-mt-1 text-[12.5px] text-muted">{t('doctors.activeHint')}</p>
        <button type="submit" className="hidden" />
      </form>
      {doctor ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          tone="danger"
          title={t('common.deleteTitle', { name: bi(doctor, 'name') })}
          description={doctor.orderCount > 0 ? t('doctors.deleteUsed') : t('common.deleteBody')}
          confirmLabel={t('common:actions.delete')}
          onConfirm={() => settle(remove.mutateAsync())}
        />
      ) : null}
    </Drawer>
  );
}

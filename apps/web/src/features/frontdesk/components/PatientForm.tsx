import { useMemo, useState, type Ref } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { UserCheck, Users } from 'lucide-react';
import type { AgeUnit, ContactPref, DuplicateCandidate, PatientCreateInput, PatientDetail, Sex } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Badge, Button, Field, Input, Segmented, Select, Textarea, toast } from '@/components/ui';
import { fd, keys, useRefresh } from '../api';
import { fieldErrors, Notice, PatientMeta, useFdError, usePatientName } from './shared';

type Values = {
  firstNameAr: string;
  fatherNameAr: string;
  motherNameAr: string;
  lastNameAr: string;
  firstNameEn: string;
  lastNameEn: string;
  sex: Sex | '';
  birthMode: 'date' | 'age';
  birthDate: string;
  ageValue: string;
  ageUnit: AgeUnit;
  phone: string;
  contactPref: ContactPref;
  nationalId: string;
  email: string;
  notes: string;
};

function initial(p?: PatientDetail | null, prefill?: Partial<Values>): Values {
  return {
    firstNameAr: p?.firstNameAr ?? '',
    fatherNameAr: p?.fatherNameAr ?? '',
    motherNameAr: p?.motherNameAr ?? '',
    lastNameAr: p?.lastNameAr ?? '',
    firstNameEn: p?.firstNameEn ?? '',
    lastNameEn: p?.lastNameEn ?? '',
    sex: p?.sex ?? '',
    birthMode: p ? 'date' : 'age',
    birthDate: p?.birthDate ?? '',
    ageValue: '',
    ageUnit: 'years',
    phone: p?.phone ?? '',
    contactPref: p?.contactPref ?? 'whatsapp',
    nationalId: p?.nationalId ?? '',
    email: p?.email ?? '',
    notes: p?.notes ?? '',
    ...prefill,
  };
}

/**
 * New patient (with a live duplicate check) or edit an existing record. Arabic names first;
 * the birth date can be exact or estimated from an age (years, months or days).
 */
export function PatientForm({
  patient,
  prefill,
  firstFieldRef,
  onSaved,
  onUseExisting,
  onCancel,
  compact,
}: {
  patient?: PatientDetail | null;
  prefill?: Partial<Values>;
  firstFieldRef?: Ref<HTMLInputElement>;
  onSaved: (p: PatientDetail) => void;
  onUseExisting?: (c: DuplicateCandidate) => void;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const errorText = useFdError();
  const name = usePatientName();
  const refresh = useRefresh();
  const editing = !!patient;
  const [v, setV] = useState<Values>(() => initial(patient, prefill));
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((s) => ({ ...s, [k]: value }));

  const missing = {
    firstNameAr: !v.firstNameAr.trim(),
    lastNameAr: !v.lastNameAr.trim(),
    sex: !v.sex,
    birth: v.birthMode === 'date' ? !v.birthDate : !v.ageValue || Number(v.ageValue) < 0 || !Number.isInteger(Number(v.ageValue)),
  };
  const invalid = missing.firstNameAr || missing.lastNameAr || missing.sex || (!editing && missing.birth) || (editing && v.birthMode === 'age' && missing.birth);

  const dupBody = useMemo(() => {
    if (editing || !v.firstNameAr.trim() || (!v.lastNameAr.trim() && v.phone.replace(/\D/g, '').length < 7)) return null;
    return {
      firstNameAr: v.firstNameAr.trim(),
      fatherNameAr: v.fatherNameAr.trim() || null,
      lastNameAr: v.lastNameAr.trim() || null,
      sex: v.sex || null,
      birthDate: v.birthMode === 'date' && v.birthDate ? v.birthDate : null,
      age: v.birthMode === 'age' && v.ageValue && Number.isInteger(Number(v.ageValue)) ? { value: Number(v.ageValue), unit: v.ageUnit } : null,
      phone: v.phone.trim() || null,
    };
  }, [editing, v]);
  const dupKey = useDebounced(dupBody ? JSON.stringify(dupBody) : null, 450);
  const dups = useQuery({
    queryKey: keys.duplicates(dupKey),
    queryFn: () => fd.duplicates(JSON.parse(dupKey!)),
    enabled: !!dupKey,
    staleTime: 30_000,
  });
  const candidates = dupKey ? (dups.data?.items ?? []) : [];

  const save = useMutation({
    mutationFn: async () => {
      const text = (s: string) => s.trim() || null;
      const body: PatientCreateInput = {
        firstNameAr: v.firstNameAr.trim(),
        fatherNameAr: text(v.fatherNameAr),
        motherNameAr: text(v.motherNameAr),
        lastNameAr: v.lastNameAr.trim(),
        firstNameEn: text(v.firstNameEn),
        lastNameEn: text(v.lastNameEn),
        sex: v.sex as Sex,
        phone: text(v.phone),
        contactPref: v.contactPref,
        nationalId: text(v.nationalId),
        email: text(v.email),
        notes: text(v.notes),
      };
      if (v.birthMode === 'age') body.age = { value: Number(v.ageValue), unit: v.ageUnit };
      else if (!editing || v.birthDate !== patient!.birthDate) body.birthDate = v.birthDate;
      return editing ? fd.updatePatient(patient!.id, body) : fd.createPatient(body);
    },
    onSuccess: (p) => {
      toast.success(editing ? t('patient.saved') : t('patient.created', { mrn: p.mrn }));
      void refresh.patients();
      onSaved(p);
    },
  });
  const raw = fieldErrors(save.error);
  // Server field messages are codes (birth_date_invalid…) or zod sentences: translate what we know.
  const errs = Object.fromEntries(Object.entries(raw).map(([k, m]) => [k, t(`errors.${m}`, { defaultValue: t('common:errors.validation') })])) as Record<string, string>;

  const submit = () => {
    setTouched(true);
    if (invalid || save.isPending) return;
    save.mutate();
  };

  const req = (bad: boolean) => (touched && bad ? t('common:common.required') : null);
  const grid = compact ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-4';

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={`grid gap-3 ${grid}`}>
        <Field label={t('patient.firstNameAr')} required error={req(missing.firstNameAr) ?? errs.firstNameAr}>
          {(id) => <Input id={id} ref={firstFieldRef} dir="auto" value={v.firstNameAr} onChange={(e) => set('firstNameAr', e.target.value)} invalid={touched && missing.firstNameAr} autoComplete="off" />}
        </Field>
        <Field label={t('patient.fatherNameAr')}>
          {(id) => <Input id={id} dir="auto" value={v.fatherNameAr} onChange={(e) => set('fatherNameAr', e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={t('patient.motherNameAr')}>
          {(id) => <Input id={id} dir="auto" value={v.motherNameAr} onChange={(e) => set('motherNameAr', e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={t('patient.lastNameAr')} required error={req(missing.lastNameAr) ?? errs.lastNameAr}>
          {(id) => <Input id={id} dir="auto" value={v.lastNameAr} onChange={(e) => set('lastNameAr', e.target.value)} invalid={touched && missing.lastNameAr} autoComplete="off" />}
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('patient.firstNameEn')} hint={t('common:common.optional')}>
          {(id) => <Input id={id} ltr value={v.firstNameEn} onChange={(e) => set('firstNameEn', e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={t('patient.lastNameEn')} hint={t('common:common.optional')}>
          {(id) => <Input id={id} ltr value={v.lastNameEn} onChange={(e) => set('lastNameEn', e.target.value)} autoComplete="off" />}
        </Field>
      </div>

      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <Field label={t('common:common.sex')} required error={req(missing.sex)}>
          <Segmented<Sex | ''>
            value={v.sex}
            onChange={(s) => set('sex', s)}
            options={[
              { value: 'female', label: t('common:common.female') },
              { value: 'male', label: t('common:common.male') },
            ]}
          />
        </Field>
        <Field label={t('patient.birth')} required={!editing} error={(touched && missing.birth && (!editing || v.birthMode === 'age') ? t('patient.birthRequired') : null) ?? errs.birthDate ?? errs.age}>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<'date' | 'age'>
              size="sm"
              value={v.birthMode}
              onChange={(m) => set('birthMode', m)}
              options={[
                { value: 'age', label: t('patient.byAge') },
                { value: 'date', label: t('patient.byDate') },
              ]}
            />
            {v.birthMode === 'date' ? (
              <Input type="date" className="w-[160px]" value={v.birthDate} max={f.today()} onChange={(e) => set('birthDate', e.target.value)} aria-label={t('patient.birthDate')} />
            ) : (
              <>
                <Input
                  ltr
                  inputMode="numeric"
                  className="w-20"
                  value={v.ageValue}
                  onChange={(e) => set('ageValue', e.target.value.replace(/[^\d٠-٩]/g, '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)))}
                  aria-label={t('patient.ageValue')}
                  placeholder={editing ? f.age(patient!.birthDate) : ''}
                />
                <Select
                  size="sm"
                  className="w-28"
                  value={v.ageUnit}
                  onValueChange={(u) => set('ageUnit', u as AgeUnit)}
                  options={[
                    { value: 'years', label: t('common:common.years') },
                    { value: 'months', label: t('common:common.months') },
                    { value: 'days', label: t('common:common.days') },
                  ]}
                />
              </>
            )}
            {editing && patient!.birthDateEstimated && v.birthMode === 'date' && v.birthDate === patient!.birthDate ? <Badge tone="warn">{t('patient.estimated')}</Badge> : null}
          </div>
        </Field>
      </div>

      <div className={`grid gap-3 ${grid}`}>
        <Field label={t('common:common.phone')} error={errs.phone}>
          {(id) => <Input id={id} ltr type="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} placeholder="09xx xxx xxx" autoComplete="off" />}
        </Field>
        <Field label={t('patient.contactPref')}>
          {(id) => (
            <Select
              id={id}
              value={v.contactPref}
              onValueChange={(c) => set('contactPref', c as ContactPref)}
              options={(['whatsapp', 'sms', 'call', 'none'] as const).map((c) => ({ value: c, label: t(`patient.contact.${c}`) }))}
            />
          )}
        </Field>
        <Field label={t('patient.nationalId')} hint={t('common:common.optional')}>
          {(id) => <Input id={id} ltr value={v.nationalId} onChange={(e) => set('nationalId', e.target.value)} autoComplete="off" />}
        </Field>
        <Field label={t('patient.email')} hint={t('common:common.optional')} error={errs.email ? t('patient.emailInvalid') : null}>
          {(id) => <Input id={id} ltr type="email" value={v.email} onChange={(e) => set('email', e.target.value)} autoComplete="off" />}
        </Field>
      </div>

      <Field label={t('patient.notes')} hint={t('patient.notesHint')}>
        {(id) => <Textarea id={id} rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} />}
      </Field>

      {candidates.length ? (
        <Notice tone="warn" icon={<Users />} title={t('patient.duplicates.title', { count: candidates.length })}>
          <p className="mb-2">{t('patient.duplicates.hint')}</p>
          <ul className="flex flex-col gap-1.5">
            {candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{name(c)}</p>
                  <PatientMeta p={c} />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {c.reasons.map((r) => (
                    <Badge key={r} tone="warn">
                      {t(`patient.duplicates.reason.${r}`)}
                    </Badge>
                  ))}
                  <Badge tone="neutral" className="tabular">
                    {f.percent(c.score)}
                  </Badge>
                </div>
                {onUseExisting ? (
                  <Button size="sm" variant="secondary" onClick={() => onUseExisting(c)}>
                    <UserCheck />
                    {t('patient.duplicates.use')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {save.error && !Object.keys(errs).length ? <Notice tone="crit">{errorText(save.error)}</Notice> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            {t('common:actions.cancel')}
          </Button>
        ) : null}
        <Button type="submit" variant="primary" loading={save.isPending}>
          {editing ? t('common:actions.saveChanges') : t('patient.save')}
        </Button>
      </div>
    </form>
  );
}

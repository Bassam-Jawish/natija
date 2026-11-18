import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import type { SettingsLabProfile } from '@natija/contracts';
import { api } from '@/lib/api';
import { Button, Card, Field, Input, Select, toast } from '@/components/ui';
import { BilingualFields, useAdminError, useFieldErrors } from '../common';
import { BrandPreview } from './BrandPreview';
import { LogoCard } from './LogoCard';
import { CURRENCIES, TIMEZONES, tzOffset, useLabSaved } from './use-lab';

const FIELDS = [
  'nameAr',
  'nameEn',
  'taglineAr',
  'taglineEn',
  'phone',
  'email',
  'city',
  'addressAr',
  'addressEn',
  'directorNameAr',
  'directorNameEn',
  'directorTitleAr',
  'directorTitleEn',
  'brandColor',
  'currency',
  'timezone',
] as const;
type Draft = Record<(typeof FIELDS)[number], string>;

const toDraft = (p: SettingsLabProfile): Draft => Object.fromEntries(FIELDS.map((k) => [k, (p[k] as string | null) ?? ''])) as Draft;

/** Lab identity, contact, director, region and branding. Remount (key) after a save to reset the form. */
export function ProfileTab({ profile }: { profile: SettingsLabProfile }) {
  const { t } = useTranslation('admin');
  const errorMessage = useAdminError();
  const saved = useLabSaved();
  const initial = useMemo(() => toDraft(profile), [profile]);
  const [draft, setDraft] = useState<Draft>(initial);
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = FIELDS.some((k) => draft[k] !== initial[k]);
  const colorOk = /^#[0-9a-fA-F]{6}$/.test(draft.brandColor);

  const save = useMutation({
    mutationFn: () => api.put<SettingsLabProfile>('/settings/lab', { ...draft, brandColor: draft.brandColor.toUpperCase() }),
    onSuccess: async (p) => {
      toast.success(t('common.saved'));
      await saved(p);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const errors = useFieldErrors(save.error);

  const timezones = TIMEZONES.includes(draft.timezone) ? TIMEZONES : [draft.timezone, ...TIMEZONES];
  const currencies = CURRENCIES.includes(draft.currency) ? CURRENCIES : [draft.currency, ...CURRENCIES];
  const text = (k: keyof Draft, label: string, opts: { ltr?: boolean; placeholder?: string } = {}) => (
    <Field label={label} error={errors[k]}>
      {(id) => <Input id={id} value={draft[k]} onChange={(e) => set(k)(e.target.value)} ltr={opts.ltr} placeholder={opts.placeholder} invalid={!!errors[k]} />}
    </Field>
  );

  return (
    <form
      className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && colorOk) save.mutate();
      }}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Card title={t('settings.profile.identity')} description={t('settings.profile.identityHint')}>
          <div className="flex flex-col gap-3">
            <BilingualFields ar={draft.nameAr} en={draft.nameEn} onAr={set('nameAr')} onEn={set('nameEn')} errorAr={errors.nameAr} errorEn={errors.nameEn} />
            <BilingualFields
              ar={draft.taglineAr}
              en={draft.taglineEn}
              onAr={set('taglineAr')}
              onEn={set('taglineEn')}
              labelAr={t('settings.profile.taglineAr')}
              labelEn={t('settings.profile.taglineEn')}
              required={false}
            />
          </div>
        </Card>
        <Card title={t('settings.profile.contact')}>
          <div className="grid gap-3 sm:grid-cols-3">
            {text('phone', t('settings.profile.phone'), { ltr: true })}
            {text('email', t('fields.email'), { ltr: true })}
            {text('city', t('settings.profile.city'))}
          </div>
          <div className="mt-3">
            <BilingualFields
              ar={draft.addressAr}
              en={draft.addressEn}
              onAr={set('addressAr')}
              onEn={set('addressEn')}
              labelAr={t('settings.profile.addressAr')}
              labelEn={t('settings.profile.addressEn')}
              required={false}
            />
          </div>
        </Card>
        <Card title={t('settings.profile.director')} description={t('settings.profile.directorHint')}>
          <div className="flex flex-col gap-3">
            <BilingualFields
              ar={draft.directorNameAr}
              en={draft.directorNameEn}
              onAr={set('directorNameAr')}
              onEn={set('directorNameEn')}
              labelAr={t('settings.profile.directorNameAr')}
              labelEn={t('settings.profile.directorNameEn')}
              required={false}
            />
            <BilingualFields
              ar={draft.directorTitleAr}
              en={draft.directorTitleEn}
              onAr={set('directorTitleAr')}
              onEn={set('directorTitleEn')}
              labelAr={t('settings.profile.directorTitleAr')}
              labelEn={t('settings.profile.directorTitleEn')}
              required={false}
            />
          </div>
        </Card>
        <Card title={t('settings.profile.region')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('fields.currency')} hint={t('settings.profile.currencyHint')} error={errors.currency}>
              {(id) => (
                <Select
                  id={id}
                  value={draft.currency}
                  onValueChange={set('currency')}
                  options={currencies.map((c) => ({ value: c, label: t(`settings.currencies.${c}`, { defaultValue: c }), hint: c }))}
                />
              )}
            </Field>
            <Field label={t('fields.timezone')} hint={t('settings.profile.timezoneHint')} error={errors.timezone}>
              {(id) => (
                <Select id={id} value={draft.timezone} onValueChange={set('timezone')} options={timezones.map((z) => ({ value: z, label: z, hint: tzOffset(z) }))} />
              )}
            </Field>
          </div>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <Card title={t('settings.brand.title')} description={t('settings.brand.description')}>
          <div className="flex flex-col gap-3">
            <Field label={t('fields.brandColor')} error={errors.brandColor ?? (colorOk ? undefined : t('fieldErrors.invalid_color'))}>
              {(id) => (
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('fields.brandColor')}
                    value={colorOk ? draft.brandColor.toLowerCase() : '#2347b0'}
                    onChange={(e) => set('brandColor')(e.target.value.toUpperCase())}
                    className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-line-strong bg-surface p-1"
                  />
                  <Input id={id} ltr value={draft.brandColor} onChange={(e) => set('brandColor')(e.target.value.trim())} maxLength={7} className="font-mono" invalid={!colorOk} />
                </div>
              )}
            </Field>
            <BrandPreview
              color={draft.brandColor}
              logoSvg={profile.logoSvg}
              nameAr={draft.nameAr}
              nameEn={draft.nameEn}
              taglineAr={draft.taglineAr}
              taglineEn={draft.taglineEn}
              phone={draft.phone}
            />
          </div>
        </Card>
        <LogoCard profile={profile} />
      </div>

      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 rounded-xl border border-line bg-surface/95 px-4 py-2.5 shadow-pop backdrop-blur xl:col-span-2">
        <span className="me-auto text-[12.5px] text-muted">{dirty ? t('common.unsaved') : t('settings.profile.upToDate')}</span>
        <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => setDraft(initial)}>
          {t('common:actions.reset')}
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !colorOk}>
          <Save />
          {t('common:actions.saveChanges')}
        </Button>
      </div>
    </form>
  );
}

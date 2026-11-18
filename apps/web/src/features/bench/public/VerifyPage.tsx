import { useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleCheck, CircleX, QrCode as QrIcon, Search, TriangleAlert } from 'lucide-react';
import { useFormat } from '@/lib/format';
import { applyLanguage, useBi, useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button, ErrorState, Field, InfoList, Input, Segmented, Spinner } from '@/components/ui';
import { LabLogo, NatijaMark } from '@/components/layout/LabLogo';
import { benchApi } from '../api';

import { ltr } from '../components/common';
/** "Is this printed report genuine?" — /verify/:code from the QR, or /verify to type the code. */
export default function VerifyPage() {
  const { t } = useTranslation('bench');
  const { code } = useParams();
  const lang = useLang();
  return (
    <div className="min-h-dvh bg-paper">
      <header className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4 py-4">
        <div className="flex items-center gap-2.5">
          <NatijaMark className="size-8" />
          <div>
            <div className="text-[15px] font-semibold text-ink">{t('verify.title')}</div>
            <div className="text-[12px] text-muted">{t('verify.subtitle')}</div>
          </div>
        </div>
        <Segmented
          size="sm"
          value={lang}
          onChange={(v) => applyLanguage(v)}
          options={[
            { value: 'ar', label: 'عربي' },
            { value: 'en', label: 'English' },
          ]}
        />
      </header>
      <main className="mx-auto max-w-xl px-4 pb-12">{code ? <VerifyResult code={code} /> : <VerifyForm />}</main>
    </div>
  );
}

function VerifyForm({ initial = '' }: { initial?: string }) {
  const { t } = useTranslation('bench');
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  const clean = value.replace(/[\s-]/g, '').toUpperCase();
  return (
    <form
      className="mt-4 rounded-[var(--radius-card)] border border-line bg-surface p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean.length >= 6) navigate(`/verify/${encodeURIComponent(clean)}`);
      }}
    >
      <span className="mb-3 grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
        <QrIcon className="size-5" />
      </span>
      <h1 className="text-[18px] font-semibold text-ink">{t('verify.enterTitle')}</h1>
      <p className="mt-1 mb-4 text-[13.5px] text-muted">{t('verify.enterHint')}</p>
      <Field label={t('verify.code')}>
        {(id) => <Input id={id} ltr value={value} onChange={(e) => setValue(e.target.value)} autoFocus className="h-11 font-mono text-[18px] tracking-[0.2em] uppercase" maxLength={16} />}
      </Field>
      <Button type="submit" variant="primary" className="mt-4 w-full" disabled={clean.length < 6}>
        <Search />
        {t('verify.check')}
      </Button>
    </form>
  );
}

function VerifyResult({ code }: { code: string }) {
  const { t } = useTranslation('bench');
  const f = useFormat();
  const bi = useBi();
  const query = useQuery({ queryKey: ['public', 'verify', code], queryFn: () => benchApi.publicVerify(code), retry: false });
  if (query.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const r = query.data!;
  if (r.status === 'not_found') {
    return (
      <div className="flex flex-col gap-4">
        <div className="mt-4 rounded-[var(--radius-card)] border border-crit/40 bg-surface p-6 text-center">
          <span className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-crit-soft text-crit">
            <CircleX className="size-6" />
          </span>
          <h1 className="text-[18px] font-semibold text-ink">{t('verify.notFoundTitle')}</h1>
          <p className="mt-1 text-[13.5px] text-muted">{t('verify.notFoundHint', { code: ltr(code) })}</p>
        </div>
        <VerifyForm initial={code} />
      </div>
    );
  }
  const genuine = r.status === 'genuine';
  return (
    <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface" style={{ '--c-brand': r.lab.brandColor } as CSSProperties}>
      <div className="h-1 bg-brand" />
      <div className={cn('flex items-start gap-3 px-6 py-5', genuine ? 'bg-ok-soft' : 'bg-warn-soft')}>
        {genuine ? <CircleCheck className="mt-0.5 size-7 shrink-0 text-ok" /> : <TriangleAlert className="mt-0.5 size-7 shrink-0 text-warn" />}
        <div>
          <h1 className={cn('text-[18px] font-semibold', genuine ? 'text-ok' : 'text-warn')}>{genuine ? t('verify.genuineTitle') : t('verify.supersededTitle')}</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-2">{genuine ? t('verify.genuineHint') : t('verify.supersededHint', { version: r.version, latest: r.latestVersion })}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 border-b border-line px-6 py-4">
        <LabLogo svg={r.lab.logoSvg} name={bi(r.lab, 'name')} className="size-10" />
        <div className="font-semibold text-ink">{bi(r.lab, 'name')}</div>
      </div>
      <div className="px-6 py-5">
        <InfoList
          columns={2}
          items={[
            { label: t('verify.order'), value: <span className="ltr-num font-mono">{r.accession}</span> },
            { label: t('verify.version'), value: <span className="ltr-num">{t('verify.versionOf', { version: r.version, latest: r.latestVersion })}</span> },
            { label: t('verify.released'), value: f.dateTime(r.releasedAt) },
            { label: t('verify.patient'), value: r.patientInitials },
            { label: t('verify.tests'), value: <span className="ltr-num">{r.testCount}</span> },
            { label: t('verify.code'), value: <span className="ltr-num font-mono">{code.toUpperCase()}</span> },
            { label: t('verify.hash'), value: <span className="ltr-num font-mono text-[11.5px] break-all text-muted">{r.contentHash}</span>, wide: true },
          ]}
        />
        <p className="mt-5 text-[12.5px] text-muted">{t('verify.noResults')}</p>
      </div>
    </div>
  );
}

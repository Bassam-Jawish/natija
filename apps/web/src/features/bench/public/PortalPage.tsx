import { useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileDown, Link2Off, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { PublicLabBranding, PublicReport, ReportLanguage } from '@natija/contracts';
import { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { applyLanguage, useBi, useLang } from '@/lib/i18n';
import { Button, Field, Input, Segmented, Spinner } from '@/components/ui';
import { LabLogo, NatijaMark } from '@/components/layout/LabLogo';
import { benchApi } from '../api';
import { ReportDocument } from '../components/ReportDocument';
import { useBenchError } from '../components/common';

/** Public report page: /r/:token (link + receipt code) or /r?lab=&order= (receipt QR). */
export default function PortalPage() {
  const [report, setReport] = useState<PublicReport | null>(null);
  if (report) return <PortalReport report={report} onClose={() => setReport(null)} />;
  return <PortalGate onOpened={setReport} />;
}

function LanguageToggle() {
  const lang = useLang();
  return (
    <Segmented
      size="sm"
      value={lang}
      onChange={(v) => applyLanguage(v)}
      options={[
        { value: 'ar', label: 'عربي' },
        { value: 'en', label: 'English' },
      ]}
    />
  );
}

function PublicShell({ lab, children, wide }: { lab?: PublicLabBranding | null; children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation('bench');
  const bi = useBi();
  return (
    <div className="min-h-dvh bg-paper" style={lab ? ({ '--c-brand': lab.brandColor } as CSSProperties) : undefined}>
      <div className="h-1 bg-brand no-print" />
      <header className="no-print mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {lab ? <LabLogo svg={lab.logoSvg} name={bi(lab, 'name')} className="size-11" /> : <NatijaMark className="size-9" />}
          <div className="min-w-0">
            <div className="truncate text-[16px] font-semibold text-ink">{lab ? bi(lab, 'name') : t('portal.title')}</div>
            {lab ? <div className="truncate text-[12.5px] text-muted">{bi(lab, 'tagline')}</div> : null}
          </div>
        </div>
        <LanguageToggle />
      </header>
      <main className={wide ? 'mx-auto max-w-5xl px-4 pb-10' : 'mx-auto max-w-md px-4 pb-10'}>{children}</main>
      <footer className="no-print mx-auto flex max-w-5xl items-center justify-center gap-2 px-4 pb-6 text-[12px] text-faint">
        <NatijaMark className="size-4" />
        {t('portal.poweredBy')}
        {lab?.demo ? <span className="font-medium text-warn">· {t('portal.demo')}</span> : null}
      </footer>
    </div>
  );
}

function PortalGate({ onOpened }: { onOpened: (r: PublicReport) => void }) {
  const { t } = useTranslation('bench');
  const errorMessage = useBenchError();
  const { token } = useParams();
  const [params] = useSearchParams();
  const labParam = params.get('lab')?.trim() || '';
  const [labCode, setLabCode] = useState(labParam);
  const [accession, setAccession] = useState(params.get('order')?.trim() || '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const info = useQuery({ queryKey: ['public', 'info', token], queryFn: () => benchApi.publicInfo(token!), enabled: !!token, retry: false });
  const labInfo = useQuery({ queryKey: ['public', 'lab', labParam], queryFn: () => benchApi.publicLab(labParam), enabled: !token && !!labParam, retry: false });
  const lab = token ? info.data?.lab : labInfo.data;

  const open = useMutation({
    mutationFn: () => (token ? benchApi.publicOpen(token, code) : benchApi.publicLookup(labCode.trim().toLowerCase(), accession.trim(), code)),
    onSuccess: (r) => onOpened(r),
    onError: (err) => {
      setError(errorMessage(err));
      setCode('');
    },
  });

  if (token && info.isLoading) {
    return (
      <PublicShell>
        <div className="grid min-h-[40vh] place-items-center">
          <Spinner className="size-6" />
        </div>
      </PublicShell>
    );
  }
  if (token && info.isError) {
    const expired = info.error instanceof ApiError && info.error.status === 410;
    return (
      <PublicShell>
        <div className="mt-10 rounded-[var(--radius-card)] border border-line bg-surface p-6 text-center">
          <span className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-warn-soft text-warn">
            <Link2Off className="size-6" />
          </span>
          <h1 className="text-[18px] font-semibold text-ink">{expired ? t('portal.expiredTitle') : t('portal.invalidTitle')}</h1>
          <p className="mt-1 text-[13.5px] text-muted">{t('portal.askLab')}</p>
        </div>
      </PublicShell>
    );
  }

  const valid = /^\d{6}$/.test(code) && (token || (labCode.trim() && accession.trim()));
  return (
    <PublicShell lab={lab}>
      <form
        className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (valid) open.mutate();
        }}
      >
        <span className="mb-3 grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
          <LockKeyhole className="size-5" />
        </span>
        <h1 className="text-[19px] font-semibold text-ink">{t('portal.heading')}</h1>
        <p className="mt-1 mb-5 text-[13.5px] text-muted">{token ? t('portal.codeHint') : t('portal.lookupHint')}</p>
        <div className="flex flex-col gap-4">
          {!token && !labParam ? (
            <Field label={t('portal.labCode')} required>
              {(id) => <Input id={id} ltr value={labCode} onChange={(e) => setLabCode(e.target.value)} autoComplete="off" />}
            </Field>
          ) : null}
          {!token ? (
            <Field label={t('portal.orderNumber')} hint={t('portal.orderNumberHint')} required>
              {(id) => <Input id={id} ltr value={accession} onChange={(e) => setAccession(e.target.value)} autoComplete="off" className="font-mono" />}
            </Field>
          ) : null}
          <Field label={t('portal.code')} error={error} required>
            {(id) => (
              <Input
                id={id}
                ltr
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="••••••"
                invalid={!!error}
                className="h-12 text-center font-mono text-[22px] tracking-[0.5em]"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={open.isPending} disabled={!valid}>
            <ShieldCheck />
            {t('portal.open')}
          </Button>
        </div>
        <p className="mt-4 text-[12px] text-faint">{t('portal.privacy')}</p>
      </form>
    </PublicShell>
  );
}

function PortalReport({ report, onClose }: { report: PublicReport; onClose: () => void }) {
  const { t } = useTranslation('bench');
  const f = useFormat();
  const [language, setLanguage] = useState<ReportLanguage>(report.snapshot.language);
  return (
    <PublicShell lab={report.lab} wide>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft className="rtl:rotate-180" />
          {t('common:actions.close')}
        </Button>
        <div className="text-[13px] text-muted">
          {t('portal.released', { date: f.dateTime(report.releasedAt) })}
          {report.version > 1 ? <span className="ms-2 font-medium text-warn">{t('portal.amendedVersion', { version: report.version })}</span> : null}
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            value={language}
            onChange={setLanguage}
            options={[
              { value: 'ar', label: t('report.lang.ar') },
              { value: 'en', label: t('report.lang.en') },
              { value: 'bilingual', label: t('report.lang.bilingual') },
            ]}
          />
          <Button variant="primary" size="sm" onClick={() => window.print()}>
            <FileDown />
            {t('portal.savePdf')}
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <ReportDocument snapshot={report.snapshot} language={language} mode="screen" />
      </div>
      <p className="no-print mt-4 text-center text-[12px] text-faint">{t('portal.keepPrivate')}</p>
    </PublicShell>
  );
}

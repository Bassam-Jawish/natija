import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileX, Printer } from 'lucide-react';
import type { ReportLanguage } from '@natija/contracts';
import { usePrintWhenReady } from '@/lib/print';
import { Button, buttonVariants, EmptyState, ErrorState, Segmented, Spinner } from '@/components/ui';
import { benchApi, benchKeys } from '../api';
import { ReportDocument } from '../components/ReportDocument';

import { ltr } from '../components/common';
/** A4 report: /print/report/:orderId (latest version) or ?version=N. */
export default function ReportPrint() {
  const { t } = useTranslation('bench');
  const { orderId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const version = Number(params.get('version')) || undefined;
  const query = useQuery({ queryKey: benchKeys.orderReports(orderId, version), queryFn: () => benchApi.orderReports(orderId, version), enabled: !!orderId });
  const report = query.data?.report ?? null;
  const language = (params.get('lang') as ReportLanguage | null) ?? report?.snapshot.language ?? 'bilingual';
  usePrintWhenReady(!!report);

  return (
    <div className="min-h-dvh bg-sunken print:bg-white">
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <Link to={`/orders/${orderId}`} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
          <ArrowLeft className="rtl:rotate-180" />
          {t('print.backToOrder')}
        </Link>
        {query.data ? (
          <span className="text-[13px] text-muted">
            {t('print.title', { accession: ltr(query.data.order.accession) })}
            {report ? <span className="ms-2 ltr-num">v{report.version}</span> : null}
            {report?.status === 'superseded' ? <span className="ms-2 font-medium text-warn">{t('reports.supersededShort')}</span> : null}
          </span>
        ) : null}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {query.data && query.data.versions.length > 1 ? (
            <Segmented
              size="sm"
              value={String(report?.version ?? '')}
              onChange={(v) => setParams((p) => (p.set('version', v), p))}
              options={query.data.versions.map((v) => ({ value: String(v.version), label: `v${v.version}` }))}
            />
          ) : null}
          <Segmented
            size="sm"
            value={language}
            onChange={(v) => setParams((p) => (p.set('lang', v), p))}
            options={[
              { value: 'ar', label: t('report.lang.ar') },
              { value: 'en', label: t('report.lang.en') },
              { value: 'bilingual', label: t('report.lang.bilingual') },
            ]}
          />
          <Button variant="primary" size="sm" onClick={() => window.print()} disabled={!report}>
            <Printer />
            {t('common:actions.print')}
          </Button>
        </div>
      </div>
      <div className="mx-auto max-w-[230mm] px-4 py-6 print:p-0">
        {query.isLoading ? (
          <div className="grid min-h-[50vh] place-items-center">
            <Spinner className="size-6" />
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !report ? (
          <EmptyState icon={FileX} title={t('reports.none')} description={t('reports.noneHint')} />
        ) : (
          <ReportDocument snapshot={report.snapshot} language={language} mode="screen" />
        )}
      </div>
    </div>
  );
}

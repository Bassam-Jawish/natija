import { useEffect, useRef } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Printer } from 'lucide-react';
import { useFormat } from '@/lib/format';
import { usePrintWhenReady } from '@/lib/print';
import { Barcode, Button, EmptyState, Spinner } from '@/components/ui';
import { fd, keys } from '../api';
import { FdErrorState, LinkButton } from '../components/shared';

const CSS = `
@page { size: 50mm 25mm; margin: 0; }
.tube-label {
  width: 50mm; height: 25mm; box-sizing: border-box; padding: 1.2mm 1.8mm 1mm;
  display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;
  background: #fff; color: #000; font-family: 'IBM Plex Sans', 'IBM Plex Sans Arabic', sans-serif;
  break-after: page; page-break-after: always;
}
.tube-label:last-child { break-after: auto; page-break-after: auto; }
.tube-label svg { display: block; width: 100%; height: 9.5mm; }
.tube-label .row { display: flex; align-items: baseline; justify-content: space-between; gap: 1.5mm; min-width: 0; }
.tube-label .name { font-size: 7.5pt; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tube-label .meta { font-size: 6.5pt; white-space: nowrap; }
.tube-label .no { font-size: 12pt; font-weight: 700; line-height: 1; }
.tube-label .code { font-family: 'IBM Plex Mono', monospace; font-size: 6.5pt; }
.tube-label .tests { font-family: 'IBM Plex Mono', monospace; font-size: 5.8pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media screen {
  .labels-sheet { display: flex; flex-wrap: wrap; gap: 6mm; padding: 6mm; }
  .tube-label { outline: 1px dashed #c3c9d4; }
}
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  .labels-sheet { display: block; padding: 0; }
}
`;

/** One 50 × 25 mm label per tube: Code 128 of the tube barcode, short name, sex/age, daily number, container and tests. */
export default function LabelsPrint() {
  const { orderId = '' } = useParams<{ orderId: string }>();
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const q = useQuery({ queryKey: keys.labels(orderId), queryFn: () => fd.labels(orderId), enabled: !!orderId });
  usePrintWhenReady(!!q.data && q.data.labels.length > 0);
  const recorded = useRef(false);

  // The print dialog has closed: record that the labels went out (once per page load).
  useEffect(() => {
    if (!q.data?.labels.length) return;
    const onAfter = () => {
      if (recorded.current) return;
      recorded.current = true;
      void fd.labelsPrinted(orderId).catch(() => undefined);
    };
    window.addEventListener('afterprint', onAfter);
    return () => window.removeEventListener('afterprint', onAfter);
  }, [q.data, orderId]);

  if (q.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-paper">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (q.error || !q.data) return <FdErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { order, patient, labels } = q.data;
  const sex = t(`common:common.${patient.sex}`);

  return (
    <div className="min-h-dvh bg-paper print:bg-white">
      <style>{CSS}</style>
      <div className="no-print flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <LinkButton to={`/orders/${order.id}`} variant="ghost" size="sm">
          <ArrowLeft className="rtl:rotate-180" />
          {t('print.backToOrder')}
        </LinkButton>
        <span className="text-[13.5px] text-ink">{t('print.labelsTitle', { count: labels.length, accession: order.accession })}</span>
        <span className="text-[12px] text-muted">{t('print.labelsHint')}</span>
        <Button variant="primary" size="sm" className="ms-auto" onClick={() => window.print()} disabled={!labels.length}>
          <Printer />
          {t('common:actions.print')}
        </Button>
      </div>
      {labels.length ? (
        <div className="labels-sheet">
          {labels.map((l) => (
            <div className="tube-label" key={l.sampleId}>
              <div className="row">
                <span className="name" dir="auto">
                  {patient.shortNameAr}
                </span>
                <span className="meta">
                  {sex} · {f.age(patient.birthDate)}
                </span>
              </div>
              <Barcode value={l.barcode} height={40} barWidth={1.6} showText={false} />
              <div className="row">
                <span className="no ltr-num">{order.dailyNo}</span>
                <span className="code ltr-num">{l.barcode}</span>
                <span className="code ltr-num" style={{ fontWeight: 600 }}>
                  {l.containerCode}
                </span>
              </div>
              <div className="tests ltr-num" dir="ltr">
                {l.testCodes.join(' ')}
                {order.priority !== 'routine' ? ` · ${order.priority.toUpperCase()}` : ''}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title={t('print.noTubes')} />
      )}
    </div>
  );
}

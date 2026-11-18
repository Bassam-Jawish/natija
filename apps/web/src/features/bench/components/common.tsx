import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Calculator, Cpu, Hand, Siren, TriangleAlert } from 'lucide-react';
import type { BenchContainer, BenchPatient, BenchPriority, BenchResult } from '@natija/contracts';
import { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, FlagChip, StatusChip, Tooltip, TubeIcon, useErrorMessage } from '@/components/ui';

const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

/** Keep a barcode, order number, code or phone number left-to-right inside a translated sentence. */
export function ltr(value: string | number | null | undefined): string {
  return `${LRI}${value ?? ''}${PDI}`;
}

/** API errors in the user's language: bench codes first, then the shared ones. */
export function useBenchError() {
  const { t, i18n } = useTranslation('bench');
  const common = useErrorMessage();
  return (error: unknown): string => {
    if (error instanceof ApiError && i18n.exists(`bench:errors.${error.code}`)) {
      const left = error.errors?.attemptsLeft?.[0];
      return t(`errors.${error.code}`, { count: left ? Number(left) : 0 });
    }
    return common(error);
  };
}

/** For ESignDialog: rethrow API errors with the bench translation as their message. */
export function useSignedAction() {
  const message = useBenchError();
  return <T,>(fn: (password: string) => Promise<T>) =>
    async (password: string) => {
      try {
        return await fn(password);
      } catch (err) {
        if (err instanceof ApiError) throw new ApiError(err.status, err.code, message(err), err.errors, err.detail);
        throw err;
      }
    };
}

export function PriorityBadge({ priority, showRoutine }: { priority: BenchPriority | string; showRoutine?: boolean }) {
  if (priority === 'routine' && !showRoutine) return null;
  return <StatusChip kind="priority" status={priority} />;
}

export function SexAge({ patient }: { patient: Pick<BenchPatient, 'sex' | 'birthDate'> }) {
  const { t } = useTranslation('bench');
  const f = useFormat();
  return (
    <span className="whitespace-nowrap">
      {t(`sexShort.${patient.sex}`)} · {f.age(patient.birthDate)}
    </span>
  );
}

export function PatientCell({ patient, orderId, accession, className }: { patient: BenchPatient; orderId?: string; accession?: string; className?: string }) {
  const bi = useBi();
  const name = bi(patient, 'fullName');
  return (
    <div className={cn('min-w-0', className)}>
      <div className="truncate font-medium text-ink">
        {orderId ? (
          <Link to={`/orders/${orderId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
            {name}
          </Link>
        ) : (
          name
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
        <SexAge patient={patient} />
        <span className="ltr-num font-mono">{accession ?? patient.mrn}</span>
      </div>
    </div>
  );
}

/** "12 min", live; amber after `warnAfter`, red after `critAfter` minutes. */
export function WaitTime({ since, warnAfter = 60, critAfter = 180, className }: { since: string | null | undefined; warnAfter?: number; critAfter?: number; className?: string }) {
  const f = useFormat();
  const now = useNow(30_000);
  if (!since) return <span className="text-muted">—</span>;
  const minutes = f.minutesBetween(since, now);
  const tone = minutes >= critAfter ? 'text-crit' : minutes >= warnAfter ? 'text-warn' : 'text-muted';
  return (
    <span className={cn('tabular whitespace-nowrap', tone, className)} title={f.dateTime(since)}>
      {f.duration(minutes)}
    </span>
  );
}

export function TubeCell({ container, barcode, sub }: { container: BenchContainer; barcode: string; sub?: ReactNode }) {
  const bi = useBi();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TubeIcon cap={container.capColor} title={bi(container, 'name')} />
      <div className="min-w-0">
        <div className="ltr-num truncate font-mono text-[13px] text-ink">{barcode}</div>
        <div className="truncate text-[12px] text-muted">{sub ?? bi(container, 'name')}</div>
      </div>
    </div>
  );
}

/** Where the current value came from: analyzer, calculation or typed by hand. */
export function SourceIcon({ result }: { result: Pick<BenchResult, 'source' | 'instrument'> }) {
  const { t } = useTranslation('bench');
  if (!result.source) return null;
  const map = {
    instrument: { icon: Cpu, label: result.instrument ? t('source.instrumentNamed', { name: result.instrument.name }) : t('source.instrument'), className: 'text-info' },
    calculated: { icon: Calculator, label: t('source.calculated'), className: 'text-violet' },
    manual: { icon: Hand, label: t('source.manual'), className: 'text-faint' },
  } as const;
  const m = map[result.source];
  const Icon = m.icon;
  return (
    <Tooltip content={m.label}>
      <span className={cn('inline-flex items-center gap-1 text-[11px]', m.className)} aria-label={m.label}>
        <Icon className="size-3.5" />
        {result.source === 'instrument' && result.instrument ? <span className="ltr-num font-mono">{result.instrument.code}</span> : null}
      </span>
    </Tooltip>
  );
}

/** A value as printed: bold when abnormal, with the flag chip and a critical mark. */
export function ResultValue({ result, className, hideFlag }: { result: Pick<BenchResult, 'value' | 'flag' | 'isCritical' | 'unit'>; className?: string; hideFlag?: boolean }) {
  const { t } = useTranslation('bench');
  const abnormal = !!result.flag && result.flag !== 'N';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('ltr-num tabular', abnormal ? 'font-semibold text-ink' : 'text-ink-2', result.isCritical && 'text-crit')}>{result.value ?? '—'}</span>
      {hideFlag ? null : <FlagChip flag={result.flag} critical={result.isCritical} />}
      {result.isCritical ? (
        <Tooltip content={t('critical.label')}>
          <Siren className="size-3.5 text-crit" aria-label={t('critical.label')} />
        </Tooltip>
      ) : null}
    </span>
  );
}

export function PreviousValue({ result }: { result: Pick<BenchResult, 'previous' | 'deltaFlag'> }) {
  const { t } = useTranslation('bench');
  const f = useFormat();
  if (!result.previous) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="ltr-num tabular text-ink-2">{result.previous.value ?? '—'}</span>
      <span className="text-[11px] text-muted" title={f.date(result.previous.at)}>
        {f.shortDay(result.previous.at)}
      </span>
      {result.deltaFlag ? (
        <Tooltip content={t('delta.hint')}>
          <Badge tone="warn" className="h-[18px] px-1.5 text-[11px]">
            <TriangleAlert className="size-3" />Δ
          </Badge>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function TestName({ row, className }: { row: { nameAr: string; nameEn: string; code?: string }; className?: string }) {
  const bi = useBi();
  return (
    <span className={cn('min-w-0', className)}>
      <span className="text-ink">{bi(row, 'name')}</span>
      {row.code ? <span className="ms-1.5 ltr-num font-mono text-[11px] text-faint">{row.code}</span> : null}
    </span>
  );
}

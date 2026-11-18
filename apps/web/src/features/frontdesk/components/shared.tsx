import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { PatientSummary } from '@natija/contracts';
import { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useLang } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge, Button, buttonVariants, Tooltip } from '@/components/ui';

type ButtonLook = {
  variant?: 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger' | 'success' | 'link';
  size?: 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';
};

/** A router link that looks like a Button (instead of Button asChild). */
export function LinkButton({ variant = 'secondary', size = 'md', className, ...props }: LinkProps & ButtonLook) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

/** A plain link (file download, new tab) that looks like a Button. */
export function AnchorButton({ variant = 'secondary', size = 'md', className, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & ButtonLook) {
  return <a className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

/** Patient name in the reading language (Latin name in English when there is one). */
export function usePatientName() {
  const lang = useLang();
  return (p: { fullNameAr: string; fullNameEn?: string | null } | null | undefined) => (!p ? '' : lang === 'en' && p.fullNameEn ? p.fullNameEn : p.fullNameAr);
}

/** API error → sentence in the user's language (front desk codes first, then the shared ones). */
export function useFdError() {
  const { t } = useTranslation('frontdesk');
  return (err: unknown): string => {
    if (err instanceof ApiError) {
      // Front desk codes live in this namespace; shared ones (validation, forbidden…) fall back to common.
      const fallback = err.message && err.message !== err.code ? err.message : t(err.status === 404 ? 'common:errors.not_found' : 'common:errors.generic');
      return t(`errors.${err.code}`, { defaultValue: fallback });
    }
    if (err instanceof TypeError) return t('common:errors.network');
    return t('common:errors.generic');
  };
}

export function apiCode(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}

/** Field errors from a 400 "validation" response, keyed by field name. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !err.errors) return {};
  return Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k.split('.')[0]!, v[0] ?? '']));
}

export function AgeText({ birthDate, estimated }: { birthDate: string; estimated?: boolean }) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  if (!estimated) return <span className="tabular">{f.age(birthDate)}</span>;
  return (
    <Tooltip content={t('patient.estimatedAge')}>
      <span className="tabular">≈ {f.age(birthDate)}</span>
    </Tooltip>
  );
}

export function SexText({ sex }: { sex: string }) {
  const { t } = useTranslation('frontdesk');
  return <>{t(`common:common.${sex}`)}</>;
}

/** "P-000123 · Male · 34 y" line under a patient's name. */
export function PatientMeta({ p, className, phone = true }: { p: PatientSummary; className?: string; phone?: boolean }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-muted', className)}>
      <span className="font-mono ltr-num">{p.mrn}</span>
      <span aria-hidden>·</span>
      <SexText sex={p.sex} />
      <span aria-hidden>·</span>
      <AgeText birthDate={p.birthDate} estimated={p.birthDateEstimated} />
      {phone && p.phone ? (
        <>
          <span aria-hidden>·</span>
          <span className="ltr-num">{p.phone}</span>
        </>
      ) : null}
    </span>
  );
}

export function PatientLink({ p, className }: { p: PatientSummary; className?: string }) {
  const name = usePatientName();
  return (
    <Link to={`/patients/${p.id}`} className={cn('font-medium text-ink hover:text-accent hover:underline', className)} onClick={(e) => e.stopPropagation()}>
      {name(p)}
    </Link>
  );
}

/** Big daily order number, the number patients are called by. */
export function DailyNo({ value, size = 'md', className }: { value: number; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const cls = { sm: 'text-[15px]', md: 'text-[20px]', lg: 'text-[34px]', xl: 'text-[72px] leading-none' }[size];
  return <span className={cn('font-semibold tracking-tight text-ink tabular ltr-num', cls, className)}>{value}</span>;
}

export function Accession({ value, className }: { value: string; className?: string }) {
  return <span className={cn('font-mono text-[12.5px] text-ink-2 ltr-num', className)}>{value}</span>;
}

export function CriticalBadge() {
  const { t } = useTranslation('frontdesk');
  return (
    <Badge tone="crit" className="font-semibold">
      <AlertTriangle className="size-3" />
      {t('orders.critical')}
    </Badge>
  );
}

/** Inline alert box (never colour alone: icon + text). */
export function Notice({ tone = 'warn', icon, title, children, action, className }: { tone?: 'warn' | 'crit' | 'info' | 'ok'; icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const tones = { warn: 'border-warn/30 bg-warn-soft text-warn', crit: 'border-crit/30 bg-crit-soft text-crit', info: 'border-info/30 bg-info-soft text-info', ok: 'border-ok/30 bg-ok-soft text-ok' };
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]', tones[tone], className)} role={tone === 'crit' ? 'alert' : 'status'}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon ?? <AlertTriangle />}</span>
      <div className="min-w-0 flex-1 text-ink">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn('text-ink-2', title && 'mt-0.5')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Error state that also knows the front desk's error codes. */
export function FdErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation('frontdesk');
  const message = useFdError()(error);
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-crit-soft text-crit">
        <AlertTriangle className="size-5" />
      </span>
      <p className="text-[15px] font-medium text-ink">{t('common:errors.title')}</p>
      <p className="max-w-md text-[13px] text-muted">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">
          <RotateCcw />
          {t('common:actions.retry')}
        </Button>
      ) : null}
    </div>
  );
}

/** Label / value row used in totals panels. */
export function SumRow({ label, children, strong, muted, className }: { label: ReactNode; children: ReactNode; strong?: boolean; muted?: boolean; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-1', className)}>
      <span className={cn('text-[13px]', muted ? 'text-muted' : 'text-ink-2', strong && 'font-semibold text-ink')}>{label}</span>
      <span className={cn('tabular', strong ? 'text-[17px] font-semibold text-ink' : 'text-[13.5px] text-ink')}>{children}</span>
    </div>
  );
}

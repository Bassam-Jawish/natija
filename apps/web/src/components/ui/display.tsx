import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Tabs as RTabs } from 'radix-ui';
import { AlertTriangle, ArrowLeft, Inbox, Loader2, RotateCcw, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from './button';

/* ------------------------------------------------------------------ Badge & status */

export type Tone = 'neutral' | 'muted' | 'info' | 'violet' | 'ok' | 'warn' | 'crit' | 'accent';
const TONE: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2',
  muted: 'bg-sunken text-muted',
  info: 'bg-info-soft text-info',
  violet: 'bg-violet-soft text-violet',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  accent: 'bg-accent-soft text-accent',
};
const DOT: Record<Tone, string> = {
  neutral: 'bg-ink-2',
  muted: 'bg-faint',
  info: 'bg-info',
  violet: 'bg-violet',
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  accent: 'bg-accent',
};

export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-[12px] font-medium whitespace-nowrap', TONE[tone], className)}>
      {dot ? <span className={cn('size-1.5 rounded-full', DOT[tone])} /> : null}
      {children}
    </span>
  );
}

/** Colour, dot and translated word for every workflow state (never colour alone). */
export const STATUS_TONES: Record<string, Record<string, Tone>> = {
  order: { registered: 'neutral', collected: 'info', in_progress: 'violet', partial: 'warn', completed: 'ok', delivered: 'ok', cancelled: 'muted' },
  item: { ordered: 'neutral', collected: 'info', received: 'info', in_analysis: 'violet', resulted: 'violet', verified: 'info', validated: 'ok', released: 'ok', rejected: 'crit', cancelled: 'muted' },
  sample: { pending: 'neutral', collected: 'info', in_transit: 'info', received: 'violet', rejected: 'crit', in_analysis: 'violet', stored: 'muted', disposed: 'muted' },
  result: { pending: 'neutral', resulted: 'info', verified: 'violet', validated: 'ok', released: 'ok' },
  invoice: { open: 'warn', partial: 'warn', paid: 'ok', void: 'muted' },
  instrument: { online: 'ok', offline: 'crit', error: 'crit', unknown: 'muted' },
  message: { received: 'info', processed: 'ok', duplicate: 'muted', error: 'crit', partial: 'warn', unmatched: 'warn' },
  priority: { routine: 'muted', urgent: 'warn', stat: 'crit' },
  approval: { pending: 'warn', approved: 'ok', rejected: 'crit' },
  session: { open: 'ok', closed: 'muted' },
  review: { open: 'warn', assigned: 'ok', dismissed: 'muted' },
  qc: { accepted: 'ok', warning: 'warn', rejected: 'crit' },
  level: { L0: 'muted', L1: 'info', L2: 'warn', L3: 'ok' },
  agent: { pending: 'warn', active: 'ok', revoked: 'muted' },
  outbox: { pending: 'warn', simulated: 'info', sent: 'ok', failed: 'crit' },
  delivery: { sent: 'ok', simulated: 'info', failed: 'crit', opened: 'ok' },
  user: { active: 'ok', disabled: 'muted' },
};

export function StatusChip({ kind, status, className }: { kind: keyof typeof STATUS_TONES | string; status: string; className?: string }) {
  const { t } = useTranslation();
  const tone = STATUS_TONES[kind]?.[status] ?? 'neutral';
  return (
    <Badge tone={tone} dot className={className}>
      {t(`status.${kind}.${status}`, { defaultValue: status.replace(/_/g, ' ') })}
    </Badge>
  );
}

/** Result flag with arrow and letters so it works in black-and-white print and for colour-blind staff. */
export function FlagChip({ flag, critical, className }: { flag: string | null | undefined; critical?: boolean; className?: string }) {
  const { t } = useTranslation();
  if (!flag || flag === 'N') return null;
  const map: Record<string, { label: string; tone: Tone }> = {
    H: { label: '↑ H', tone: 'warn' },
    L: { label: '↓ L', tone: 'warn' },
    HH: { label: '↑↑ HH', tone: 'crit' },
    LL: { label: '↓↓ LL', tone: 'crit' },
    A: { label: '! A', tone: 'warn' },
  };
  const m = map[flag] ?? { label: flag, tone: 'neutral' as Tone };
  return (
    <Badge tone={critical ? 'crit' : m.tone} className={cn('font-semibold ltr-num', className)}>
      <span title={t(`flag.${flag}`, { defaultValue: flag })}>{m.label}</span>
    </Badge>
  );
}

/* ------------------------------------------------------------------ Card, tiles, headers */

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn('min-w-0 rounded-[var(--radius-card)] border border-line bg-surface', className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-[15px] font-semibold text-ink">{title}</h2> : null}
            {description ? <p className="text-[12.5px] text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(padded ? 'p-4' : null, bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  to,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  to?: string;
}) {
  const body = (
    <div className={cn('flex h-full min-w-0 flex-col gap-1 rounded-[var(--radius-card)] border border-line bg-surface p-4', to && 'transition-colors hover:border-line-strong')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-muted">{label}</span>
        {Icon ? (
          <span className={cn('grid size-7 place-items-center rounded-lg', tone ? TONE[tone] : 'bg-sunken text-ink-2')}>
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <div className="text-[26px] leading-tight font-semibold tracking-tight text-ink tabular">{value}</div>
      {hint ? <div className="text-[12.5px] text-muted">{hint}</div> : null}
    </div>
  );
  return to ? (
    <Link to={to} className="block min-w-0">
      {body}
    </Link>
  ) : (
    body
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: string;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back ? (
          <Link to={back} className="mb-1 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
            <ArrowLeft className="size-3.5 rtl:rotate-180" />
            <BackLabel />
          </Link>
        ) : null}
        <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-[13.5px] text-muted">{description}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function BackLabel() {
  const { t } = useTranslation();
  return <>{t('actions.back')}</>;
}

/** Label/value pairs for detail panels. */
export function InfoList({ items, columns = 2, className }: { items: Array<{ label: ReactNode; value: ReactNode; wide?: boolean }>; columns?: 1 | 2 | 3 | 4; className?: string }) {
  const grid = { 1: 'grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[columns];
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', grid, className)}>
      {items.map((it, i) => (
        <div key={i} className={cn('min-w-0', it.wide && 'sm:col-span-full')}>
          <dt className="text-[12px] text-muted">{it.label}</dt>
          <dd className="mt-0.5 text-sm break-words text-ink">{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ States */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-sunken', className)} />;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: { icon?: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      <span className="grid size-11 place-items-center rounded-full bg-sunken text-muted">
        <Icon className="size-5" />
      </span>
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {description ? <p className="max-w-md text-[13px] text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Translate an API error to the user's language using its stable code. */
export function useErrorMessage() {
  const { t } = useTranslation();
  return (error: unknown): string => {
    if (error instanceof ApiError) return t(`errors.${error.code}`, { defaultValue: error.message || t('errors.generic') });
    if (error instanceof TypeError) return t('errors.network');
    return t('errors.generic');
  };
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { t } = useTranslation();
  const message = useErrorMessage()(error);
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      <span className="grid size-11 place-items-center rounded-full bg-crit-soft text-crit">
        <AlertTriangle className="size-5" />
      </span>
      <p className="text-[15px] font-medium text-ink">{t('errors.title')}</p>
      <p className="max-w-md text-[13px] text-muted">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">
          <RotateCcw />
          {t('actions.retry')}
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Small pieces */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{children}</kbd>;
}

const CAP: Record<string, string> = {
  lavender: 'var(--color-cap-lavender)',
  gold: 'var(--color-cap-gold)',
  lightblue: 'var(--color-cap-lightblue)',
  grey: 'var(--color-cap-grey)',
  green: 'var(--color-cap-green)',
  red: 'var(--color-cap-red)',
  black: 'var(--color-cap-black)',
  yellow: 'var(--color-cap-yellow)',
  brown: 'var(--color-cap-brown)',
  white: 'var(--color-cap-white)',
};

/** Tube with its cap colour. Cap colours mark the sample type only, never status. */
export function TubeIcon({ cap, className, title }: { cap: string; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 16 28" className={cn('h-6 w-[14px] shrink-0', className)} role="img" aria-label={title ?? cap}>
      <rect x="1.5" y="1" width="13" height="6" rx="1.5" fill={CAP[cap] ?? CAP.white} stroke="var(--c-line-strong)" strokeWidth="0.75" />
      <path d="M3 7h10v15a5 5 0 0 1-10 0z" fill="var(--c-surface)" stroke="var(--c-ink-2)" strokeWidth="1.2" />
      <path d="M4.2 16h7.6v6a3.8 3.8 0 0 1-7.6 0z" fill={CAP[cap] ?? CAP.white} opacity="0.35" />
    </svg>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 font-medium transition-colors',
            size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8 text-[13px]',
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className="rounded-full bg-line px-1.5 text-[11px] text-ink-2 tabular">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('');
  return <span className={cn('grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent', className)}>{initials}</span>;
}

export function Money({ value, currency, className }: { value: number | null | undefined; currency?: string; className?: string }) {
  const f = useFormat();
  return <span className={cn('tabular ltr-num whitespace-nowrap', className)}>{f.money(value, currency)}</span>;
}

/* ------------------------------------------------------------------ Tabs */

export const Tabs = RTabs.Root;
export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <RTabs.List className={cn('flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line', className)}>{children}</RTabs.List>;
}
export function TabsTrigger({ value, children, count }: { value: string; children: ReactNode; count?: number }) {
  return (
    <RTabs.Trigger
      value={value}
      className="-mb-px inline-flex h-10 items-center gap-2 border-b-2 border-transparent px-3 text-[13.5px] font-medium whitespace-nowrap text-muted transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink"
    >
      {children}
      {count !== undefined ? <span className="rounded-full bg-sunken px-1.5 text-[11px] text-ink-2 tabular">{count}</span> : null}
    </RTabs.Trigger>
  );
}
export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <RTabs.Content value={value} className={cn('pt-4 focus:outline-none', className)}>
      {children}
    </RTabs.Content>
  );
}

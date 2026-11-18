import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ErrorState, Skeleton } from '@/components/ui';
import type { DateRange } from '@/components/ui';
import { adminKeys } from '../../api';
import { ChartFrame } from '../charts';

/** One analytics report for the selected range; keeps the previous render while refetching. */
export function useReport<T>(report: string, range: DateRange) {
  return useQuery({
    queryKey: adminKeys.analytics(report, range),
    queryFn: () => api.get<T>(`/analytics/${report}`, range),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Loading, error and refetch states around a report body. */
export function ReportBody<T>({ query, children }: { query: { data?: T; error: unknown; isPlaceholderData: boolean; refetch: () => unknown }; children: (data: T) => ReactNode }) {
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data)
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-[var(--radius-card)]" />
          ))}
        </div>
        <Skeleton className="h-[280px] rounded-[var(--radius-card)]" />
      </div>
    );
  return (
    <ChartFrame fetching={query.isPlaceholderData} className="flex flex-col gap-4">
      {children(query.data)}
    </ChartFrame>
  );
}

/** Compact figure tile for report headers. */
export function Figure({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'crit' }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={cn('mt-0.5 text-[22px] leading-tight font-semibold tracking-tight text-ink', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', tone === 'crit' && 'text-crit')}>{value}</div>
      {hint ? <div className="mt-0.5 text-[12px] text-muted">{hint}</div> : null}
    </div>
  );
}

export function FigureRow({ children, cols = 5 }: { children: ReactNode; cols?: 3 | 4 | 5 | 6 }) {
  const grid = { 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 xl:grid-cols-4', 5: 'sm:grid-cols-3 xl:grid-cols-5', 6: 'sm:grid-cols-3 xl:grid-cols-6' }[cols];
  return <div className={cn('grid gap-3', grid)}>{children}</div>;
}

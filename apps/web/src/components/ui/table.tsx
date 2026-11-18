import { useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { EmptyState, ErrorState, Skeleton } from './display';

export type { ColumnDef } from '@tanstack/react-table';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    align?: 'start' | 'end' | 'center';
    className?: string;
    headerClassName?: string;
  }
}

export type PaginationState = { total: number; limit: number; offset: number; onChange: (offset: number) => void };

/**
 * Table with sticky header, client sorting, designed loading/empty/error states and optional
 * server pagination. Columns use TanStack ColumnDef; set meta.align = 'end' for numbers.
 */
export function DataTable<T>({
  columns,
  data,
  loading,
  error,
  onRetry,
  empty,
  onRowClick,
  getRowId,
  rowClassName,
  pagination,
  dense,
  className,
  initialSorting,
  maxHeight,
}: {
  columns: ColumnDef<T, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  data: T[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: LucideIcon };
  onRowClick?: (row: T) => void;
  getRowId?: (row: T, index: number) => string;
  rowClassName?: (row: T) => string | undefined | false;
  pagination?: PaginationState;
  dense?: boolean;
  className?: string;
  initialSorting?: SortingState;
  /** e.g. "60vh": scroll inside the table and keep the header visible. */
  maxHeight?: string;
}) {
  const { t } = useTranslation();
  const [sorting, setSorting] = useState<SortingState>(initialSorting ?? []);
  const table = useReactTable({
    data: data ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: getRowId ? (row, i) => getRowId(row, i) : undefined,
  });

  const cell = dense ? 'px-3 py-1.5' : 'px-3 py-2.5';
  const align = (a?: string) => (a === 'end' ? 'text-end' : a === 'center' ? 'text-center' : 'text-start');

  return (
    <div className={cn('min-w-0 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface', className)}>
      <div className="overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-sunken">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta;
                  const sortable = h.column.getCanSort() && h.column.columnDef.enableSorting !== false && !!h.column.accessorFn;
                  const dir = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      className={cn(
                        'border-b border-line text-[11.5px] font-semibold tracking-wide whitespace-nowrap text-muted uppercase',
                        cell,
                        align(meta?.align),
                        meta?.headerClassName,
                      )}
                      style={h.getSize() !== 150 ? { width: h.getSize() } : undefined}
                    >
                      {h.isPlaceholder ? null : sortable ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={h.column.getToggleSortingHandler()}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {dir === 'asc' ? <ArrowUp className="size-3" /> : dir === 'desc' ? <ArrowDown className="size-3" /> : null}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    {columns.map((_c, j) => (
                      <td key={j} className={cell}>
                        <Skeleton className="h-4 w-[70%]" />
                      </td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn(
                      'border-b border-line last:border-0',
                      onRowClick && 'cursor-pointer hover:bg-sunken/70',
                      rowClassName?.(row.original) || null,
                    )}
                  >
                    {row.getVisibleCells().map((c) => (
                      <td key={c.id} className={cn(cell, 'align-middle text-ink', align(c.column.columnDef.meta?.align), c.column.columnDef.meta?.className)}>
                        {flexRender(c.column.columnDef.cell, c.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
        {!loading && error ? <ErrorState error={error} onRetry={onRetry} /> : null}
        {!loading && !error && (data?.length ?? 0) === 0 ? (
          <EmptyState icon={empty?.icon} title={empty?.title ?? t('empty.title')} description={empty?.description} action={empty?.action} />
        ) : null}
      </div>
      {pagination && pagination.total > 0 ? <Pagination {...pagination} /> : null}
    </div>
  );
}

export function Pagination({ total, limit, offset, onChange }: PaginationState) {
  const { t } = useTranslation();
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 text-[12.5px] text-muted">
      <span className="tabular">{t('pagination.showing', { from, to, total })}</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))} aria-label={t('pagination.previous')}>
          <ChevronLeft className="rtl:rotate-180" />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={to >= total} onClick={() => onChange(offset + limit)} aria-label={t('pagination.next')}>
          <ChevronRight className="rtl:rotate-180" />
        </Button>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Clock, Printer, Trash2 } from 'lucide-react';
import type { OrderDetail, OrderItemRow } from '@natija/contracts';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useBi } from '@/lib/i18n';
import { openPrint } from '@/lib/print';
import { Badge, Button, Card, ConfirmDialog, DataTable, InfoList, StatusChip, Tooltip, TubeIcon, toast, type ColumnDef } from '@/components/ui';
import { fd, useRefresh } from '../api';
import { useFdError } from './shared';

const DONE = new Set(['released', 'cancelled', 'rejected']);

/** Lines with their tube, status and result progress; the order's tubes; clinical details. */
export function OrderOverview({ order }: { order: OrderDetail }) {
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const now = useNow(60_000);
  const errorText = useFdError();
  const refresh = useRefresh();
  const [removing, setRemoving] = useState<OrderItemRow | null>(null);
  const active = order.items.filter((i) => i.status !== 'cancelled');
  const canRemove = (i: OrderItemRow) =>
    can('orders.edit') && order.status !== 'cancelled' && i.status !== 'cancelled' && i.resultCounts.total === i.resultCounts.pending && active.length > 1;

  const remove = useMutation({
    mutationFn: ({ item, reason }: { item: OrderItemRow; reason: string }) => fd.removeItem(order.id, item.id, reason),
    onSuccess: () => {
      toast.success(t('overview.removed'));
      void refresh.orders();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const columns = useMemo<ColumnDef<OrderItemRow>[]>(
    () => [
      {
        id: 'test',
        header: t('overview.col.test'),
        accessorKey: 'code',
        cell: ({ row }) => {
          const i = row.original;
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="w-14 shrink-0 font-mono text-[12px] font-medium ltr-num">{i.code}</span>
              <span className={i.status === 'cancelled' ? 'truncate text-muted line-through' : 'truncate'}>{bi(i)}</span>
              {i.packageCode ? <Badge tone="violet">{i.packageCode}</Badge> : null}
              {i.isExternal ? <Badge tone="info">{t('overview.external')}</Badge> : null}
            </div>
          );
        },
      },
      { id: 'dept', header: t('overview.col.department'), cell: ({ row }) => <span className="text-[12.5px] text-ink-2">{bi({ nameAr: row.original.departmentNameAr, nameEn: row.original.departmentNameEn })}</span> },
      {
        id: 'tube',
        header: t('overview.col.tube'),
        cell: ({ row }) =>
          row.original.barcode ? (
            <span className="inline-flex items-center gap-1.5">
              <TubeIcon cap={row.original.capColor ?? 'white'} className="h-5 w-3" />
              <span className="font-mono text-[12px] ltr-num">{row.original.barcode.slice(-2)}</span>
            </span>
          ) : (
            <span className="text-faint">—</span>
          ),
      },
      { id: 'status', header: t('overview.col.status'), accessorKey: 'status', cell: ({ row }) => <StatusChip kind="item" status={row.original.status} /> },
      {
        id: 'results',
        header: t('overview.col.results'),
        cell: ({ row }) => {
          const c = row.original.resultCounts;
          if (!c.total) return <span className="text-faint">—</span>;
          return (
            <span className="inline-flex items-center gap-1.5">
              <Tooltip content={t('overview.resultsHint')}>
                <span className="tabular ltr-num">
                  {c.validated + c.released}/{c.total}
                </span>
              </Tooltip>
              {c.critical ? <Badge tone="crit">{t('orders.critical')}</Badge> : null}
            </span>
          );
        },
      },
      {
        id: 'due',
        header: t('overview.col.due'),
        cell: ({ row }) => {
          const i = row.original;
          if (DONE.has(i.status) || order.status === 'cancelled') return <span className="text-faint">—</span>;
          const late = new Date(i.dueAt) < now;
          return (
            <span className={late ? 'inline-flex items-center gap-1 font-medium text-warn' : 'text-ink-2'}>
              {late ? <Clock className="size-3.5" /> : null}
              <span className="tabular">{f.dateTime(i.dueAt)}</span>
            </span>
          );
        },
      },
      { id: 'price', header: t('overview.col.price'), meta: { align: 'end' }, cell: ({ row }) => <span className="tabular ltr-num">{f.money(row.original.price - row.original.discount)}</span> },
      {
        id: 'actions',
        header: '',
        size: 44,
        cell: ({ row }) =>
          canRemove(row.original) ? (
            <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(row.original)} aria-label={t('overview.remove', { code: row.original.code })}>
              <Trash2 />
            </Button>
          ) : null,
      },
    ],
    [t, f, bi, now, order.status, active.length], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card title={t('overview.lines')} description={t('overview.linesCount', { count: active.length })} padded={false}>
        <DataTable columns={columns} data={order.items} dense className="rounded-none border-0" getRowId={(i) => i.id} rowClassName={(i) => (i.status === 'cancelled' ? 'opacity-60' : undefined)} />
      </Card>
      <div className="flex flex-col gap-4">
        <Card
          title={t('overview.tubes')}
          actions={
            order.tubes.length && order.status !== 'cancelled' ? (
              <Button size="sm" variant="ghost" onClick={() => openPrint(`/print/labels/${order.id}`)}>
                <Printer />
                {t('actions.printLabels')}
              </Button>
            ) : null
          }
        >
          {order.tubes.length ? (
            <ul className="flex flex-col gap-2">
              {order.tubes.map((tube) => (
                <li key={tube.id} className="flex items-start gap-2.5 rounded-lg border border-line px-3 py-2">
                  <TubeIcon cap={tube.capColor} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[12.5px] font-medium text-ink ltr-num">{tube.barcode}</span>
                      <StatusChip kind="sample" status={tube.status} />
                    </div>
                    <p className="text-[12px] text-muted">
                      {bi({ nameAr: tube.containerNameAr, nameEn: tube.containerNameEn })} · {bi({ nameAr: tube.sampleTypeNameAr, nameEn: tube.sampleTypeNameEn })}
                    </p>
                    <p className="truncate font-mono text-[11.5px] text-ink-2 ltr-num">{tube.testCodes.join(' · ') || '—'}</p>
                    <p className="text-[11.5px] text-muted">
                      {tube.receivedAt
                        ? t('overview.receivedAt', { at: f.dateTime(tube.receivedAt) })
                        : tube.collectedAt
                          ? t('overview.collectedAt', { at: f.dateTime(tube.collectedAt) })
                          : tube.labelPrintedAt
                            ? t('overview.labelPrintedAt', { at: f.time(tube.labelPrintedAt) })
                            : t('overview.labelNotPrinted')}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">{t('overview.noTubes')}</p>
          )}
        </Card>
        <Card title={t('overview.details')}>
          <InfoList
            columns={1}
            items={[
              { label: t('order.clinicalInfo'), value: order.clinicalInfo ? <span className="whitespace-pre-line">{order.clinicalInfo}</span> : '—' },
              {
                label: t('overview.flags'),
                value:
                  order.fasting || order.pregnant ? (
                    <span className="flex flex-wrap gap-1">
                      {order.fasting ? <Badge tone="info">{t('order.fasting')}</Badge> : null}
                      {order.pregnant ? <Badge tone="violet">{t('order.pregnant')}</Badge> : null}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              { label: t('order.source'), value: `${t(`order.sources.${order.source}`)}${order.externalRef ? ` · ${order.externalRef}` : ''}` },
              { label: t('order.referralClinic'), value: order.referralClinic ?? '—' },
              { label: t('order.delivery'), value: t(`order.channels.${order.deliveryChannel}`) },
              { label: t('order.branch'), value: order.branch ? bi(order.branch) : '—' },
              { label: t('order.notes'), value: order.notes ? <span className="whitespace-pre-line">{order.notes}</span> : '—' },
            ]}
          />
        </Card>
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('overview.removeTitle', { code: removing?.code ?? '' })}
        description={t('overview.removeDescription')}
        tone="danger"
        reason="required"
        confirmLabel={t('overview.removeConfirm')}
        onConfirm={async (reason) => {
          if (removing) await remove.mutateAsync({ item: removing, reason: reason! }).catch(() => undefined);
        }}
      />
    </div>
  );
}

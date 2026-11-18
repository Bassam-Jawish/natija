import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban, FileWarning, MoreHorizontal, Pencil, Plus, Printer, Receipt, Wallet } from 'lucide-react';
import { OrderReportsPanel, OrderResultsPanel, OrderSamplesPanel } from '@/features/bench/order-panels';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { useBi } from '@/lib/i18n';
import { openPrint } from '@/lib/print';
import {
  Button,
  ConfirmDialog,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PageHeader,
  Skeleton,
  StatusChip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@/components/ui';
import { fd, useOrder, useRefresh } from '../api';
import { ActivityTimeline } from '../components/ActivityTimeline';
import { OrderBilling } from '../components/OrderBilling';
import { AddTestsDrawer, EditOrderDialog } from '../components/OrderEdit';
import { OrderOverview } from '../components/OrderOverview';
import { TakePaymentDialog } from '../components/PaymentDialogs';
import { Accession, CriticalBadge, DailyNo, FdErrorState, LinkButton, Notice, PatientLink, PatientMeta, useFdError, usePatientName } from '../components/shared';

const TABS = ['overview', 'samples', 'results', 'reports', 'billing', 'activity'] as const;
type Tab = (typeof TABS)[number];

/** One order: header with the desk actions, then overview, tubes, results, reports, billing and history. */
export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation('frontdesk');
  const { can } = useAuth();
  const f = useFormat();
  const bi = useBi();
  const name = usePatientName();
  const errorText = useFdError();
  const refresh = useRefresh();
  const [sp, setSp] = useSearchParams();
  const order = useOrder(id);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [paying, setPaying] = useState(false);

  const fromUrl = sp.get('tab') as Tab | null;
  const tab: Tab = fromUrl && TABS.includes(fromUrl) ? fromUrl : sp.has('tube') ? 'samples' : 'overview';
  const setTab = (next: string) => {
    const p = new URLSearchParams(sp);
    p.set('tab', next);
    setSp(p, { replace: true });
  };

  const cancel = useMutation({
    mutationFn: (reason: string) => fd.cancelOrder(id!, reason),
    onSuccess: (r) => {
      toast.success(t('cancel.done'), { description: r.refundDue > 0 ? t('cancel.refundDue', { amount: f.money(r.refundDue) }) : r.invoiceVoided ? t('cancel.voided') : undefined });
      void refresh.orders();
      void refresh.finance();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  if (order.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-10" />
        <Skeleton className="h-[360px]" />
      </div>
    );
  }
  if (order.error || !order.data) {
    return (
      <>
        <PageHeader title={t('order.title')} back="/orders" />
        <div className="rounded-[var(--radius-card)] border border-line bg-surface">
          <NotFoundOrError error={order.error} onRetry={() => order.refetch()} />
        </div>
      </>
    );
  }

  const o = order.data;
  const cancelled = o.status === 'cancelled';
  const inv = o.invoice;
  const canPay = !!inv && inv.status !== 'void' && inv.balance > 0 && can('finance.payment');
  const results = o.resultCounts;

  return (
    <>
      <PageHeader
        back="/orders"
        title={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[13px] font-medium text-muted">{t('order.number')}</span>
            <DailyNo value={o.dailyNo} size="lg" />
            <Accession value={o.accession} className="text-[14px]" />
          </span>
        }
        meta={
          <>
            <StatusChip kind="order" status={o.status} />
            {o.priority !== 'routine' ? <StatusChip kind="priority" status={o.priority} /> : null}
            {results.critical ? <CriticalBadge /> : null}
            {inv ? <StatusChip kind="invoice" status={inv.status} /> : null}
            <span className="text-[12.5px] text-muted">
              {t('order.createdAtBy', { at: f.dateTime(o.createdAt), by: o.createdBy ? bi({ nameAr: o.createdBy.fullNameAr, nameEn: o.createdBy.fullNameEn }) : '—' })}
            </span>
          </>
        }
        actions={
          <>
            <Button onClick={() => openPrint(`/print/labels/${o.id}`)} disabled={cancelled || !o.tubes.length}>
              <Printer />
              {t('actions.printLabels')}
            </Button>
            <Button onClick={() => openPrint(`/print/receipt/${o.id}`)}>
              <Receipt />
              {t('actions.printReceipt')}
            </Button>
            {canPay ? (
              <Button variant="primary" onClick={() => setPaying(true)}>
                <Wallet />
                {t('actions.takePayment')}
              </Button>
            ) : null}
            {can('orders.edit') && !cancelled ? (
              <Button onClick={() => setAdding(true)}>
                <Plus />
                {t('actions.addTests')}
              </Button>
            ) : null}
            {(can('orders.edit') || can('orders.cancel')) && !cancelled ? (
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t('common:actions.more')}>
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {can('orders.edit') ? (
                    <MenuItem onSelect={() => setEditing(true)}>
                      <Pencil />
                      {t('actions.edit')}
                    </MenuItem>
                  ) : null}
                  {can('orders.cancel') ? (
                    <MenuItem danger disabled={!o.cancellable} onSelect={() => setCancelling(true)}>
                      <Ban />
                      {o.cancellable ? t('actions.cancelOrder') : t('cancel.notAllowed')}
                    </MenuItem>
                  ) : null}
                </MenuContent>
              </Menu>
            ) : null}
          </>
        }
      />

      <div className="mb-4 grid gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className="text-[12px] text-muted">{t('order.patient')}</p>
          <PatientLink p={o.patient} className="text-[15px]" />
          <div>
            <PatientMeta p={o.patient} />
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-[12px] text-muted">{t('order.doctor')}</p>
          <p className="truncate text-[13.5px] text-ink">{o.doctor ? bi(o.doctor) : t('order.noDoctor')}</p>
          {o.doctor?.clinic ? <p className="truncate text-[12px] text-muted">{o.doctor.clinic}</p> : null}
        </div>
        <div className="min-w-0">
          <p className="text-[12px] text-muted">{t('order.payer')}</p>
          <p className="truncate text-[13.5px] text-ink">{bi(o.payer)}</p>
          {o.payer.patientSharePct < 100 ? <p className="text-[12px] text-muted">{t('order.patientShare', { pct: o.payer.patientSharePct })}</p> : null}
        </div>
      </div>

      {cancelled ? (
        <Notice tone="crit" icon={<Ban />} title={t('cancel.banner')} className="mb-4">
          {t('cancel.bannerDetail', {
            reason: o.cancelReason ?? '—',
            by: o.cancelledBy ? bi({ nameAr: o.cancelledBy.fullNameAr, nameEn: o.cancelledBy.fullNameEn }) : '—',
            at: f.dateTime(o.cancelledAt),
          })}
        </Notice>
      ) : null}
      {o.patient.notes ? (
        <Notice tone="info" icon={<FileWarning />} title={t('patient.notes')} className="mb-4">
          <span className="whitespace-pre-line">{o.patient.notes}</span>
        </Notice>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="overflow-y-hidden">
          <TabsTrigger value="overview" count={o.items.filter((i) => i.status !== 'cancelled').length}>
            {t('tabs.overview')}
          </TabsTrigger>
          <TabsTrigger value="samples" count={o.tubes.length}>
            {t('tabs.samples')}
          </TabsTrigger>
          <TabsTrigger value="results" count={results.total ? results.validated + results.released : undefined}>
            {t('tabs.results')}
          </TabsTrigger>
          <TabsTrigger value="reports">{t('tabs.reports')}</TabsTrigger>
          <TabsTrigger value="billing">{t('tabs.billing')}</TabsTrigger>
          <TabsTrigger value="activity">{t('tabs.activity')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OrderOverview order={o} />
        </TabsContent>
        <TabsContent value="samples">
          <OrderSamplesPanel orderId={o.id} />
        </TabsContent>
        <TabsContent value="results">
          <OrderResultsPanel orderId={o.id} />
        </TabsContent>
        <TabsContent value="reports">
          <OrderReportsPanel orderId={o.id} />
        </TabsContent>
        <TabsContent value="billing">
          <OrderBilling invoice={inv} orderId={o.id} cancelled={cancelled} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTimeline orderId={o.id} />
        </TabsContent>
      </Tabs>

      <EditOrderDialog order={o} open={editing} onOpenChange={setEditing} />
      <AddTestsDrawer order={o} open={adding} onOpenChange={setAdding} />
      {inv ? <TakePaymentDialog open={paying} onOpenChange={setPaying} invoice={{ id: inv.id, number: inv.number, balance: inv.balance }} /> : null}
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        tone="danger"
        reason="required"
        title={t('cancel.title', { accession: o.accession })}
        description={
          inv && inv.paidTotal > 0
            ? t('cancel.descriptionPaid', { name: name(o.patient), amount: f.money(inv.paidTotal) })
            : t('cancel.description', { name: name(o.patient) })
        }
        confirmLabel={t('actions.cancelOrder')}
        onConfirm={async (reason) => {
          await cancel.mutateAsync(reason!).catch(() => undefined);
        }}
      />
    </>
  );
}

function NotFoundOrError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('frontdesk');
  const status = (error as { status?: number } | null)?.status;
  if (status === 404) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <p className="text-[15px] font-medium text-ink">{t('order.notFound')}</p>
        <p className="max-w-md text-[13px] text-muted">{t('order.notFoundHint')}</p>
        <LinkButton to="/orders" size="sm" className="mt-2">
          {t('orders.title')}
        </LinkButton>
      </div>
    );
  }
  return <FdErrorState error={error} onRetry={onRetry} />;
}


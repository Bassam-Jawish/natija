import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { OrderDetail, OrderItemInput } from '@natija/contracts';
import { useFormat } from '@/lib/format';
import { openPrint } from '@/lib/print';
import { Button, Dialog, Drawer, Skeleton, toast } from '@/components/ui';
import { fd, useFormData, useQuote, useRefresh } from '../api';
import { OrderDetailsFields, type OrderDetailsValue } from './OrderDetailsFields';
import { QuoteLines } from './QuoteLines';
import { itemKey, TestPicker } from './TestPicker';
import { apiCode, Notice, useFdError } from './shared';

function fromOrder(o: OrderDetail): OrderDetailsValue {
  return {
    doctorId: o.doctor?.id ?? null,
    referralClinic: o.referralClinic ?? '',
    priority: o.priority,
    source: o.source,
    externalRef: o.externalRef ?? '',
    deliveryChannel: o.deliveryChannel,
    fasting: o.fasting,
    pregnant: o.pregnant,
    branchId: o.branch?.id ?? null,
    clinicalInfo: o.clinicalInfo ?? '',
    notes: o.notes ?? '',
  };
}

/** Edit the order header. Saving with an outdated version is refused, so nobody overwrites a colleague. */
export function EditOrderDialog({ order, open, onOpenChange }: { order: OrderDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('frontdesk');
  const errorText = useFdError();
  const refresh = useRefresh();
  const { data: form } = useFormData();
  const [v, setV] = useState<OrderDetailsValue>(() => fromOrder(order));
  useEffect(() => {
    if (open) setV(fromOrder(order));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () =>
      fd.updateOrder(order.id, {
        version: order.version,
        doctorId: v.doctorId,
        referralClinic: v.referralClinic.trim() || null,
        priority: v.priority,
        externalRef: v.externalRef.trim() || null,
        deliveryChannel: v.deliveryChannel,
        fasting: v.fasting,
        pregnant: order.patient.sex === 'female' ? v.pregnant : false,
        clinicalInfo: v.clinicalInfo.trim() || null,
        notes: v.notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success(t('edit.saved'));
      void refresh.orders();
      onOpenChange(false);
    },
    onError: (err) => {
      if (apiCode(err) === 'version_conflict') void refresh.orders();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={t('edit.title', { accession: order.accession })}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common:actions.saveChanges')}
          </Button>
        </>
      }
    >
      {form ? (
        <div className="flex flex-col gap-3">
          <OrderDetailsFields form={form} value={v} onChange={setV} female={order.patient.sex === 'female'} showBranch={false} lockSource />
          {save.error ? <Notice tone="crit">{errorText(save.error)}</Notice> : null}
        </div>
      ) : (
        <Skeleton className="h-72" />
      )}
    </Dialog>
  );
}

/** Add tests to an existing order; the price preview uses the order's payer. */
export function AddTestsDrawer({ order, open, onOpenChange }: { order: OrderDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('frontdesk');
  const f = useFormat();
  const errorText = useFdError();
  const refresh = useRefresh();
  const { data: form } = useFormData();
  const [items, setItems] = useState<OrderItemInput[]>([]);
  useEffect(() => {
    if (open) setItems([]);
  }, [open]);
  const inOrder = useMemo(() => new Set(order.items.filter((i) => i.status !== 'cancelled').map((i) => i.testId)), [order.items]);
  const quote = useQuote(items.length ? { payerGroupId: order.payer.id, items } : null);
  const q = items.length ? quote.data : undefined;
  const add = useMutation({
    mutationFn: () => fd.addItems(order.id, items),
    onSuccess: (r) => {
      toast.success(t('addTests.done', { count: r.added }), {
        description: r.newTubes ? t('addTests.newTubes', { count: r.newTubes }) : undefined,
        action: r.newTubes ? { label: t('actions.printLabels'), onClick: () => openPrint(`/print/labels/${order.id}`) } : undefined,
      });
      void refresh.orders();
      onOpenChange(false);
    },
  });
  const toggle = (item: OrderItemInput) =>
    setItems((list) => {
      const k = itemKey(item);
      if (list.some((x) => itemKey(x) === k)) return list.filter((x) => itemKey(x) !== k);
      if ('packageId' in item && form) {
        const inside = new Set(form.packages.find((p) => p.id === item.packageId)?.testIds ?? []);
        return [...list.filter((x) => !('testId' in x && inside.has(x.testId))), item];
      }
      return [...list, item];
    });
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title={t('addTests.title')}
      description={t('addTests.description', { accession: order.accession })}
      footer={
        <>
          {q ? <span className="me-auto text-[13px] text-muted">{t('addTests.extra', { amount: f.money(q.totals.patientTotal) })}</span> : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" loading={add.isPending} disabled={!items.length} onClick={() => add.mutate()}>
            {t('addTests.confirm', { count: q?.lines.length ?? items.length })}
          </Button>
        </>
      }
    >
      {form ? (
        <div className="flex flex-col gap-4">
          <TestPicker form={form} payerGroupId={order.payer.id} selected={items} onToggle={toggle} inOrderTestIds={inOrder} maxHeight="max-h-[46vh]" />
          <QuoteLines quote={q} loading={quote.isFetching} stale={quote.isPlaceholderData} onRemove={toggle} showTubes={false} />
          <p className="text-[12.5px] text-muted">{t('addTests.tubeHint')}</p>
          {add.error ? <Notice tone="crit">{errorText(add.error)}</Notice> : null}
        </div>
      ) : (
        <Skeleton className="h-96" />
      )}
    </Drawer>
  );
}

/** Order and line statuses from results and tubes (port of apps/api/src/services/order-status.ts). */
import { deriveItemStatus, deriveOrderStatus, type ItemStatus, type OrderStatus, type ResultStatus, type SampleStatus } from '@natija/domain';
import { now } from '../../core/context';
import { by, find, update } from '../../core/db';
import { publish } from '../../core/lib';

/** Recompute every line status of an order, then the order status. Call after results or tubes change. */
export function refreshOrderStatus(orderId: string): { status: string } {
  const order = find('orders', orderId);
  if (!order) return { status: 'missing' };
  const items = by('orderItems', 'orderId', orderId);
  const resultRows = by('results', 'orderId', orderId);
  const byItem = new Map<string, Array<{ status: ResultStatus; hasValue: boolean }>>();
  for (const r of resultRows) {
    const list = byItem.get(r.orderItemId) ?? [];
    list.push({ status: r.status as ResultStatus, hasValue: r.valueNum !== null || (r.valueText ?? '') !== '' });
    byItem.set(r.orderItemId, list);
  }
  const newStatuses: Array<{ status: ItemStatus }> = [];
  for (const item of items) {
    const sample = item.sampleId ? find('samples', item.sampleId) : undefined;
    const next = deriveItemStatus(byItem.get(item.id) ?? [], (sample?.status as SampleStatus | undefined) ?? null, item.status as ItemStatus);
    newStatuses.push({ status: next });
    if (next !== item.status) {
      update('orderItems', item, { status: next, releasedAt: next === 'released' ? (item.releasedAt ?? now()) : item.releasedAt });
    }
  }
  const status = deriveOrderStatus(newStatuses, order.status as OrderStatus);
  if (status !== order.status) {
    update('orders', order, {
      status,
      completedAt: status === 'completed' ? (order.completedAt ?? now()) : order.completedAt,
      updatedAt: now(),
      version: order.version + 1,
    });
    publish({ type: 'orders.changed', data: { orderId, status } });
  }
  return { status };
}

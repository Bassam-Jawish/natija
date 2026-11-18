import { eq, inArray, sql } from 'drizzle-orm';
import { orderItems, orders, results, samples } from '@natija/db';
import { deriveItemStatus, deriveOrderStatus, type ItemStatus, type ResultStatus, type SampleStatus } from '@natija/domain';
import { db } from '../db';
import { publish } from '../lib/events';

/**
 * Recompute every line status of an order from its results and tubes, then the order status.
 * Call after anything that changes results or tubes.
 */
export async function refreshOrderStatus(orderId: string): Promise<{ status: string }> {
  const tx = db();
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
  if (!order) return { status: 'missing' };

  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const sampleIds = items.map((i) => i.sampleId).filter((x): x is string => !!x);
  const sampleRows = sampleIds.length
    ? await tx.select({ id: samples.id, status: samples.status }).from(samples).where(inArray(samples.id, sampleIds))
    : [];
  const sampleStatus = new Map(sampleRows.map((s) => [s.id, s.status as SampleStatus]));
  const resultRows = await tx
    .select({ itemId: results.orderItemId, status: results.status, valueNum: results.valueNum, valueText: results.valueText })
    .from(results)
    .where(eq(results.orderId, orderId));

  const byItem = new Map<string, Array<{ status: ResultStatus; hasValue: boolean }>>();
  for (const r of resultRows) {
    const list = byItem.get(r.itemId) ?? [];
    list.push({ status: r.status as ResultStatus, hasValue: r.valueNum !== null || (r.valueText ?? '') !== '' });
    byItem.set(r.itemId, list);
  }

  const newStatuses: Array<{ status: ItemStatus }> = [];
  for (const item of items) {
    const next = deriveItemStatus(byItem.get(item.id) ?? [], item.sampleId ? sampleStatus.get(item.sampleId) ?? null : null, item.status as ItemStatus);
    newStatuses.push({ status: next });
    if (next !== item.status) {
      await tx
        .update(orderItems)
        .set({ status: next, releasedAt: next === 'released' ? item.releasedAt ?? new Date() : item.releasedAt })
        .where(eq(orderItems.id, item.id));
    }
  }

  const status = deriveOrderStatus(newStatuses, order.status);
  if (status !== order.status) {
    await tx
      .update(orders)
      .set({
        status,
        completedAt: status === 'completed' ? order.completedAt ?? new Date() : order.completedAt,
        updatedAt: new Date(),
        version: sql`${orders.version} + 1`,
      })
      .where(eq(orders.id, orderId));
    publish({ type: 'orders.changed', data: { orderId, status } });
  }
  return { status };
}

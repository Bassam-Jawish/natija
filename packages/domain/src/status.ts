export type OrderStatus = 'registered' | 'collected' | 'in_progress' | 'partial' | 'completed' | 'delivered' | 'cancelled';
export type ItemStatus =
  | 'ordered' | 'collected' | 'received' | 'in_analysis' | 'resulted'
  | 'verified' | 'validated' | 'released' | 'rejected' | 'cancelled';
export type SampleStatus = 'pending' | 'collected' | 'in_transit' | 'received' | 'rejected' | 'in_analysis' | 'stored' | 'disposed';
export type ResultStatus = 'pending' | 'resulted' | 'verified' | 'validated' | 'released';

const RESULT_RANK: Record<ResultStatus, number> = { pending: 0, resulted: 1, verified: 2, validated: 3, released: 4 };

/** Status of one order line from its results and its tube. */
export function deriveItemStatus(
  results: Array<{ status: ResultStatus; hasValue: boolean }>,
  sampleStatus: SampleStatus | null,
  current: ItemStatus,
): ItemStatus {
  if (current === 'cancelled') return 'cancelled';
  if (sampleStatus === 'rejected') return 'rejected';
  if (results.length) {
    const min = Math.min(...results.map((r) => RESULT_RANK[r.status]));
    if (min === 4) return 'released';
    if (min === 3) return 'validated';
    if (min === 2) return 'verified';
    if (min === 1) return 'resulted';
    if (results.some((r) => r.hasValue)) return 'in_analysis';
  }
  switch (sampleStatus) {
    case 'in_analysis':
      return 'in_analysis';
    case 'received':
    case 'stored':
      return 'received';
    case 'collected':
    case 'in_transit':
      return 'collected';
    default:
      return 'ordered';
  }
}

/** Status of a whole order from its lines. "delivered" sticks once the report has been handed over. */
export function deriveOrderStatus(items: Array<{ status: ItemStatus }>, current: OrderStatus): OrderStatus {
  if (current === 'cancelled') return 'cancelled';
  const active = items.filter((i) => i.status !== 'cancelled');
  if (!active.length) return 'cancelled';
  const released = active.filter((i) => i.status === 'released').length;
  if (released === active.length) return current === 'delivered' ? 'delivered' : 'completed';
  if (released > 0) return 'partial';
  const working: ItemStatus[] = ['received', 'in_analysis', 'resulted', 'verified', 'validated'];
  if (active.some((i) => working.includes(i.status))) return 'in_progress';
  if (active.every((i) => i.status !== 'ordered')) return 'collected';
  return 'registered';
}

export const RESULT_EDITABLE: ResultStatus[] = ['pending', 'resulted', 'verified'];

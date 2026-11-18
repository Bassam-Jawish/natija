export type TubeInput = {
  /** Caller's key for the order line (e.g. a temporary id). */
  key: string;
  containerId: string;
  sampleTypeId: string;
  departmentId: string | null;
  separateTube: boolean;
};

export type TubePlan = {
  containerId: string;
  sampleTypeId: string;
  /** Set when every test in the tube belongs to one department; null when shared. */
  departmentId: string | null;
  itemKeys: string[];
};

/**
 * Group order lines into tubes: one tube per container and specimen type, unless a test
 * needs its own tube. Order of first appearance is kept so tube numbers are stable.
 */
export function groupIntoTubes(items: TubeInput[]): TubePlan[] {
  const tubes: TubePlan[] = [];
  const shared = new Map<string, TubePlan>();
  for (const item of items) {
    if (item.separateTube) {
      tubes.push({ containerId: item.containerId, sampleTypeId: item.sampleTypeId, departmentId: item.departmentId, itemKeys: [item.key] });
      continue;
    }
    const k = `${item.containerId}|${item.sampleTypeId}`;
    const existing = shared.get(k);
    if (existing) {
      existing.itemKeys.push(item.key);
      if (existing.departmentId !== item.departmentId) existing.departmentId = null;
    } else {
      const tube: TubePlan = { containerId: item.containerId, sampleTypeId: item.sampleTypeId, departmentId: item.departmentId, itemKeys: [item.key] };
      shared.set(k, tube);
      tubes.push(tube);
    }
  }
  return tubes;
}

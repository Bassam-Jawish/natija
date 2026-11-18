/**
 * Tubes waiting for an analyzer (port of pendingWork and testCodes in
 * apps/api/src/modules/agent-api/worklist.ts). The rest of the agent API is not ported: mock
 * mode has no Lab Agent; the simulator reads this worklist to pick what to report.
 */
import { now } from '../../core/context';
import { by, find, type Row } from '../../core/db';

export type PendingTube = {
  sampleId: string;
  barcode: string;
  status: string;
  orderId: string;
  accession: string;
  priority: 'routine' | 'urgent' | 'stat';
  sex: 'male' | 'female';
  birthDate: string;
  collectedAt: Date | null;
  /** Pending results this analyzer can measure, with the instrument's code for each. */
  tests: Array<{ code: string; analyteId: string; analyteCode: string; resultId: string }>;
};

const PRIORITY_RANK = { stat: 0, urgent: 1, routine: 2 } as const;
const rank = (p: string) => PRIORITY_RANK[p as keyof typeof PRIORITY_RANK] ?? 2;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Joined = { sample: Row<'samples'>; order: Row<'orders'>; patient: Row<'patients'>; result: Row<'results'>; analyte: Row<'analytes'>; code: string };

/**
 * Tubes waiting for an analyzer: collected/received/in-analysis tubes with pending results
 * for analytes mapped to it. With `barcodes`, those tubes only (any status but rejected or
 * disposed). No patient names: sex and birth date are all an analyzer may need.
 */
export function pendingWork(instrumentId: string, opts: { limit?: number; barcodes?: string[]; sinceDays?: number } = {}): PendingTube[] {
  const limit = opts.limit ?? 50;
  const since = now().getTime() - (opts.sinceDays ?? 14) * 86_400_000;
  const byBarcode = !!opts.barcodes?.length;

  const mapsByAnalyte = new Map<string, Array<Row<'instrumentMappings'>>>();
  for (const m of by('instrumentMappings', 'instrumentId', instrumentId)) {
    if (!m.isActive) continue;
    const list = mapsByAnalyte.get(m.analyteId) ?? [];
    list.push(m);
    mapsByAnalyte.set(m.analyteId, list);
  }
  if (!mapsByAnalyte.size) return [];

  const candidates = byBarcode
    ? opts.barcodes!.flatMap((b) => by('samples', 'barcode', b)).filter((s) => s.status !== 'rejected' && s.status !== 'disposed')
    : (['collected', 'received', 'in_analysis'] as const).flatMap((status) => by('samples', 'status', status));
  const tubesToScan = [...new Map(candidates.map((s) => [s.id, s])).values()];

  const joined: Joined[] = [];
  for (const sample of tubesToScan) {
    for (const line of by('orderItems', 'sampleId', sample.id)) {
      if (line.status === 'cancelled' || line.status === 'rejected') continue;
      for (const result of by('results', 'orderItemId', line.id)) {
        if (result.status !== 'pending') continue;
        const maps = mapsByAnalyte.get(result.analyteId);
        if (!maps) continue;
        const order = find('orders', result.orderId);
        if (!order || order.status === 'cancelled') continue;
        if (!byBarcode && order.createdAt.getTime() < since) continue;
        const patient = find('patients', order.patientId);
        const analyte = find('analytes', result.analyteId);
        if (!patient || !analyte) continue;
        for (const m of maps) joined.push({ sample, order, patient, result, analyte, code: m.instrumentCode });
      }
    }
  }
  joined.sort(
    (a, b) =>
      rank(a.order.priority) - rank(b.order.priority) ||
      a.order.createdAt.getTime() - b.order.createdAt.getTime() ||
      a.sample.seq - b.sample.seq ||
      cmp(a.code, b.code) ||
      cmp(b.result.id, a.result.id),
  );

  const tubes = new Map<string, PendingTube>();
  const seenResult = new Set<string>();
  for (const r of joined.slice(0, 5000)) {
    if (seenResult.has(r.result.id)) continue;
    seenResult.add(r.result.id);
    let tube = tubes.get(r.sample.id);
    if (!tube) {
      if (tubes.size >= limit) continue;
      tube = {
        sampleId: r.sample.id,
        barcode: r.sample.barcode,
        status: r.sample.status,
        orderId: r.order.id,
        accession: r.order.accession,
        priority: r.order.priority,
        sex: r.patient.sex,
        birthDate: r.patient.birthDate,
        collectedAt: r.sample.collectedAt,
        tests: [],
      };
      tubes.set(r.sample.id, tube);
    }
    tube.tests.push({ code: r.code, analyteId: r.analyte.id, analyteCode: r.analyte.code, resultId: r.result.id });
  }
  return [...tubes.values()].sort((a, b) => rank(a.priority) - rank(b.priority));
}

/** Distinct instrument codes of a tube's pending work (one code per analyte). */
export function testCodes(tube: PendingTube): string[] {
  return [...new Set(tube.tests.map((t) => t.code))];
}

import { and, asc, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { analytes, instrumentMappings, orderItems, orders, patients, results, samples } from '@natija/db';
import { db } from '../../db';

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

/**
 * Tubes waiting for an analyzer: collected/received/in-analysis tubes with pending results
 * for analytes mapped to it. With `barcodes`, those tubes only (any status but rejected or
 * disposed). No patient names: sex and birth date are all an analyzer may need.
 */
export async function pendingWork(instrumentId: string, opts: { limit?: number; barcodes?: string[]; sinceDays?: number } = {}): Promise<PendingTube[]> {
  const limit = opts.limit ?? 50;
  const since = new Date(Date.now() - (opts.sinceDays ?? 14) * 86_400_000);
  const tubeFilter = opts.barcodes?.length
    ? and(inArray(samples.barcode, opts.barcodes), notInArray(samples.status, ['rejected', 'disposed']))
    : and(inArray(samples.status, ['collected', 'received', 'in_analysis']), gte(orders.createdAt, since));
  const rows = await db()
    .select({
      sampleId: samples.id,
      barcode: samples.barcode,
      status: samples.status,
      collectedAt: samples.collectedAt,
      orderId: orders.id,
      accession: orders.accession,
      priority: orders.priority,
      createdAt: orders.createdAt,
      sex: patients.sex,
      birthDate: patients.birthDate,
      resultId: results.id,
      analyteId: analytes.id,
      analyteCode: analytes.code,
      code: instrumentMappings.instrumentCode,
    })
    .from(results)
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .innerJoin(samples, eq(samples.id, orderItems.sampleId))
    .innerJoin(orders, eq(orders.id, results.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(analytes, eq(analytes.id, results.analyteId))
    .innerJoin(
      instrumentMappings,
      and(eq(instrumentMappings.analyteId, results.analyteId), eq(instrumentMappings.instrumentId, instrumentId), eq(instrumentMappings.isActive, true)),
    )
    .where(
      and(
        eq(results.status, 'pending'),
        notInArray(orderItems.status, ['cancelled', 'rejected']),
        sql`${orders.status} <> 'cancelled'`,
        tubeFilter,
      ),
    )
    .orderBy(sql`case ${orders.priority} when 'stat' then 0 when 'urgent' then 1 else 2 end`, asc(orders.createdAt), asc(samples.seq), asc(instrumentMappings.instrumentCode), desc(results.id))
    .limit(5000);

  const tubes = new Map<string, PendingTube>();
  const seenResult = new Set<string>();
  for (const r of rows) {
    if (seenResult.has(r.resultId)) continue;
    seenResult.add(r.resultId);
    let tube = tubes.get(r.sampleId);
    if (!tube) {
      if (tubes.size >= limit) continue;
      tube = {
        sampleId: r.sampleId,
        barcode: r.barcode,
        status: r.status,
        orderId: r.orderId,
        accession: r.accession,
        priority: r.priority,
        sex: r.sex,
        birthDate: r.birthDate,
        collectedAt: r.collectedAt,
        tests: [],
      };
      tubes.set(r.sampleId, tube);
    }
    tube.tests.push({ code: r.code, analyteId: r.analyteId, analyteCode: r.analyteCode, resultId: r.resultId });
  }
  return [...tubes.values()].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

/** Distinct instrument codes of a tube's pending work (one code per analyte). */
export function testCodes(tube: PendingTube): string[] {
  return [...new Set(tube.tests.map((t) => t.code))];
}

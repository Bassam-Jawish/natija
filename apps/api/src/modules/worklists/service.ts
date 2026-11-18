/**
 * Bench worklists: tubes at the bench with their results for one department (or all the
 * user's departments), filtered by what still needs doing. Results are grouped by tube.
 */
import { and, eq, gte, ilike, inArray, isNotNull, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { containers, instrumentMappings, orderItems, orders, patients, results, samples, sampleTypes, tests } from '@natija/db';
import type { BenchSampleStatus, Worklist, WorklistGroup } from '@natija/contracts';
import { normalizeText } from '@natija/domain';
import { db } from '../../db';
import { forbidden } from '../../lib/errors';
import { dayRange } from '../../lib/http';
import { compareResultRows, inSequence, iso, orderRef, patientRef, PRIORITY_ORDER, selectResultRows, toBenchResults } from '../results/shared';

export type WorklistParams = {
  departmentId?: string;
  instrumentId?: string;
  status?: 'pending' | 'to_verify' | 'all';
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
};

/** Department scope for a user: the requested one (if allowed), else their list, else everything. */
export function departmentScope(requested: string | undefined, allowed: string[]): string[] | null {
  if (requested) {
    if (allowed.length && !allowed.includes(requested)) throw forbidden('department_not_allowed', 'This department is outside your assignment');
    return [requested];
  }
  return allowed.length ? allowed : null;
}

export async function getWorklist(p: WorklistParams, scope: { departmentIds: string[] }): Promise<Worklist> {
  const departments = departmentScope(p.departmentId, scope.departmentIds);
  const status = p.status ?? 'pending';

  const conds: Array<SQL | undefined> = [
    ne(orders.status, 'cancelled'),
    notInArray(orderItems.status, ['cancelled', 'rejected']),
    isNotNull(orderItems.sampleId),
    notInArray(samples.status, ['rejected']),
    // At the bench: received tubes, or values already in (an analyzer may report before the scan).
    or(inArray(samples.status, ['received', 'in_analysis', 'stored', 'disposed']), ne(results.status, 'pending')),
  ];
  if (departments) conds.push(inArray(tests.departmentId, departments));
  // An analyzer's worklist: analytes it is mapped to, plus anything it already measured.
  const instrumentCond = p.instrumentId
    ? or(
        eq(results.instrumentId, p.instrumentId),
        inArray(
          results.analyteId,
          db()
            .select({ id: instrumentMappings.analyteId })
            .from(instrumentMappings)
            .where(and(eq(instrumentMappings.instrumentId, p.instrumentId), eq(instrumentMappings.isActive, true))),
        ),
      )
    : undefined;
  conds.push(instrumentCond);
  // Outstanding work has no date limit; "all" defaults to today. Tab counts ignore the dates.
  const dateConds: SQL[] = [];
  if (p.from || p.to || status === 'all') {
    const range = await dayRange(p.from, p.to);
    const since = sql`coalesce(${samples.receivedAt}, ${orders.createdAt})`;
    dateConds.push(gte(since, range.start), lt(since, range.end));
  }
  if (p.q?.trim()) {
    const raw = p.q.trim();
    const term = normalizeText(raw).replace(/[%_]/g, '');
    const prefix = `${raw.replace(/[%_]/g, '')}%`;
    conds.push(
      or(ilike(samples.barcode, prefix), ilike(orders.accession, prefix), ilike(patients.mrn, prefix), term ? ilike(patients.searchText, `%${term}%`) : undefined),
    );
  }
  const outstanding = and(...conds);
  const base = and(outstanding, ...dateConds);

  const keyQuery = (extra: SQL | undefined, where: SQL | undefined = base) =>
    db()
      .selectDistinct({
        sampleId: orderItems.sampleId,
        priority: orders.priority,
        since: sql<Date>`coalesce(${samples.receivedAt}, ${orders.createdAt})`.mapWith((v: string | Date) => new Date(v)),
      })
      .from(results)
      .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
      .innerJoin(tests, eq(tests.id, orderItems.testId))
      .innerJoin(orders, eq(orders.id, results.orderId))
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .innerJoin(samples, eq(samples.id, orderItems.sampleId))
      .where(and(where, extra));

  const statusCond = status === 'pending' ? eq(results.status, 'pending') : status === 'to_verify' ? eq(results.status, 'resulted') : undefined;
  const [keys, pendingKeys, verifyKeys] = await inSequence([
    () => keyQuery(statusCond),
    () => (status === 'pending' && !dateConds.length ? Promise.resolve(null) : keyQuery(eq(results.status, 'pending'), outstanding)),
    () => (status === 'to_verify' && !dateConds.length ? Promise.resolve(null) : keyQuery(eq(results.status, 'resulted'), outstanding)),
  ]);
  keys.sort((x, y) => (PRIORITY_ORDER[x.priority] ?? 2) - (PRIORITY_ORDER[y.priority] ?? 2) || x.since.getTime() - y.since.getTime());
  const chosen = keys.slice(0, p.limit ?? 150).map((k) => k.sampleId!);
  const counts = { pending: (pendingKeys ?? keys).length, toVerify: (verifyKeys ?? keys).length };
  if (!chosen.length) return { groups: [], total: keys.length, counts };

  // Every result of the chosen tubes inside the department/instrument scope, not only the matching ones.
  const scopeConds: Array<SQL | undefined> = [inArray(orderItems.sampleId, chosen), notInArray(orderItems.status, ['cancelled', 'rejected'])];
  if (departments) scopeConds.push(inArray(tests.departmentId, departments));
  scopeConds.push(instrumentCond);
  const rows = await selectResultRows(and(...scopeConds));
  rows.sort(compareResultRows);
  const mapped = await toBenchResults(rows);
  const byId = new Map(mapped.map((r) => [r.id, r]));

  const tubeIds = [...new Set(rows.map((r) => r.s!.id))];
  const tubeRows = await db()
    .select({
      id: samples.id,
      barcode: samples.barcode,
      status: samples.status,
      receivedAt: samples.receivedAt,
      c: { id: containers.id, code: containers.code, nameAr: containers.nameAr, nameEn: containers.nameEn, capColor: containers.capColor },
      st: { id: sampleTypes.id, code: sampleTypes.code, nameAr: sampleTypes.nameAr, nameEn: sampleTypes.nameEn },
    })
    .from(samples)
    .innerJoin(containers, eq(containers.id, samples.containerId))
    .innerJoin(sampleTypes, eq(sampleTypes.id, samples.sampleTypeId))
    .where(inArray(samples.id, tubeIds));
  const tubes = new Map(tubeRows.map((t) => [t.id, t]));

  const groups = new Map<string, WorklistGroup>();
  for (const row of rows) {
    const key = row.s!.id;
    let group = groups.get(key);
    if (!group) {
      const tube = tubes.get(key)!;
      group = {
        key,
        sample: { id: tube.id, barcode: tube.barcode, status: tube.status as BenchSampleStatus, receivedAt: iso(tube.receivedAt), container: tube.c, sampleType: tube.st },
        order: orderRef(row.o),
        patient: patientRef(row.p),
        waitingSince: (tube.receivedAt ?? row.o.createdAt).toISOString(),
        results: [],
      };
      groups.set(key, group);
    }
    group.results.push(byId.get(row.r.id)!);
  }
  const ordered = chosen.map((id) => groups.get(id)).filter((g): g is WorklistGroup => !!g);
  return { groups: ordered, total: keys.length, counts };
}


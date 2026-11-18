/**
 * Bench worklists (port of apps/api/src/modules/worklists): tubes at the bench with their
 * results for one department (or all the user's departments), filtered by what still needs
 * doing. Results are grouped by tube.
 */
import { worklistQuery } from '@natija/contracts';
import type { Worklist, WorklistGroup } from '@natija/contracts';
import { forbidden } from '../../core/context';
import { by, find, rows, type Row } from '../../core/db';
import { dayRange, parse } from '../../core/lib';
import { route } from '../../core/router';
import { compareResultRows, iso, joinResult, orderRef, patientRef, priorityRank, searchFilter, toBenchResults, type ResultRow } from './shared';

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

type Key = { sampleId: string; priority: string; since: Date };

export function getWorklist(p: WorklistParams, scope: { departmentIds: string[] }): Worklist {
  const departments = departmentScope(p.departmentId, scope.departmentIds);
  const deptSet = departments ? new Set(departments) : null;
  const status = p.status ?? 'pending';
  const match = searchFilter(p.q);

  // An analyzer's worklist: analytes it is mapped to, plus anything it already measured.
  const mapped = p.instrumentId
    ? new Set(by('instrumentMappings', 'instrumentId', p.instrumentId).filter((m) => m.isActive).map((m) => m.analyteId))
    : null;
  const instrumentOk = (r: Row<'results'>) => !mapped || r.instrumentId === p.instrumentId || mapped.has(r.analyteId);

  // Outstanding work has no date limit; "all" defaults to today. Tab counts ignore the dates.
  const range = p.from || p.to || status === 'all' ? dayRange(p.from, p.to) : null;

  /** The tube key of a result still outstanding at the bench, or null. */
  const keyOf = (r: Row<'results'>): Key | null => {
    if (!instrumentOk(r)) return null;
    const item = find('orderItems', r.orderItemId);
    if (!item || !item.sampleId || item.status === 'cancelled' || item.status === 'rejected') return null;
    const t = find('tests', item.testId);
    const o = find('orders', r.orderId);
    const pt = o ? find('patients', o.patientId) : undefined;
    const s = find('samples', item.sampleId);
    if (!t || !o || !pt || !s) return null;
    if (o.status === 'cancelled' || s.status === 'rejected') return null;
    // At the bench: received tubes, or values already in (an analyzer may report before the scan).
    if (!['received', 'in_analysis', 'stored', 'disposed'].includes(s.status) && r.status === 'pending') return null;
    if (deptSet && !deptSet.has(t.departmentId)) return null;
    if (match && !match({ barcode: s.barcode, accession: o.accession, mrn: pt.mrn, searchText: pt.searchText })) return null;
    return { sampleId: s.id, priority: o.priority, since: s.receivedAt ?? o.createdAt };
  };
  const keysOf = (list: readonly Row<'results'>[], dated: boolean): Key[] => {
    const out = new Map<string, Key>();
    for (const r of list) {
      const k = keyOf(r);
      if (!k || out.has(k.sampleId)) continue;
      if (dated && range && (k.since < range.start || k.since >= range.end)) continue;
      out.set(k.sampleId, k);
    }
    return [...out.values()];
  };

  const keys = keysOf(status === 'pending' ? by('results', 'status', 'pending') : status === 'to_verify' ? by('results', 'status', 'resulted') : rows('results'), true);
  const pendingKeys = status === 'pending' && !range ? null : keysOf(by('results', 'status', 'pending'), false);
  const verifyKeys = status === 'to_verify' && !range ? null : keysOf(by('results', 'status', 'resulted'), false);
  keys.sort((x, y) => priorityRank(x.priority) - priorityRank(y.priority) || x.since.getTime() - y.since.getTime());
  const chosen = keys.slice(0, p.limit ?? 150).map((k) => k.sampleId);
  const counts = { pending: (pendingKeys ?? keys).length, toVerify: (verifyKeys ?? keys).length };
  if (!chosen.length) return { groups: [], total: keys.length, counts };

  // Every result of the chosen tubes inside the department/instrument scope, not only the matching ones.
  const list: ResultRow[] = [];
  for (const sampleId of chosen) {
    for (const item of by('orderItems', 'sampleId', sampleId)) {
      if (item.status === 'cancelled' || item.status === 'rejected') continue;
      for (const r of by('results', 'orderItemId', item.id)) {
        if (!instrumentOk(r)) continue;
        const row = joinResult(r);
        if (!row || (deptSet && !deptSet.has(row.t.departmentId))) continue;
        list.push(row);
      }
    }
  }
  list.sort(compareResultRows);
  const mappedResults = toBenchResults(list);

  const groups = new Map<string, WorklistGroup>();
  list.forEach((row, i) => {
    const tube = row.s;
    if (!tube) return;
    let group = groups.get(tube.id);
    if (!group) {
      const c = find('containers', tube.containerId);
      const st = find('sampleTypes', tube.sampleTypeId);
      if (!c || !st) return;
      group = {
        key: tube.id,
        sample: {
          id: tube.id,
          barcode: tube.barcode,
          status: tube.status,
          receivedAt: iso(tube.receivedAt),
          container: { id: c.id, code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, capColor: c.capColor },
          sampleType: { id: st.id, code: st.code, nameAr: st.nameAr, nameEn: st.nameEn },
        },
        order: orderRef(row.o),
        patient: patientRef(row.p),
        waitingSince: (tube.receivedAt ?? row.o.createdAt).toISOString(),
        results: [],
      };
      groups.set(tube.id, group);
    }
    group.results.push(mappedResults[i]!);
  });
  const ordered = chosen.map((id) => groups.get(id)).filter((g): g is WorklistGroup => !!g);
  return { groups: ordered, total: keys.length, counts };
}

/* ------------------------------------------------------------------ routes (/worklists) */

export function registerWorklists(): void {
  /** Results to enter or verify, grouped by tube. Restricted users only see their departments. */
  route('GET', '/worklists', { perm: ['results.enter', 'results.verify'] }, (req) =>
    getWorklist(parse(worklistQuery, req.query), { departmentIds: req.auth!.user.departmentIds }),
  );
}

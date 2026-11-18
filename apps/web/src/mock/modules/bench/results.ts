/**
 * Result entry, technical verification, medical validation (e-signed, with segregation of
 * duties), reruns, critical-value calls, amendments of released results, history, an order's
 * results and the validation queue (port of apps/api/src/modules/results/service.ts and
 * routes.ts). Values always go through the results engine (applyResultValue).
 *
 * Mock mode accepts what is typed: any e-signature password, any value (a word in a numeric
 * field is kept as text, a value outside an option list is kept as typed). The lab's rules
 * stay: only resulted or verified values are validated, nobody validates what they entered or
 * verified, validated values change only by an amendment.
 */
import {
  benchAmendInput,
  benchCriticalCallInput,
  benchEnterResultInput,
  benchResultBatchInput,
  benchResultIdsInput,
  benchRerunInput,
  benchValidateInput,
  validationQueueQuery,
} from '@natija/contracts';
import type {
  BenchCriticalCall,
  BenchOrderResults,
  BenchReportVersion,
  BenchResult,
  BenchResultCounts,
  BenchResultEntry,
  BenchResultHistory,
  BenchVerifyResult,
  ValidationQueueRow,
} from '@natija/contracts';
import { formulaVariables } from '@natija/domain';
import { AppError, badRequest, conflict, ctx, notFound, now } from '../../core/context';
import { by, find, insert, rows, update, type Row } from '../../core/db';
import { audit, getLab, notifyPermission, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { refreshOrderStatus } from '../shared/order-status';
import { applyResultValue } from '../shared/results-engine';
import { createReportVersion } from './reports';
import {
  assertDepartments,
  compareResultRows,
  displayValue,
  iso,
  loadBenchResults,
  newestFirst,
  orderRef,
  patientRef,
  PRIORITY_ORDER,
  resultRowsByIds,
  resultRowsOf,
  searchFilter,
  toBenchResults,
  userRef,
  type ResultRow,
} from './shared';

export type Scope = { departmentIds?: string[] };
export type ActionOptions = { at?: Date };

const EDITABLE = new Set(['pending', 'resulted', 'verified']);
const AWAITING = new Set(['resulted', 'verified']);

/* ------------------------------------------------------------------ entry */

/**
 * Normalise a value typed at the bench: Arabic digits become Latin, an option is matched to
 * its spelling in the list. Mock mode refuses no format (the server refuses words in numeric
 * fields and values outside the option list); calculated analytes are still never typed.
 */
export function normalizeManualValue(row: Pick<ResultRow, 'a' | 'r'>, value: string | number | null | undefined): string | number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (row.a.resultType === 'calculated') {
    throw new AppError(400, 'calculated_result', `${row.a.code} is calculated from other results`, { [row.r.id]: ['calculated_result'] });
  }
  if (row.a.resultType === 'numeric') {
    if (typeof value === 'number') return value;
    return text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.');
  }
  if (row.a.resultType === 'option' && row.a.options.length) {
    return row.a.options.find((o) => o.toLowerCase() === text.toLowerCase()) ?? text;
  }
  return text;
}

function assertEditable(row: ResultRow): void {
  if (row.o.status === 'cancelled' || row.item.status === 'cancelled') throw conflict('order_cancelled', 'The order or test is cancelled');
  if (row.s?.status === 'rejected') throw conflict('sample_rejected', 'The tube was rejected');
  if (!EDITABLE.has(row.r.status)) throw new AppError(409, 'result_locked', 'Validated results can only be changed by an amendment', { [row.r.id]: ['result_locked'] });
}

/**
 * Enter or change values by hand (one or many). All entries are checked first; any problem
 * refuses the whole batch. Order statuses are refreshed once per order at the end.
 */
export function enterResults(entries: BenchResultEntry[], scope: Scope = {}): BenchResult[] {
  if (!entries?.length) return [];
  const ids = [...new Set(entries.map((e) => e.resultId))];
  const list = resultRowsByIds(ids);
  const byId = new Map(list.map((x) => [x.r.id, x]));
  if (ids.some((id) => !byId.has(id))) throw notFound('result_not_found');
  assertDepartments(list.map((x) => x.t.departmentId), scope.departmentIds);

  const plan = entries.map((e) => {
    const row = byId.get(e.resultId)!;
    assertEditable(row);
    return { entry: e, row, value: e.value === undefined ? undefined : normalizeManualValue(row, e.value) };
  });

  const orderIds = new Set<string>();
  for (const { entry, row, value } of plan) {
    if (value !== undefined) {
      applyResultValue({ resultId: row.r.id, value, source: 'manual', dilution: entry.dilution ?? null, skipRefresh: true });
    }
    if (entry.comment !== undefined) {
      const comment = entry.comment?.trim() || null;
      const before = row.r.comment;
      if (comment !== before) {
        update('results', row.r, { comment, updatedAt: now() });
        audit({ action: 'result.comment', entityType: 'result', entityId: row.r.id, summary: `${row.o.accession} ${row.a.code}`, before: { comment: before }, after: { comment } });
        publish({ type: 'results.changed', data: { orderId: row.o.id, resultId: row.r.id } });
      }
    }
    orderIds.add(row.o.id);
  }
  for (const orderId of orderIds) refreshOrderStatus(orderId);
  return loadBenchResults(ids);
}

export function enterResult(resultId: string, input: Omit<BenchResultEntry, 'resultId'>, scope: Scope = {}): BenchResult {
  return enterResults([{ ...input, resultId }], scope)[0]!;
}

/** Technical verification: resulted → verified. Other statuses are reported as skipped. */
export function verifyResults(resultIds: string[], scope: Scope = {}, opts: ActionOptions = {}): BenchVerifyResult {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const ids = [...new Set(resultIds ?? [])];
  const list = resultRowsByIds(ids);
  if (list.length !== ids.length) throw notFound('result_not_found');
  assertDepartments(list.map((x) => x.t.departmentId), scope.departmentIds);
  const done: string[] = [];
  const skipped: BenchVerifyResult['skipped'] = [];
  const orderIds = new Set<string>();
  for (const row of list) {
    if (row.r.status !== 'resulted' || row.o.status === 'cancelled' || row.item.status === 'cancelled') {
      skipped.push({ id: row.r.id, status: row.r.status });
      continue;
    }
    const before = row.r.status;
    update('results', row.r, { status: 'verified', verifiedBy: userId, verifiedAt: at, updatedAt: at });
    audit({
      action: 'result.verify',
      entityType: 'result',
      entityId: row.r.id,
      summary: `${row.o.accession} ${row.a.code} = ${displayValue(row.r.valueNum, row.r.valueText, row.a.decimals) ?? ''}`,
      before: { status: before },
      after: { status: 'verified' },
    });
    done.push(row.r.id);
    orderIds.add(row.o.id);
  }
  for (const orderId of orderIds) {
    refreshOrderStatus(orderId);
    publish({ type: 'results.changed', data: { orderId } });
  }
  return { done, skipped };
}

/** E-signature: the signed-in user's password, checked again. Mock mode accepts any password. */
export function checkSignature(_password: string): void {
  if (!ctx().userId) throw badRequest('wrong_password', 'Password is incorrect');
}

/**
 * Medical validation (call checkSignature first). Results must have a value (resulted or
 * verified). With segregation of duties, nobody validates a value they typed or verified.
 */
export function validateResults(resultIds: string[], scope: Scope = {}, opts: ActionOptions = {}): BenchVerifyResult {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const ids = [...new Set(resultIds ?? [])];
  const list = resultRowsByIds(ids);
  if (list.length !== ids.length) throw notFound('result_not_found');
  assertDepartments(list.map((x) => x.t.departmentId), scope.departmentIds);

  if (getLab().settings.segregationOfDuties) {
    const own = list
      .filter((row) => AWAITING.has(row.r.status))
      .filter((row) => {
        const a = row.r.selectedAttemptId ? find('resultAttempts', row.r.selectedAttemptId) : undefined;
        const typedByMe = a ? a.source === 'manual' && a.enteredBy === userId : row.r.enteredBy === userId;
        return typedByMe || row.r.verifiedBy === userId;
      })
      .map((row) => row.r.id);
    if (own.length) {
      throw new AppError(403, 'same_user', 'Segregation of duties: another person must validate results you entered or verified', { resultIds: own });
    }
  }

  const done: string[] = [];
  const skipped: BenchVerifyResult['skipped'] = [];
  const orderIds = new Set<string>();
  for (const row of list) {
    if (!AWAITING.has(row.r.status) || row.o.status === 'cancelled' || row.item.status === 'cancelled' || row.s?.status === 'rejected') {
      skipped.push({ id: row.r.id, status: row.r.status });
      continue;
    }
    const before = row.r.status;
    update('results', row.r, { status: 'validated', validatedBy: userId, validatedAt: at, updatedAt: at });
    insert('resultVersions', {
      resultId: row.r.id,
      version: row.r.version,
      valueNum: row.r.valueNum,
      valueText: row.r.valueText,
      flag: row.r.flag,
      status: 'validated',
      changedBy: userId,
      changedAt: at,
    });
    audit({
      action: 'result.validate',
      entityType: 'result',
      entityId: row.r.id,
      summary: `${row.o.accession} ${row.a.code} = ${displayValue(row.r.valueNum, row.r.valueText, row.a.decimals) ?? ''} · e-signed`,
      before: { status: before },
      after: { status: 'validated', flag: row.r.flag, critical: row.r.isCritical, signed: true },
    });
    done.push(row.r.id);
    orderIds.add(row.o.id);
  }
  for (const orderId of orderIds) {
    refreshOrderStatus(orderId);
    publish({ type: 'results.changed', data: { orderId } });
  }
  return { done, skipped };
}

/** Send a result back to the bench: its value is cleared (attempts are kept) with the reason. */
export function rerunResult(resultId: string, reason: string, scope: Scope = {}): BenchResult {
  const row = resultRowsByIds([resultId])[0];
  if (!row) throw notFound('result_not_found');
  assertDepartments([row.t.departmentId], scope.departmentIds);
  assertEditable(row);
  if (row.r.status === 'pending') throw conflict('nothing_to_rerun', 'The result has no value yet');
  if (row.a.resultType === 'calculated') throw conflict('calculated_result', 'Rerun the results this one is calculated from');
  const why = reason ?? '';
  const before = { value: displayValue(row.r.valueNum, row.r.valueText, row.a.decimals), status: row.r.status };
  applyResultValue({ resultId, value: null, source: 'manual', note: `Rerun requested: ${why}` });
  audit({
    action: 'result.rerun',
    entityType: 'result',
    entityId: resultId,
    summary: `${row.o.accession} ${row.a.code}: ${why}`,
    before,
    after: { status: 'pending', reason: why },
  });
  return loadBenchResults([resultId])[0]!;
}

function toCall(c: Row<'criticalCalls'>): BenchCriticalCall {
  return {
    id: c.id,
    resultId: c.resultId,
    calledAt: c.calledAt.toISOString(),
    calledBy: userRef(c.calledBy),
    recipientName: c.recipientName,
    recipientRole: c.recipientRole,
    phone: c.phone,
    readBack: c.readBack,
    note: c.note,
  };
}

export function recordCriticalCall(
  resultId: string,
  input: { recipientName: string; recipientRole: BenchCriticalCall['recipientRole']; phone?: string | null; readBack: boolean; note?: string | null },
  opts: ActionOptions = {},
): BenchCriticalCall {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const r = find('results', resultId);
  const o = r ? find('orders', r.orderId) : undefined;
  if (!r || !o) throw notFound('result_not_found');
  const recipientName = input.recipientName ?? '';
  const recipientRole = input.recipientRole ?? 'other';
  const readBack = input.readBack === true;
  const call = insert('criticalCalls', {
    resultId,
    orderId: r.orderId,
    calledBy: userId,
    calledAt: at,
    recipientName,
    recipientRole,
    phone: input.phone ?? null,
    readBack,
    note: input.note ?? null,
  });
  audit({
    action: 'result.critical_call',
    entityType: 'result',
    entityId: resultId,
    summary: `${o.accession} · ${recipientName} (${recipientRole})${readBack ? ' · read back' : ''}`,
    after: { recipientName, recipientRole, phone: input.phone ?? null, readBack },
  });
  publish({ type: 'results.changed', data: { orderId: r.orderId, resultId } });
  return toCall(call);
}

/**
 * Amend a released result (call checkSignature first): the old value is kept in
 * result_versions, the new one goes through the engine (dependent calculations follow),
 * the result is marked amended and the report is re-released as a new version.
 */
export function amendResult(resultId: string, input: { value: string | number; reason: string }, opts: ActionOptions = {}): { result: BenchResult; report: BenchReportVersion } {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const target = resultRowsByIds([resultId])[0];
  if (!target) throw notFound('result_not_found');
  if (target.r.status !== 'released') throw conflict('not_released', 'Only released results can be amended; edit the value instead');
  const value = normalizeManualValue(target, input.value);
  if (value === null) throw badRequest('invalid_value', 'Give the corrected value');
  const reason = input.reason ?? '';

  // The target plus calculated results in the order that depend on it (directly or through others).
  const orderRows = resultRowsOf(by('results', 'orderId', target.o.id));
  const affected = new Set([target.r.id]);
  const codes = new Set([target.a.code]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of orderRows) {
      if (affected.has(row.r.id) || row.a.resultType !== 'calculated' || !row.a.formula) continue;
      if (formulaVariables(row.a.formula).some((v) => codes.has(v))) {
        affected.add(row.r.id);
        codes.add(row.a.code);
        grew = true;
      }
    }
  }
  const before = orderRows.filter((row) => affected.has(row.r.id) && row.r.status === 'released');
  // Rows change in place below: keep the released values to compare and to report.
  const old = new Map(before.map((row) => [row.r.id, { valueNum: row.r.valueNum, valueText: row.r.valueText, flag: row.r.flag }]));
  const targetOld = old.get(resultId) ?? { valueNum: target.r.valueNum, valueText: target.r.valueText, flag: target.r.flag };
  for (const row of before) {
    insert('resultVersions', {
      resultId: row.r.id,
      version: row.r.version,
      valueNum: row.r.valueNum,
      valueText: row.r.valueText,
      flag: row.r.flag,
      status: 'released',
      reason: `Before amendment: ${reason}`,
      changedBy: userId,
      changedAt: at,
    });
  }
  // Unlock, apply through the engine, lock again as released and amended.
  for (const row of before) update('results', row.r, { status: 'verified' });
  applyResultValue({ resultId, value, source: 'manual', note: `Amendment: ${reason}`, skipRefresh: true });
  for (const row of before) {
    const r = row.r;
    const prior = old.get(r.id)!;
    const changed = prior.valueNum !== r.valueNum || (prior.valueText ?? '') !== (r.valueText ?? '');
    update('results', r, {
      status: 'released',
      amended: r.id === resultId || changed || r.amended,
      validatedBy: userId,
      validatedAt: at,
      releasedAt: at,
      updatedAt: at,
    });
    insert('resultVersions', {
      resultId: r.id,
      version: r.version,
      valueNum: r.valueNum,
      valueText: r.valueText,
      flag: r.flag,
      status: 'released',
      reason,
      changedBy: userId,
      changedAt: at,
    });
  }
  refreshOrderStatus(target.o.id);
  const fresh = target.r;
  audit({
    action: 'result.amend',
    entityType: 'result',
    entityId: resultId,
    summary: `${target.o.accession} ${target.a.code}: ${displayValue(targetOld.valueNum, targetOld.valueText, target.a.decimals) ?? ''} → ${displayValue(fresh.valueNum, fresh.valueText, target.a.decimals) ?? ''} · e-signed`,
    before: { value: targetOld.valueText ?? targetOld.valueNum, flag: targetOld.flag },
    after: { value: fresh.valueText ?? fresh.valueNum, flag: fresh.flag, reason, signed: true },
  });

  const report = createReportVersion(target.o.id, { amendReason: reason, at });
  audit({
    action: 'report.release',
    entityType: 'order',
    entityId: target.o.id,
    summary: `${target.o.accession} · amended report v${report.version}`,
    after: { reportId: report.id, version: report.version, verifyCode: report.verifyCode, amendReason: reason },
  });
  notifyPermission('reports.deliver', {
    kind: 'report_ready',
    severity: 'warning',
    titleAr: `تقرير معدّل: ${target.o.accession}`,
    titleEn: `Amended report: ${target.o.accession}`,
    bodyAr: `${target.a.nameAr} · ${reason} · يرجى إعادة إرسال التقرير للمريض`,
    bodyEn: `${target.a.nameEn} · ${reason} · send the new version to the patient`,
    link: `/orders/${target.o.id}`,
    entityType: 'order',
    entityId: target.o.id,
  });
  publish({ type: 'results.changed', data: { orderId: target.o.id, resultId } });
  return { result: loadBenchResults([resultId])[0]!, report };
}

/* ------------------------------------------------------------------ reading */

export function getResultHistory(resultId: string): BenchResultHistory {
  const result = loadBenchResults([resultId])[0];
  if (!result) throw notFound('result_not_found');
  const current = find('results', resultId);
  const decimals = result.analyte.decimals;
  const attempts = newestFirst(by('resultAttempts', 'resultId', resultId), (a) => a.createdAt);
  const versions = newestFirst(by('resultVersions', 'resultId', resultId), (v) => v.changedAt);
  const auditRows = by('auditLog', 'entityId', resultId)
    .filter((a) => a.entityType === 'result')
    .sort((x, y) => y.seq - x.seq)
    .slice(0, 200);
  const calls = newestFirst(by('criticalCalls', 'resultId', resultId), (c) => c.calledAt);
  return {
    result,
    attempts: attempts.map((a) => {
      const inst = a.instrumentId ? find('instruments', a.instrumentId) : undefined;
      return {
        id: a.id,
        source: a.source,
        value: displayValue(a.valueNum, a.valueText, decimals),
        unit: a.unit,
        rawFlag: a.rawFlag,
        instrument: inst ? { id: inst.id, code: inst.code, name: inst.name } : null,
        dilution: a.dilution,
        isRerun: a.isRerun,
        measuredAt: iso(a.measuredAt),
        enteredBy: userRef(a.enteredBy),
        note: a.note,
        createdAt: a.createdAt.toISOString(),
        selected: a.id === current?.selectedAttemptId,
      };
    }),
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      value: displayValue(v.valueNum, v.valueText, decimals),
      flag: v.flag,
      status: v.status,
      reason: v.reason,
      changedBy: userRef(v.changedBy),
      changedAt: v.changedAt.toISOString(),
    })),
    audit: auditRows.map((a) => ({ id: a.id, action: a.action, summary: a.summary, actorName: a.actorName, at: a.at.toISOString() })),
    criticalCalls: calls.map(toCall),
  };
}

function countStatuses(statuses: string[]): BenchResultCounts {
  const counts: BenchResultCounts = { pending: 0, resulted: 0, verified: 0, validated: 0, released: 0, total: statuses.length };
  for (const s of statuses) if (s in counts && s !== 'total') counts[s as keyof Omit<BenchResultCounts, 'total'>] += 1;
  return counts;
}

/** Every result of an order, grouped by department and test (the order page's results tab). */
export function getOrderResults(orderId: string, scope: Scope = {}): BenchOrderResults {
  const o = find('orders', orderId);
  const p = o ? find('patients', o.patientId) : undefined;
  if (!o || !p) throw notFound('order_not_found');
  const d = o.doctorId ? find('doctors', o.doctorId) : undefined;
  const deptScope = scope.departmentIds?.length ? new Set(scope.departmentIds) : null;
  const list = resultRowsOf(by('results', 'orderId', orderId)).filter((x) => x.item.status !== 'cancelled' && (!deptScope || deptScope.has(x.t.departmentId)));
  const deptMap = new Map<string, Row<'departments'>>();
  for (const id of new Set(list.map((x) => x.t.departmentId))) {
    const dept = find('departments', id);
    if (dept) deptMap.set(id, dept);
  }
  list.sort((x, y) => (deptMap.get(x.t.departmentId)?.sortOrder ?? 99) - (deptMap.get(y.t.departmentId)?.sortOrder ?? 99) || compareResultRows(x, y));
  const mapped = toBenchResults(list);
  const calls = newestFirst(
    list.flatMap((x) => by('criticalCalls', 'resultId', x.r.id)),
    (c) => c.calledAt,
  );

  const sections: BenchOrderResults['sections'] = [];
  list.forEach((row, i) => {
    const dept = deptMap.get(row.t.departmentId);
    let section = sections.find((s) => s.department.id === row.t.departmentId);
    if (!section) {
      section = { department: { id: row.t.departmentId, code: dept?.code ?? '', nameAr: dept?.nameAr ?? '', nameEn: dept?.nameEn ?? '' }, items: [] };
      sections.push(section);
    }
    let item = section.items.find((x) => x.orderItemId === row.item.id);
    if (!item) {
      item = {
        orderItemId: row.item.id,
        test: { id: row.t.id, code: row.t.code, nameAr: row.t.nameAr, nameEn: row.t.nameEn },
        status: row.item.status,
        sample: row.s ? { id: row.s.id, barcode: row.s.barcode, status: row.s.status } : null,
        results: [],
      };
      section.items.push(item);
    }
    item.results.push(mapped[i]!);
  });
  const called = new Set(calls.map((c) => c.resultId));
  return {
    order: orderRef(o),
    patient: patientRef(p),
    doctor: d ? { nameAr: d.nameAr, nameEn: d.nameEn } : null,
    sections,
    criticalCalls: calls.map(toCall),
    summary: {
      ...countStatuses(list.map((x) => x.r.status)),
      criticalUncalled: list.filter((x) => x.r.isCritical && x.r.status !== 'released' && !called.has(x.r.id)).length,
    },
  };
}

/**
 * Orders with results waiting for medical validation, STAT/urgent first, then the oldest.
 * Each row says whether anything is still waiting for a value (allReady = false).
 */
export function getValidationQueue(
  q: { departmentId?: string; priority?: 'routine' | 'urgent' | 'stat'; critical?: boolean; q?: string },
  scope: Scope = {},
): ValidationQueueRow[] {
  const deptScope = q.departmentId ? [q.departmentId] : scope.departmentIds?.length ? scope.departmentIds : null;
  if (q.departmentId) assertDepartments([q.departmentId], scope.departmentIds);
  const deptSet = deptScope ? new Set(deptScope) : null;
  const match = searchFilter(q.q);

  // Orders with a value waiting for validation in scope.
  const waiting = new Set<string>();
  for (const status of ['resulted', 'verified'] as const) {
    for (const r of by('results', 'status', status)) {
      const item = find('orderItems', r.orderItemId);
      if (!item || item.status === 'cancelled' || item.status === 'rejected') continue;
      const t = find('tests', item.testId);
      if (!t || (deptSet && !deptSet.has(t.departmentId))) continue;
      waiting.add(r.orderId);
    }
  }
  const list: ResultRow[] = [];
  for (const orderId of waiting) {
    const o = find('orders', orderId);
    const p = o ? find('patients', o.patientId) : undefined;
    if (!o || !p || o.status === 'cancelled') continue;
    if (q.priority && o.priority !== q.priority) continue;
    if (match && !match({ accession: o.accession, mrn: p.mrn, searchText: p.searchText })) continue;
    for (const row of resultRowsOf(by('results', 'orderId', orderId))) {
      if (row.item.status === 'cancelled' || row.item.status === 'rejected') continue;
      if (deptSet && !deptSet.has(row.t.departmentId)) continue;
      list.push(row);
    }
  }
  if (!list.length) return [];

  const departments = [...rows('departments')].sort((x, y) => x.sortOrder - y.sortOrder);
  const deptMap = new Map(departments.map((d) => [d.id, d]));
  const byOrder = new Map<string, ResultRow[]>();
  for (const row of list) {
    const group = byOrder.get(row.o.id) ?? [];
    group.push(row);
    byOrder.set(row.o.id, group);
  }
  const out: ValidationQueueRow[] = [];
  for (const group of byOrder.values()) {
    const first = group[0]!;
    const called = (r: Row<'results'>) => by('criticalCalls', 'resultId', r.id).length > 0;
    const awaitingRows = group.filter((x) => AWAITING.has(x.r.status));
    const critical = awaitingRows.filter((x) => x.r.isCritical);
    const criticalUncalled = group.filter((x) => x.r.isCritical && x.r.status !== 'released' && !called(x.r)).length;
    if (q.critical && critical.length === 0) continue;
    const readyTimes = awaitingRows.map((x) => (x.r.verifiedAt ?? x.r.enteredAt ?? x.r.updatedAt).getTime());
    const depts = [...new Set(group.map((x) => x.t.departmentId))]
      .map((id) => deptMap.get(id))
      .filter((d): d is Row<'departments'> => !!d)
      .sort((x, y) => x.sortOrder - y.sortOrder)
      .map(({ id, code, nameAr, nameEn }) => ({ id, code, nameAr, nameEn }));
    const doctor = first.o.doctorId ? find('doctors', first.o.doctorId) : undefined;
    const counts = countStatuses(group.map((x) => x.r.status));
    out.push({
      order: orderRef(first.o),
      patient: patientRef(first.p),
      doctor: doctor ? { nameAr: doctor.nameAr, nameEn: doctor.nameEn } : null,
      departments: depts,
      counts,
      awaiting: awaitingRows.length,
      abnormal: awaitingRows.filter((x) => x.r.flag && x.r.flag !== 'N').length,
      critical: critical.length,
      criticalUncalled,
      delta: awaitingRows.filter((x) => x.r.deltaFlag).length,
      allReady: counts.pending === 0,
      readySince: readyTimes.length ? new Date(Math.min(...readyTimes)).toISOString() : null,
    });
  }
  out.sort(
    (x, y) =>
      (PRIORITY_ORDER[x.order.priority] ?? 2) - (PRIORITY_ORDER[y.order.priority] ?? 2) ||
      new Date(x.readySince ?? x.order.createdAt).getTime() - new Date(y.readySince ?? y.order.createdAt).getTime(),
  );
  return out.slice(0, 300);
}

/* ------------------------------------------------------------------ routes (/results) */

const BENCH = ['results.enter', 'results.verify', 'results.validate'];

export function registerResults(): void {
  const scope = (req: { auth: { user: { departmentIds: string[] } } | null }): Scope => ({ departmentIds: req.auth!.user.departmentIds });

  route('GET', '/results/validation-queue', { perm: 'results.validate' }, (req) => ({
    items: getValidationQueue(parse(validationQueueQuery, req.query), scope(req)),
  }));

  route('GET', '/results/orders/:orderId', { perm: 'results.read' }, (req) => getOrderResults(req.params.orderId!));

  route('PUT', '/results/:id', { perm: 'results.enter' }, (req) => enterResult(req.params.id!, parse(benchEnterResultInput, req.body), scope(req)));

  route('POST', '/results/batch', { perm: 'results.enter' }, (req) => ({
    items: enterResults(parse(benchResultBatchInput, req.body).entries ?? [], scope(req)),
  }));

  route('POST', '/results/verify', { perm: 'results.verify' }, (req) => verifyResults(parse(benchResultIdsInput, req.body).resultIds ?? [], scope(req)));

  /** Medical validation, e-signed with the user's password (any password in mock mode). */
  route('POST', '/results/validate', { perm: 'results.validate' }, (req) => {
    const body = parse(benchValidateInput, req.body);
    checkSignature(body.password ?? '');
    return validateResults(body.resultIds ?? [], scope(req));
  });

  route('POST', '/results/:id/rerun', { perm: BENCH }, (req) => rerunResult(req.params.id!, parse(benchRerunInput, req.body).reason, scope(req)));

  route('POST', '/results/:id/critical-call', { perm: BENCH }, (req) => recordCriticalCall(req.params.id!, parse(benchCriticalCallInput, req.body)));

  /** Amendment of a released result, e-signed; re-releases the report as a new version. */
  route('POST', '/results/:id/amend', { perm: 'results.amend' }, (req) => {
    const body = parse(benchAmendInput, req.body);
    checkSignature(body.password ?? '');
    return amendResult(req.params.id!, { value: body.value, reason: body.reason });
  });

  route('GET', '/results/:id/history', { perm: 'results.read' }, (req) => getResultHistory(req.params.id!));
}

/**
 * Result entry, technical verification, medical validation (e-signed, with segregation of
 * duties), reruns, critical-value calls, amendments of released results, history and the
 * validation queue. Values always go through the results engine (applyResultValue).
 */
import { and, asc, desc, eq, ilike, inArray, ne, notInArray, or, type SQL } from 'drizzle-orm';
import {
  auditLog,
  criticalCalls,
  departments,
  doctors,
  instruments,
  orderItems,
  orders,
  patients,
  resultAttempts,
  results,
  resultVersions,
  tests,
  users,
} from '@natija/db';
import type {
  BenchCriticalCall,
  BenchItemStatus,
  BenchOrderResults,
  BenchReportVersion,
  BenchResult,
  BenchResultCounts,
  BenchResultEntry,
  BenchResultHistory,
  BenchResultStatus,
  BenchSampleStatus,
  BenchVerifyResult,
  ValidationQueueRow,
} from '@natija/contracts';
import { formulaVariables, normalizeText, parseNumericValue } from '@natija/domain';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { verifyPassword } from '../../lib/crypto';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { getLab } from '../../lib/lab';
import { notifyPermission } from '../../lib/notify';
import { refreshOrderStatus } from '../../services/order-status';
import { applyResultValue } from '../../services/results-engine';
import { createReportVersion } from '../reports/service';
import {
  assertDepartments,
  compareResultRows,
  displayValue,
  inSequence,
  iso,
  loadBenchResults,
  loadUserRefs,
  orderRef,
  patientRef,
  PRIORITY_ORDER,
  selectResultRows,
  toBenchResults,
  type ResultRow,
} from './shared';

export type Scope = { departmentIds?: string[] };
export type ActionOptions = { at?: Date };

const EDITABLE = new Set(['pending', 'resulted', 'verified']);
const AWAITING = new Set(['resulted', 'verified']);

/* ------------------------------------------------------------------ entry */

/**
 * Check and normalise a value typed at the bench: numbers (with "<"/">"), one of the
 * analyte's options, or free text. Calculated analytes are never typed.
 */
export function normalizeManualValue(row: Pick<ResultRow, 'a' | 'r'>, value: string | number | null): string | number | null {
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const fail = (code: string, message: string) => new AppError(400, code, message, { [row.r.id]: [code] });
  if (row.a.resultType === 'calculated') throw fail('calculated_result', `${row.a.code} is calculated from other results`);
  if (row.a.resultType === 'numeric') {
    if (typeof value === 'number') return value;
    const latin = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.');
    if (!/^([<>]=?)?\s*-?\d+(?:[.,]\d+)?$/.test(latin) || parseNumericValue(latin).value === null) throw fail('invalid_number', `${row.a.code} needs a number`);
    return latin;
  }
  if (row.a.resultType === 'option' && row.a.options.length) {
    const match = row.a.options.find((o) => o.toLowerCase() === text.toLowerCase());
    if (!match) throw fail('invalid_option', `${row.a.code} must be one of: ${row.a.options.join(', ')}`);
    return match;
  }
  return text;
}

function assertEditable(row: ResultRow) {
  if (row.o.status === 'cancelled' || row.item.status === 'cancelled') throw conflict('order_cancelled', 'The order or test is cancelled');
  if (row.s?.status === 'rejected') throw conflict('sample_rejected', 'The tube was rejected');
  if (!EDITABLE.has(row.r.status)) throw new AppError(409, 'result_locked', 'Validated results can only be changed by an amendment', { [row.r.id]: ['result_locked'] });
}

/**
 * Enter or change values by hand (one or many). All entries are checked first; any problem
 * refuses the whole batch. Order statuses are refreshed once per order at the end.
 */
export async function enterResults(entries: BenchResultEntry[], scope: Scope = {}): Promise<BenchResult[]> {
  if (!entries.length) return [];
  const ids = [...new Set(entries.map((e) => e.resultId))];
  const rows = await selectResultRows(inArray(results.id, ids), { forUpdate: true });
  const byId = new Map(rows.map((r) => [r.r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw notFound('result_not_found');
  assertDepartments(rows.map((r) => r.t.departmentId), scope.departmentIds);

  const plan = entries.map((e) => {
    const row = byId.get(e.resultId)!;
    assertEditable(row);
    return { entry: e, row, value: e.value === undefined ? undefined : normalizeManualValue(row, e.value) };
  });

  const orderIds = new Set<string>();
  for (const { entry, row, value } of plan) {
    if (value !== undefined) {
      await applyResultValue({ resultId: row.r.id, value, source: 'manual', dilution: entry.dilution ?? null, skipRefresh: true });
    }
    if (entry.comment !== undefined) {
      const comment = entry.comment?.trim() || null;
      if (comment !== row.r.comment) {
        await db().update(results).set({ comment, updatedAt: new Date() }).where(eq(results.id, row.r.id));
        await audit({ action: 'result.comment', entityType: 'result', entityId: row.r.id, summary: `${row.o.accession} ${row.a.code}`, before: { comment: row.r.comment }, after: { comment } });
        publish({ type: 'results.changed', data: { orderId: row.o.id, resultId: row.r.id } });
      }
    }
    orderIds.add(row.o.id);
  }
  for (const orderId of orderIds) await refreshOrderStatus(orderId);
  return loadBenchResults(ids);
}

export async function enterResult(resultId: string, input: Omit<BenchResultEntry, 'resultId'>, scope: Scope = {}): Promise<BenchResult> {
  const [result] = await enterResults([{ ...input, resultId }], scope);
  return result!;
}

/** Technical verification: resulted → verified. Other statuses are reported as skipped. */
export async function verifyResults(resultIds: string[], scope: Scope = {}, opts: ActionOptions = {}): Promise<BenchVerifyResult> {
  const { userId } = ctx();
  const now = opts.at ?? new Date();
  const ids = [...new Set(resultIds)];
  const rows = await selectResultRows(inArray(results.id, ids), { forUpdate: true });
  if (rows.length !== ids.length) throw notFound('result_not_found');
  assertDepartments(rows.map((r) => r.t.departmentId), scope.departmentIds);
  const done: string[] = [];
  const skipped: BenchVerifyResult['skipped'] = [];
  const orderIds = new Set<string>();
  for (const row of rows) {
    if (row.r.status !== 'resulted' || row.o.status === 'cancelled' || row.item.status === 'cancelled') {
      skipped.push({ id: row.r.id, status: row.r.status as BenchResultStatus });
      continue;
    }
    await db().update(results).set({ status: 'verified', verifiedBy: userId, verifiedAt: now, updatedAt: now }).where(eq(results.id, row.r.id));
    await audit({
      action: 'result.verify',
      entityType: 'result',
      entityId: row.r.id,
      summary: `${row.o.accession} ${row.a.code} = ${displayValue(row.r.valueNum, row.r.valueText, row.a.decimals) ?? ''}`,
      before: { status: row.r.status },
      after: { status: 'verified' },
    });
    done.push(row.r.id);
    orderIds.add(row.o.id);
  }
  for (const orderId of orderIds) {
    await refreshOrderStatus(orderId);
    publish({ type: 'results.changed', data: { orderId } });
  }
  return { done, skipped };
}

/** E-signature: the signed-in user's password, checked again. */
export async function checkSignature(password: string): Promise<void> {
  const { userId } = ctx();
  if (!userId) throw badRequest('wrong_password', 'Password is incorrect');
  const [user] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!user || !(await verifyPassword(password, user.hash))) throw badRequest('wrong_password', 'Password is incorrect');
}

/**
 * Medical validation (call checkSignature first). Results must have a value (resulted or
 * verified). With segregation of duties, nobody validates a value they typed or verified.
 */
export async function validateResults(resultIds: string[], scope: Scope = {}, opts: ActionOptions = {}): Promise<BenchVerifyResult> {
  const { labId, userId } = ctx();
  const now = opts.at ?? new Date();
  const ids = [...new Set(resultIds)];
  const rows = await selectResultRows(inArray(results.id, ids), { forUpdate: true });
  if (rows.length !== ids.length) throw notFound('result_not_found');
  assertDepartments(rows.map((r) => r.t.departmentId), scope.departmentIds);

  const lab = await getLab(labId);
  if (lab.settings.segregationOfDuties) {
    const attemptIds = rows.map((r) => r.r.selectedAttemptId).filter((x): x is string => !!x);
    const attempts = attemptIds.length
      ? await db().select({ id: resultAttempts.id, source: resultAttempts.source, enteredBy: resultAttempts.enteredBy }).from(resultAttempts).where(inArray(resultAttempts.id, attemptIds))
      : [];
    const attemptMap = new Map(attempts.map((a) => [a.id, a]));
    const own = rows
      .filter((row) => AWAITING.has(row.r.status))
      .filter((row) => {
        const a = row.r.selectedAttemptId ? attemptMap.get(row.r.selectedAttemptId) : undefined;
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
  for (const row of rows) {
    if (!AWAITING.has(row.r.status) || row.o.status === 'cancelled' || row.item.status === 'cancelled' || row.s?.status === 'rejected') {
      skipped.push({ id: row.r.id, status: row.r.status as BenchResultStatus });
      continue;
    }
    await db().update(results).set({ status: 'validated', validatedBy: userId, validatedAt: now, updatedAt: now }).where(eq(results.id, row.r.id));
    await db().insert(resultVersions).values({
      labId,
      resultId: row.r.id,
      version: row.r.version,
      valueNum: row.r.valueNum,
      valueText: row.r.valueText,
      flag: row.r.flag,
      status: 'validated',
      changedBy: userId,
      changedAt: now,
    });
    await audit({
      action: 'result.validate',
      entityType: 'result',
      entityId: row.r.id,
      summary: `${row.o.accession} ${row.a.code} = ${displayValue(row.r.valueNum, row.r.valueText, row.a.decimals) ?? ''} · e-signed`,
      before: { status: row.r.status },
      after: { status: 'validated', flag: row.r.flag, critical: row.r.isCritical, signed: true },
    });
    done.push(row.r.id);
    orderIds.add(row.o.id);
  }
  for (const orderId of orderIds) {
    await refreshOrderStatus(orderId);
    publish({ type: 'results.changed', data: { orderId } });
  }
  return { done, skipped };
}

/** Send a result back to the bench: its value is cleared (attempts are kept) with the reason. */
export async function rerunResult(resultId: string, reason: string, scope: Scope = {}): Promise<BenchResult> {
  const [row] = await selectResultRows(eq(results.id, resultId), { forUpdate: true });
  if (!row) throw notFound('result_not_found');
  assertDepartments([row.t.departmentId], scope.departmentIds);
  assertEditable(row);
  if (row.r.status === 'pending') throw conflict('nothing_to_rerun', 'The result has no value yet');
  if (row.a.resultType === 'calculated') throw conflict('calculated_result', 'Rerun the results this one is calculated from');
  await applyResultValue({ resultId, value: null, source: 'manual', note: `Rerun requested: ${reason}` });
  await audit({
    action: 'result.rerun',
    entityType: 'result',
    entityId: resultId,
    summary: `${row.o.accession} ${row.a.code}: ${reason}`,
    before: { value: displayValue(row.r.valueNum, row.r.valueText, row.a.decimals), status: row.r.status },
    after: { status: 'pending', reason },
  });
  const [result] = await loadBenchResults([resultId]);
  return result!;
}

export async function recordCriticalCall(
  resultId: string,
  input: { recipientName: string; recipientRole: BenchCriticalCall['recipientRole']; phone?: string | null; readBack: boolean; note?: string | null },
  opts: ActionOptions = {},
): Promise<BenchCriticalCall> {
  const { labId, userId } = ctx();
  const now = opts.at ?? new Date();
  const [row] = await db()
    .select({ id: results.id, orderId: results.orderId, accession: orders.accession, isCritical: results.isCritical })
    .from(results)
    .innerJoin(orders, eq(orders.id, results.orderId))
    .where(eq(results.id, resultId));
  if (!row) throw notFound('result_not_found');
  const [call] = await db()
    .insert(criticalCalls)
    .values({
      labId,
      resultId,
      orderId: row.orderId,
      calledBy: userId,
      calledAt: now,
      recipientName: input.recipientName,
      recipientRole: input.recipientRole,
      phone: input.phone ?? null,
      readBack: input.readBack,
      note: input.note ?? null,
    })
    .returning();
  await audit({
    action: 'result.critical_call',
    entityType: 'result',
    entityId: resultId,
    summary: `${row.accession} · ${input.recipientName} (${input.recipientRole})${input.readBack ? ' · read back' : ''}`,
    after: { recipientName: input.recipientName, recipientRole: input.recipientRole, phone: input.phone ?? null, readBack: input.readBack },
  });
  publish({ type: 'results.changed', data: { orderId: row.orderId, resultId } });
  const userMap = await loadUserRefs([userId]);
  return toCall(call!, userMap);
}

function toCall(c: typeof criticalCalls.$inferSelect, userMap: Map<string, NonNullable<BenchCriticalCall['calledBy']>>): BenchCriticalCall {
  return {
    id: c.id,
    resultId: c.resultId,
    calledAt: c.calledAt.toISOString(),
    calledBy: c.calledBy ? (userMap.get(c.calledBy) ?? null) : null,
    recipientName: c.recipientName,
    recipientRole: c.recipientRole,
    phone: c.phone,
    readBack: c.readBack,
    note: c.note,
  };
}

/**
 * Amend a released result (call checkSignature first): the old value is kept in
 * result_versions, the new one goes through the engine (dependent calculations follow),
 * the result is marked amended and the report is re-released as a new version.
 */
export async function amendResult(resultId: string, input: { value: string | number; reason: string }, opts: ActionOptions = {}): Promise<{ result: BenchResult; report: BenchReportVersion }> {
  const { labId, userId } = ctx();
  const now = opts.at ?? new Date();
  const [target] = await selectResultRows(eq(results.id, resultId), { forUpdate: true });
  if (!target) throw notFound('result_not_found');
  if (target.r.status !== 'released') throw conflict('not_released', 'Only released results can be amended; edit the value instead');
  const value = normalizeManualValue(target, input.value);
  if (value === null) throw badRequest('invalid_value', 'Give the corrected value');

  // The target plus calculated results in the order that depend on it (directly or through others).
  const orderRows = await selectResultRows(eq(results.orderId, target.o.id), { forUpdate: true });
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
  for (const row of before) {
    await db().insert(resultVersions).values({
      labId,
      resultId: row.r.id,
      version: row.r.version,
      valueNum: row.r.valueNum,
      valueText: row.r.valueText,
      flag: row.r.flag,
      status: 'released',
      reason: `Before amendment: ${input.reason}`,
      changedBy: userId,
      changedAt: now,
    });
  }
  // Unlock, apply through the engine, lock again as released and amended.
  await db().update(results).set({ status: 'verified' }).where(inArray(results.id, before.map((r) => r.r.id)));
  await applyResultValue({ resultId, value, source: 'manual', note: `Amendment: ${input.reason}`, skipRefresh: true });
  const after = await selectResultRows(inArray(results.id, before.map((r) => r.r.id)));
  for (const row of after) {
    const old = before.find((b) => b.r.id === row.r.id)!;
    const changed = old.r.valueNum !== row.r.valueNum || (old.r.valueText ?? '') !== (row.r.valueText ?? '');
    await db()
      .update(results)
      .set({
        status: 'released',
        amended: row.r.id === resultId || changed || row.r.amended,
        validatedBy: userId,
        validatedAt: now,
        releasedAt: now,
        updatedAt: now,
      })
      .where(eq(results.id, row.r.id));
    await db().insert(resultVersions).values({
      labId,
      resultId: row.r.id,
      version: row.r.version,
      valueNum: row.r.valueNum,
      valueText: row.r.valueText,
      flag: row.r.flag,
      status: 'released',
      reason: input.reason,
      changedBy: userId,
      changedAt: now,
    });
  }
  await refreshOrderStatus(target.o.id);
  const newRow = after.find((r) => r.r.id === resultId)!;
  await audit({
    action: 'result.amend',
    entityType: 'result',
    entityId: resultId,
    summary: `${target.o.accession} ${target.a.code}: ${displayValue(target.r.valueNum, target.r.valueText, target.a.decimals) ?? ''} → ${displayValue(newRow.r.valueNum, newRow.r.valueText, target.a.decimals) ?? ''} · e-signed`,
    before: { value: target.r.valueText ?? target.r.valueNum, flag: target.r.flag },
    after: { value: newRow.r.valueText ?? newRow.r.valueNum, flag: newRow.r.flag, reason: input.reason, signed: true },
  });

  const report = await createReportVersion(target.o.id, { amendReason: input.reason, at: now });
  await audit({
    action: 'report.release',
    entityType: 'order',
    entityId: target.o.id,
    summary: `${target.o.accession} · amended report v${report.version}`,
    after: { reportId: report.id, version: report.version, verifyCode: report.verifyCode, amendReason: input.reason },
  });
  await notifyPermission('reports.deliver', {
    kind: 'report_ready',
    severity: 'warning',
    titleAr: `تقرير معدّل: ${target.o.accession}`,
    titleEn: `Amended report: ${target.o.accession}`,
    bodyAr: `${target.a.nameAr} · ${input.reason} · يرجى إعادة إرسال التقرير للمريض`,
    bodyEn: `${target.a.nameEn} · ${input.reason} · send the new version to the patient`,
    link: `/orders/${target.o.id}`,
    entityType: 'order',
    entityId: target.o.id,
  });
  publish({ type: 'results.changed', data: { orderId: target.o.id, resultId } });
  const [result] = await loadBenchResults([resultId]);
  return { result: result!, report };
}

/* ------------------------------------------------------------------ reading */

export async function getResultHistory(resultId: string): Promise<BenchResultHistory> {
  const [result] = await loadBenchResults([resultId]);
  if (!result) throw notFound('result_not_found');
  const [attemptRows, versionRows, auditRows, callRows] = await inSequence([
    () => db().select().from(resultAttempts).where(eq(resultAttempts.resultId, resultId)).orderBy(desc(resultAttempts.createdAt), desc(resultAttempts.id)),
    () => db().select().from(resultVersions).where(eq(resultVersions.resultId, resultId)).orderBy(desc(resultVersions.changedAt), desc(resultVersions.id)),
    () => db()
      .select({ id: auditLog.id, action: auditLog.action, summary: auditLog.summary, actorName: auditLog.actorName, at: auditLog.at })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'result'), eq(auditLog.entityId, resultId)))
      .orderBy(desc(auditLog.seq))
      .limit(200),
    () => db().select().from(criticalCalls).where(eq(criticalCalls.resultId, resultId)).orderBy(desc(criticalCalls.calledAt)),
  ]);
  const instrumentIds = [...new Set(attemptRows.map((a) => a.instrumentId).filter((x): x is string => !!x))];
  const [userMap, instrumentRows] = await inSequence([
    () => loadUserRefs([...attemptRows.map((a) => a.enteredBy), ...versionRows.map((v) => v.changedBy), ...callRows.map((c) => c.calledBy)]),
    () => instrumentIds.length ? db().select({ id: instruments.id, code: instruments.code, name: instruments.name }).from(instruments).where(inArray(instruments.id, instrumentIds)) : Promise.resolve([]),
  ]);
  const instrumentMap = new Map(instrumentRows.map((i) => [i.id, i]));
  const [current] = await db().select({ selectedAttemptId: results.selectedAttemptId }).from(results).where(eq(results.id, resultId));
  const decimals = result.analyte.decimals;
  return {
    result,
    attempts: attemptRows.map((a) => ({
      id: a.id,
      source: a.source,
      value: displayValue(a.valueNum, a.valueText, decimals),
      unit: a.unit,
      rawFlag: a.rawFlag,
      instrument: a.instrumentId ? (instrumentMap.get(a.instrumentId) ?? null) : null,
      dilution: a.dilution,
      isRerun: a.isRerun,
      measuredAt: iso(a.measuredAt),
      enteredBy: a.enteredBy ? (userMap.get(a.enteredBy) ?? null) : null,
      note: a.note,
      createdAt: a.createdAt.toISOString(),
      selected: a.id === current?.selectedAttemptId,
    })),
    versions: versionRows.map((v) => ({
      id: v.id,
      version: v.version,
      value: displayValue(v.valueNum, v.valueText, decimals),
      flag: v.flag,
      status: v.status,
      reason: v.reason,
      changedBy: v.changedBy ? (userMap.get(v.changedBy) ?? null) : null,
      changedAt: v.changedAt.toISOString(),
    })),
    audit: auditRows.map((a) => ({ id: a.id, action: a.action, summary: a.summary, actorName: a.actorName, at: a.at.toISOString() })),
    criticalCalls: callRows.map((c) => toCall(c, userMap)),
  };
}

function countStatuses(statuses: string[]): BenchResultCounts {
  const counts: BenchResultCounts = { pending: 0, resulted: 0, verified: 0, validated: 0, released: 0, total: statuses.length };
  for (const s of statuses) if (s in counts) counts[s as keyof Omit<BenchResultCounts, 'total'>] += 1;
  return counts;
}

/** Every result of an order, grouped by department and test (the order page's results tab). */
export async function getOrderResults(orderId: string, scope: Scope = {}): Promise<BenchOrderResults> {
  const [head] = await db()
    .select({
      o: orders,
      p: { id: patients.id, mrn: patients.mrn, fullNameAr: patients.fullNameAr, fullNameEn: patients.fullNameEn, sex: patients.sex, birthDate: patients.birthDate, phone: patients.phone },
      d: { nameAr: doctors.nameAr, nameEn: doctors.nameEn },
    })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .leftJoin(doctors, eq(doctors.id, orders.doctorId))
    .where(eq(orders.id, orderId));
  if (!head) throw notFound('order_not_found');
  const conds: Array<SQL | undefined> = [eq(results.orderId, orderId), ne(orderItems.status, 'cancelled')];
  if (scope.departmentIds?.length) conds.push(inArray(tests.departmentId, scope.departmentIds));
  const rows = await selectResultRows(and(...conds));
  const deptIds = [...new Set(rows.map((r) => r.t.departmentId))];
  const deptRows = deptIds.length ? await db().select().from(departments).where(inArray(departments.id, deptIds)) : [];
  const deptMap = new Map(deptRows.map((d) => [d.id, d]));
  rows.sort((x, y) => (deptMap.get(x.t.departmentId)?.sortOrder ?? 99) - (deptMap.get(y.t.departmentId)?.sortOrder ?? 99) || compareResultRows(x, y));
  const mapped = await toBenchResults(rows);
  const byId = new Map(mapped.map((r) => [r.id, r]));
  const calls = rows.length ? await db().select().from(criticalCalls).where(inArray(criticalCalls.resultId, rows.map((r) => r.r.id))).orderBy(desc(criticalCalls.calledAt)) : [];
  const callUsers = await loadUserRefs(calls.map((c) => c.calledBy));

  const sections: BenchOrderResults['sections'] = [];
  for (const row of rows) {
    const dept = deptMap.get(row.t.departmentId);
    let section = sections.find((s) => s.department.id === row.t.departmentId);
    if (!section) {
      section = { department: { id: row.t.departmentId, code: dept?.code ?? '', nameAr: dept?.nameAr ?? '', nameEn: dept?.nameEn ?? '' }, items: [] };
      sections.push(section);
    }
    let item = section.items.find((i) => i.orderItemId === row.item.id);
    if (!item) {
      item = {
        orderItemId: row.item.id,
        test: { id: row.t.id, code: row.t.code, nameAr: row.t.nameAr, nameEn: row.t.nameEn },
        status: row.item.status as BenchItemStatus,
        sample: row.s ? { id: row.s.id, barcode: row.s.barcode, status: row.s.status as BenchSampleStatus } : null,
        results: [],
      };
      section.items.push(item);
    }
    item.results.push(byId.get(row.r.id)!);
  }
  const called = new Set(calls.map((c) => c.resultId));
  return {
    order: orderRef(head.o),
    patient: patientRef(head.p),
    doctor: head.d ? { nameAr: head.d.nameAr, nameEn: head.d.nameEn } : null,
    sections,
    criticalCalls: calls.map((c) => toCall(c, callUsers)),
    summary: {
      ...countStatuses(rows.map((r) => r.r.status)),
      criticalUncalled: rows.filter((r) => r.r.isCritical && r.r.status !== 'released' && !called.has(r.r.id)).length,
    },
  };
}

/**
 * Orders with results waiting for medical validation, STAT/urgent first, then the oldest.
 * Each row says whether anything is still waiting for a value (allReady = false).
 */
export async function getValidationQueue(
  q: { departmentId?: string; priority?: 'routine' | 'urgent' | 'stat'; critical?: boolean; q?: string },
  scope: Scope = {},
): Promise<ValidationQueueRow[]> {
  const deptScope = q.departmentId ? [q.departmentId] : scope.departmentIds?.length ? scope.departmentIds : null;
  if (q.departmentId) assertDepartments([q.departmentId], scope.departmentIds);
  const conds: Array<SQL | undefined> = [ne(orders.status, 'cancelled'), notInArray(orderItems.status, ['cancelled', 'rejected'])];
  if (deptScope) conds.push(inArray(tests.departmentId, deptScope));
  if (q.priority) conds.push(eq(orders.priority, q.priority));
  if (q.q?.trim()) {
    const raw = q.q.trim();
    const term = normalizeText(raw).replace(/[%_]/g, '');
    conds.push(or(ilike(orders.accession, `${raw.replace(/[%_]/g, '')}%`), ilike(patients.mrn, `${raw.replace(/[%_]/g, '')}%`), term ? ilike(patients.searchText, `%${term}%`) : undefined));
  }
  const waiting = db()
    .selectDistinct({ id: results.orderId })
    .from(results)
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .where(and(inArray(results.status, ['resulted', 'verified']), notInArray(orderItems.status, ['cancelled', 'rejected']), deptScope ? inArray(tests.departmentId, deptScope) : undefined));
  conds.push(inArray(orders.id, waiting));
  const rows = await selectResultRows(and(...conds));
  if (!rows.length) return [];

  const ids = rows.map((r) => r.r.id);
  const [calls, deptRows, doctorRows] = await inSequence([
    () => db().selectDistinct({ resultId: criticalCalls.resultId }).from(criticalCalls).where(inArray(criticalCalls.resultId, ids)),
    () => db().select({ id: departments.id, code: departments.code, nameAr: departments.nameAr, nameEn: departments.nameEn, sortOrder: departments.sortOrder }).from(departments).orderBy(asc(departments.sortOrder)),
    () => db().select({ id: doctors.id, nameAr: doctors.nameAr, nameEn: doctors.nameEn }).from(doctors).where(inArray(doctors.id, [...new Set(rows.map((r) => r.o.doctorId).filter((x): x is string => !!x))])),
  ]);
  const called = new Set(calls.map((c) => c.resultId));
  const deptMap = new Map(deptRows.map((d) => [d.id, d]));
  const doctorMap = new Map(doctorRows.map((d) => [d.id, d]));

  const byOrder = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const list = byOrder.get(row.o.id) ?? [];
    list.push(row);
    byOrder.set(row.o.id, list);
  }
  const out: ValidationQueueRow[] = [];
  for (const list of byOrder.values()) {
    const first = list[0]!;
    const awaitingRows = list.filter((r) => AWAITING.has(r.r.status));
    const critical = awaitingRows.filter((r) => r.r.isCritical);
    const criticalUncalled = list.filter((r) => r.r.isCritical && r.r.status !== 'released' && !called.has(r.r.id)).length;
    if (q.critical && critical.length === 0) continue;
    const readyTimes = awaitingRows.map((r) => (r.r.verifiedAt ?? r.r.enteredAt ?? r.r.updatedAt).getTime());
    const depts = [...new Set(list.map((r) => r.t.departmentId))]
      .map((id) => deptMap.get(id))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .sort((x, y) => x.sortOrder - y.sortOrder)
      .map(({ id, code, nameAr, nameEn }) => ({ id, code, nameAr, nameEn }));
    const doctor = first.o.doctorId ? doctorMap.get(first.o.doctorId) : undefined;
    const counts = countStatuses(list.map((r) => r.r.status));
    out.push({
      order: orderRef(first.o),
      patient: patientRef(first.p),
      doctor: doctor ? { nameAr: doctor.nameAr, nameEn: doctor.nameEn } : null,
      departments: depts,
      counts,
      awaiting: awaitingRows.length,
      abnormal: awaitingRows.filter((r) => r.r.flag && r.r.flag !== 'N').length,
      critical: critical.length,
      criticalUncalled,
      delta: awaitingRows.filter((r) => r.r.deltaFlag).length,
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

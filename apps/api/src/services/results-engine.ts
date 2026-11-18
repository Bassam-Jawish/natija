import { and, desc, eq, inArray, lt, gt, ne, isNotNull, sql } from 'drizzle-orm';
import {
  analytes,
  orderItems,
  orders,
  patients,
  referenceRanges,
  resultAttempts,
  results,
  samples,
} from '@natija/db';
import {
  ageInDays,
  deltaExceeded,
  evaluateFormula,
  flagNumeric,
  flagText,
  formatRange,
  formulaVariables,
  parseNumericValue,
  selectRange,
  type ResultFlag,
} from '@natija/domain';
import { ctx, db } from '../db';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { publish } from '../lib/events';
import { getLab } from '../lib/lab';
import { notifyPermission } from '../lib/notify';
import { refreshOrderStatus } from './order-status';

export type ApplyResultInput = {
  resultId: string;
  /** As typed or as received: "5.4", "< 0.5", "Positive", or a number. Null/empty clears the value. */
  value: string | number | null;
  source: 'manual' | 'instrument' | 'calculated';
  instrumentId?: string | null;
  messageId?: string | null;
  dilution?: number | null;
  rawFlag?: string | null;
  measuredAt?: Date | null;
  isRerun?: boolean;
  note?: string | null;
  /** Unit after conversion (instrument results); defaults to the analyte's unit. */
  unit?: string | null;
  /** Skip the order status refresh (callers that apply many values refresh once at the end). */
  skipRefresh?: boolean;
};

export type ApplyResultOutput = {
  resultId: string;
  orderId: string;
  flag: ResultFlag | null;
  isCritical: boolean;
  /** True when the result was already validated/released: the attempt is kept but the value is not changed. */
  locked: boolean;
};

const LOCKED = new Set(['validated', 'released']);

/**
 * The single path every result value takes, manual or from an analyzer:
 * keep the attempt, pick the reference range for the patient's sex and age, flag it,
 * run the delta check, recalculate dependent calculated tests, refresh statuses,
 * alert validators about critical values, and write the audit entry.
 */
export async function applyResultValue(input: ApplyResultInput, depth = 0): Promise<ApplyResultOutput> {
  const { labId, userId } = ctx();
  const tx = db();
  const [row] = await tx
    .select({ r: results, a: analytes, o: orders, p: patients, sampleTypeId: samples.sampleTypeId })
    .from(results)
    .innerJoin(analytes, eq(analytes.id, results.analyteId))
    .innerJoin(orders, eq(orders.id, results.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .leftJoin(samples, eq(samples.id, orderItems.sampleId))
    .where(eq(results.id, input.resultId))
    .for('update', { of: results });
  if (!row) throw notFound('result_not_found');
  const { r, a, o, p } = row;

  // Parse the value according to the analyte's type.
  let valueNum: number | null = null;
  let valueText: string | null = null;
  const rawText = input.value === null || input.value === undefined ? '' : String(input.value).trim();
  if (a.resultType === 'numeric' || a.resultType === 'calculated') {
    const parsed = parseNumericValue(input.value);
    valueNum = parsed.value;
    valueText = rawText || null;
  } else {
    valueText = rawText || null;
  }
  const cleared = valueNum === null && !valueText;
  const unit = input.unit ?? a.unit ?? null;

  const [attempt] = await tx
    .insert(resultAttempts)
    .values({
      labId,
      resultId: r.id,
      source: input.source,
      valueNum,
      valueText,
      unit,
      rawFlag: input.rawFlag ?? null,
      instrumentId: input.instrumentId ?? null,
      messageId: input.messageId ?? null,
      dilution: input.dilution ?? null,
      isRerun: input.isRerun ?? false,
      measuredAt: input.measuredAt ?? new Date(),
      enteredBy: input.source === 'manual' ? userId : null,
      note: input.note ?? null,
    })
    .returning({ id: resultAttempts.id });

  if (LOCKED.has(r.status)) {
    return { resultId: r.id, orderId: o.id, flag: r.flag as ResultFlag | null, isCritical: r.isCritical, locked: true };
  }

  // Reference range for this patient at the time of the order.
  const ranges = await tx.select().from(referenceRanges).where(eq(referenceRanges.analyteId, a.id));
  const range = selectRange(ranges, {
    sex: p.sex,
    ageDays: ageInDays(p.birthDate, o.createdAt),
    sampleTypeId: row.sampleTypeId,
    instrumentId: input.instrumentId ?? null,
  });
  let flag: ResultFlag | null = null;
  let isCritical = false;
  if (!cleared) {
    if (valueNum !== null) ({ flag, isCritical } = flagNumeric(valueNum, range));
    else flag = flagText(valueText, range);
  }

  // Delta check against the patient's previous validated value for the same analyte.
  let deltaFlag = false;
  let deltaPrevValue: number | null = null;
  let deltaPrevAt: Date | null = null;
  if (valueNum !== null && a.deltaPct) {
    const lab = await getLab(labId);
    const windowDays = lab.settings.deltaCheckDays ?? 365;
    const [prev] = await tx
      .select({ value: results.valueNum, at: orders.createdAt })
      .from(results)
      .innerJoin(orders, eq(orders.id, results.orderId))
      .where(
        and(
          eq(orders.patientId, p.id),
          eq(results.analyteId, a.id),
          inArray(results.status, ['validated', 'released']),
          ne(results.id, r.id),
          isNotNull(results.valueNum),
          lt(orders.createdAt, o.createdAt),
          gt(orders.createdAt, new Date(o.createdAt.getTime() - windowDays * 86_400_000)),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(1);
    if (prev) {
      deltaPrevValue = prev.value;
      deltaPrevAt = prev.at;
      deltaFlag = deltaExceeded(valueNum, prev.value, a.deltaPct);
    }
  }

  const status = cleared ? 'pending' : 'resulted';
  await tx
    .update(results)
    .set({
      valueNum,
      valueText,
      unit,
      flag,
      refLow: range?.low ?? null,
      refHigh: range?.high ?? null,
      // The lab's printable text wins (e.g. "≥ 90", or vitamin D interpretation bands).
      refText: range ? range.textRange || formatRange(range, a.decimals) || null : null,
      critLow: range?.criticalLow ?? null,
      critHigh: range?.criticalHigh ?? null,
      isCritical,
      deltaFlag,
      deltaPrevValue,
      deltaPrevAt,
      selectedAttemptId: attempt!.id,
      instrumentId: input.instrumentId ?? (input.source === 'instrument' ? r.instrumentId : null),
      status,
      enteredBy: input.source === 'manual' ? userId : r.enteredBy,
      enteredAt: new Date(),
      verifiedBy: null,
      verifiedAt: null,
      version: sql`${results.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(results.id, r.id));

  await audit({
    action: input.source === 'manual' ? 'result.enter' : input.source === 'instrument' ? 'result.instrument' : 'result.calculate',
    entityType: 'result',
    entityId: r.id,
    summary: `${o.accession} ${a.code} = ${valueText ?? (valueNum ?? '')}${flag && flag !== 'N' ? ` (${flag})` : ''}`,
    before: { value: r.valueText ?? r.valueNum, flag: r.flag, status: r.status },
    after: { value: valueText ?? valueNum, flag, status, attemptId: attempt!.id },
  });

  if (isCritical && !r.isCritical) {
    await notifyPermission('results.validate', {
      kind: 'critical',
      severity: 'critical',
      titleAr: `نتيجة حرجة: ${a.nameAr}`,
      titleEn: `Critical result: ${a.nameEn}`,
      bodyAr: `${valueText ?? valueNum} ${unit ?? ''} · الطلب ${o.accession} · ${p.fullNameAr}`,
      bodyEn: `${valueText ?? valueNum} ${unit ?? ''} · order ${o.accession}`,
      link: `/orders/${o.id}`,
      entityType: 'result',
      entityId: r.id,
    });
  }

  if (depth < 3 && a.resultType !== 'calculated') {
    await recalculateDependents(o.id, a.code, depth + 1);
  }
  if (!input.skipRefresh && depth === 0) await refreshOrderStatus(o.id);
  publish({ type: 'results.changed', data: { orderId: o.id, resultId: r.id } });

  return { resultId: r.id, orderId: o.id, flag, isCritical, locked: false };
}

/** Recompute calculated analytes in an order whose formula uses `changedCode`. */
export async function recalculateDependents(orderId: string, changedCode: string | null, depth = 1): Promise<void> {
  const tx = db();
  const rows = await tx
    .select({ r: results, a: analytes, birthDate: patients.birthDate, sex: patients.sex, createdAt: orders.createdAt })
    .from(results)
    .innerJoin(analytes, eq(analytes.id, results.analyteId))
    .innerJoin(orders, eq(orders.id, results.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .where(eq(results.orderId, orderId));
  if (!rows.length) return;
  const values: Record<string, number | null> = {};
  for (const row of rows) values[row.a.code] = row.r.valueNum;
  const first = rows[0]!;
  values.AGE = Math.floor(ageInDays(first.birthDate, first.createdAt) / 365.25);
  values.FEMALE = first.sex === 'female' ? 1 : 0;

  for (const row of rows) {
    if (row.a.resultType !== 'calculated' || !row.a.formula) continue;
    if (LOCKED.has(row.r.status)) continue;
    const vars = formulaVariables(row.a.formula);
    if (changedCode && !vars.includes(changedCode)) continue;
    const computed = evaluateFormula(row.a.formula, values);
    const rounded = computed === null ? null : Number(computed.toFixed(Math.max(0, row.a.decimals)));
    if (rounded === row.r.valueNum) continue;
    await applyResultValue({ resultId: row.r.id, value: rounded, source: 'calculated', skipRefresh: true }, depth);
  }
}

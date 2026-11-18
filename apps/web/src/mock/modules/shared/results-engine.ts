/**
 * The single path every result value takes, manual or from an analyzer (port of
 * apps/api/src/services/results-engine.ts): keep the attempt, pick the reference range for the
 * patient's sex and age, flag it, run the delta check, recalculate dependent calculated tests,
 * refresh statuses, alert validators about critical values, and write the audit entry.
 */
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
import { ctx, notFound, now } from '../../core/context';
import { by, find, insert, update } from '../../core/db';
import { audit, getLab, notifyPermission, publish } from '../../core/lib';
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

export function applyResultValue(input: ApplyResultInput, depth = 0): ApplyResultOutput {
  const { userId } = ctx();
  const r = find('results', input.resultId);
  if (!r) throw notFound('result_not_found');
  const a = find('analytes', r.analyteId);
  const o = find('orders', r.orderId);
  const p = o ? find('patients', o.patientId) : undefined;
  const item = find('orderItems', r.orderItemId);
  if (!a || !o || !p || !item) throw notFound('result_not_found');
  const sample = item.sampleId ? find('samples', item.sampleId) : undefined;

  let valueNum: number | null = null;
  let valueText: string | null = null;
  const rawText = input.value === null || input.value === undefined ? '' : String(input.value).trim();
  if (a.resultType === 'numeric' || a.resultType === 'calculated') {
    valueNum = parseNumericValue(input.value).value;
    valueText = rawText || null;
  } else {
    valueText = rawText || null;
  }
  const cleared = valueNum === null && !valueText;
  const unit = input.unit ?? a.unit ?? null;

  const attempt = insert('resultAttempts', {
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
    measuredAt: input.measuredAt ?? now(),
    enteredBy: input.source === 'manual' ? userId : null,
    note: input.note ?? null,
  });

  if (LOCKED.has(r.status)) {
    return { resultId: r.id, orderId: o.id, flag: r.flag as ResultFlag | null, isCritical: r.isCritical, locked: true };
  }

  const range = selectRange(by('referenceRanges', 'analyteId', a.id), {
    sex: p.sex,
    ageDays: ageInDays(p.birthDate, o.createdAt),
    sampleTypeId: sample?.sampleTypeId ?? null,
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
    const windowDays = getLab().settings.deltaCheckDays ?? 365;
    const since = o.createdAt.getTime() - windowDays * 86_400_000;
    let prev: { value: number; at: Date } | null = null;
    for (const other of by('orders', 'patientId', p.id)) {
      if (other.createdAt >= o.createdAt || other.createdAt.getTime() <= since) continue;
      if (prev && other.createdAt <= prev.at) continue;
      const hit = by('results', 'orderId', other.id).find(
        (x) => x.analyteId === a.id && x.id !== r.id && x.valueNum !== null && (x.status === 'validated' || x.status === 'released'),
      );
      if (hit) prev = { value: hit.valueNum!, at: other.createdAt };
    }
    if (prev) {
      deltaPrevValue = prev.value;
      deltaPrevAt = prev.at;
      deltaFlag = deltaExceeded(valueNum, prev.value, a.deltaPct);
    }
  }

  const status = cleared ? 'pending' : 'resulted';
  const before = { value: r.valueText ?? r.valueNum, flag: r.flag, status: r.status };
  const wasCritical = r.isCritical;
  update('results', r, {
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
    selectedAttemptId: attempt.id,
    instrumentId: input.instrumentId ?? (input.source === 'instrument' ? r.instrumentId : null),
    status,
    enteredBy: input.source === 'manual' ? userId : r.enteredBy,
    enteredAt: now(),
    verifiedBy: null,
    verifiedAt: null,
    version: r.version + 1,
    updatedAt: now(),
  });
  audit({
    action: input.source === 'manual' ? 'result.enter' : input.source === 'instrument' ? 'result.instrument' : 'result.calculate',
    entityType: 'result',
    entityId: r.id,
    summary: `${o.accession} ${a.code} = ${valueText ?? valueNum ?? ''}${flag && flag !== 'N' ? ` (${flag})` : ''}`,
    before,
    after: { value: valueText ?? valueNum, flag, status, attemptId: attempt.id },
  });

  if (isCritical && !wasCritical) {
    notifyPermission('results.validate', {
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

  if (depth < 3 && a.resultType !== 'calculated') recalculateDependents(o.id, a.code, depth + 1);
  if (!input.skipRefresh && depth === 0) refreshOrderStatus(o.id);
  publish({ type: 'results.changed', data: { orderId: o.id, resultId: r.id } });
  return { resultId: r.id, orderId: o.id, flag, isCritical, locked: false };
}

/** Recompute calculated analytes in an order whose formula uses `changedCode`. */
export function recalculateDependents(orderId: string, changedCode: string | null, depth = 1): void {
  const order = find('orders', orderId);
  if (!order) return;
  const patient = find('patients', order.patientId);
  const list = by('results', 'orderId', orderId)
    .map((r) => ({ r, a: find('analytes', r.analyteId) }))
    .filter((x): x is { r: (typeof x)['r']; a: NonNullable<(typeof x)['a']> } => !!x.a);
  if (!list.length || !patient) return;
  const values: Record<string, number | null> = {};
  for (const { r, a } of list) values[a.code] = r.valueNum;
  values.AGE = Math.floor(ageInDays(patient.birthDate, order.createdAt) / 365.25);
  values.FEMALE = patient.sex === 'female' ? 1 : 0;
  for (const { r, a } of list) {
    if (a.resultType !== 'calculated' || !a.formula) continue;
    if (LOCKED.has(r.status)) continue;
    if (changedCode && !formulaVariables(a.formula).includes(changedCode)) continue;
    const computed = evaluateFormula(a.formula, values);
    const rounded = computed === null ? null : Number(computed.toFixed(Math.max(0, a.decimals)));
    if (rounded === r.valueNum) continue;
    applyResultValue({ resultId: r.id, value: rounded, source: 'calculated', skipRefresh: true }, depth);
  }
}

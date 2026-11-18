/**
 * One QC result judged with the Westgard rules (port of apps/api/src/modules/qc/runs.ts): the
 * new value is judged against the material's target mean and SD together with its recent runs
 * (rejected runs are left out: they were followed by corrective action). A rejected run alerts
 * everyone who manages analyzers.
 */
import { westgard } from '@natija/domain';
import { ctx, now } from '../../core/context';
import { by, find, insert, type Row } from '../../core/db';
import { audit, notifyPermission } from '../../core/lib';

export type QcMaterialRow = Row<'qcMaterials'>;
export type QcRunRow = Row<'qcRuns'>;

/** Runs judged together with the new one (the 10x rule needs ten). */
const WINDOW = 20;

export function recordQcRun(input: {
  material: QcMaterialRow;
  value: number;
  runAt?: Date;
  source: 'manual' | 'instrument';
  note?: string | null;
  userId?: string | null;
}): QcRunRow {
  const { labId } = ctx();
  const runAt = input.runAt ?? now();
  const m = input.material;
  const history = by('qcRuns', 'materialId', m.id)
    .filter((r) => r.runAt.getTime() <= runAt.getTime() && r.status !== 'rejected')
    .sort((a, b) => b.runAt.getTime() - a.runAt.getTime())
    .slice(0, WINDOW - 1);
  const series = [...history.reverse().map((h) => h.value), input.value];
  const verdict = westgard(series, m.targetMean, m.targetSd);
  const run = insert('qcRuns', {
    labId,
    materialId: m.id,
    value: input.value,
    runAt,
    userId: input.userId ?? null,
    source: input.source,
    status: verdict.status,
    violations: verdict.violations,
    note: input.note ?? null,
    createdAt: now(),
  });
  const analyte = find('analytes', m.analyteId);
  const label = `${analyte?.code ?? ''} ${m.name} ${m.level} (lot ${m.lot})`.trim();
  audit({
    action: 'qc.run',
    entityType: 'qc_run',
    entityId: run.id,
    summary: `${label} = ${input.value}: ${verdict.status}${verdict.violations.length ? ` (${verdict.violations.join(', ')})` : ''}`,
    after: { value: input.value, status: verdict.status, violations: verdict.violations, source: input.source },
  });
  if (verdict.status === 'rejected') {
    notifyPermission('instruments.manage', {
      kind: 'instrument',
      severity: 'warning',
      titleAr: `رفض تشغيل ضبط الجودة: ${analyte?.nameAr ?? m.name}`,
      titleEn: `QC run rejected: ${analyte?.nameEn ?? m.name}`,
      bodyAr: `${m.name} ${m.level} = ${input.value} · ${verdict.violations.join('، ')}`,
      bodyEn: `${label} = ${input.value} · ${verdict.violations.join(', ')}`,
      link: `/qc/materials/${m.id}`,
      entityType: 'qc_run',
      entityId: run.id,
    });
  }
  return run;
}

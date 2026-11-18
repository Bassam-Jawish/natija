import { and, desc, eq, lte, ne } from 'drizzle-orm';
import { analytes, qcMaterials, qcRuns } from '@natija/db';
import { westgard } from '@natija/domain';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { notifyPermission } from '../../lib/notify';

export type QcMaterialRow = typeof qcMaterials.$inferSelect;
export type QcRunRow = typeof qcRuns.$inferSelect;

/** Runs judged together with the new one (the 10x rule needs ten). */
const WINDOW = 20;

/**
 * Record one QC result and judge it with the Westgard rules against the material's target
 * mean and SD, using the material's recent runs (rejected runs are left out: they were
 * followed by corrective action). A rejected run alerts everyone who manages analyzers.
 */
export async function recordQcRun(input: {
  material: QcMaterialRow;
  value: number;
  runAt?: Date;
  source: 'manual' | 'instrument';
  note?: string | null;
  userId?: string | null;
}): Promise<QcRunRow> {
  const { labId } = ctx();
  const tx = db();
  const runAt = input.runAt ?? new Date();
  const m = input.material;
  const history = await tx
    .select({ value: qcRuns.value })
    .from(qcRuns)
    .where(and(eq(qcRuns.materialId, m.id), lte(qcRuns.runAt, runAt), ne(qcRuns.status, 'rejected')))
    .orderBy(desc(qcRuns.runAt))
    .limit(WINDOW - 1);
  const series = [...history.reverse().map((h) => h.value), input.value];
  const verdict = westgard(series, m.targetMean, m.targetSd);
  const [run] = await tx
    .insert(qcRuns)
    .values({
      labId,
      materialId: m.id,
      value: input.value,
      runAt,
      userId: input.userId ?? null,
      source: input.source,
      status: verdict.status,
      violations: verdict.violations,
      note: input.note ?? null,
    })
    .returning();
  const [analyte] = await tx.select({ code: analytes.code, nameAr: analytes.nameAr, nameEn: analytes.nameEn }).from(analytes).where(eq(analytes.id, m.analyteId));
  const label = `${analyte?.code ?? ''} ${m.name} ${m.level} (lot ${m.lot})`.trim();
  await audit({
    action: 'qc.run',
    entityType: 'qc_run',
    entityId: run!.id,
    summary: `${label} = ${input.value}: ${verdict.status}${verdict.violations.length ? ` (${verdict.violations.join(', ')})` : ''}`,
    after: { value: input.value, status: verdict.status, violations: verdict.violations, source: input.source },
  });
  if (verdict.status === 'rejected') {
    await notifyPermission('instruments.manage', {
      kind: 'instrument',
      severity: 'warning',
      titleAr: `رفض تشغيل ضبط الجودة: ${analyte?.nameAr ?? m.name}`,
      titleEn: `QC run rejected: ${analyte?.nameEn ?? m.name}`,
      bodyAr: `${m.name} ${m.level} = ${input.value} · ${verdict.violations.join('، ')}`,
      bodyEn: `${label} = ${input.value} · ${verdict.violations.join(', ')}`,
      link: `/qc/materials/${m.id}`,
      entityType: 'qc_run',
      entityId: run!.id,
    });
  }
  return run!;
}

/**
 * Quality control: QC materials (target mean and SD per analyte, lot and level), QC runs
 * judged with the Westgard rules, Levey-Jennings chart data, and instrument maintenance logs.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, gte, inArray, lt, or, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { analytes, instruments, maintenanceLogs, qcMaterials, qcRuns, users } from '@natija/db';
import {
  maintenanceBody,
  maintenanceQuery,
  qcChartQuery,
  qcMaterialBody,
  qcMaterialsQuery,
  qcMaterialUpdateBody,
  qcRunBody,
  qcRunsQuery,
  type MaintenanceItem,
  type QcChart,
  type QcMaterialItem,
  type QcRunItem,
  type StaffRef,
} from '@natija/contracts';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { assertFound, badRequest, conflict } from '../../lib/errors';
import { dayRange, page, parse } from '../../lib/http';
import { iso } from '../../services/ingest';
import { recordQcRun, type QcMaterialRow, type QcRunRow } from './runs';

const idParams = z.object({ id: z.string().uuid() });

async function checkRefs(input: { instrumentId?: string | null; analyteId?: string }): Promise<void> {
  if (input.instrumentId) {
    const [i] = await db().select({ id: instruments.id }).from(instruments).where(eq(instruments.id, input.instrumentId));
    if (!i) throw badRequest('instrument_not_found');
  }
  if (input.analyteId) {
    const [a] = await db().select({ id: analytes.id }).from(analytes).where(eq(analytes.id, input.analyteId));
    if (!a) throw badRequest('analyte_not_found');
  }
}

async function materialItems(rows: QcMaterialRow[]): Promise<QcMaterialItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const analyteRows = await db()
    .select({ id: analytes.id, code: analytes.code, nameEn: analytes.nameEn, nameAr: analytes.nameAr, unit: analytes.unit })
    .from(analytes)
    .where(inArray(analytes.id, [...new Set(rows.map((r) => r.analyteId))]));
  const instIds = [...new Set(rows.map((r) => r.instrumentId).filter((x): x is string => !!x))];
  const instRows = instIds.length
    ? await db().select({ id: instruments.id, code: instruments.code, name: instruments.name }).from(instruments).where(inArray(instruments.id, instIds))
    : [];
  const since = new Date(Date.now() - 30 * 86_400_000);
  const counts = await db()
    .select({ materialId: qcRuns.materialId, n: count() })
    .from(qcRuns)
    .where(and(inArray(qcRuns.materialId, ids), gte(qcRuns.runAt, since)))
    .groupBy(qcRuns.materialId);
  const last = await db()
    .selectDistinctOn([qcRuns.materialId])
    .from(qcRuns)
    .where(inArray(qcRuns.materialId, ids))
    .orderBy(qcRuns.materialId, desc(qcRuns.runAt));
  return rows.map((m) => {
    const lastRun = last.find((r) => r.materialId === m.id);
    return {
      id: m.id,
      instrument: instRows.find((i) => i.id === m.instrumentId) ?? null,
      analyte: analyteRows.find((a) => a.id === m.analyteId)!,
      name: m.name,
      lot: m.lot,
      level: m.level,
      targetMean: m.targetMean,
      targetSd: m.targetSd,
      unit: m.unit,
      expiresOn: m.expiresOn,
      isActive: m.isActive,
      createdAt: m.createdAt.toISOString(),
      lastRun: lastRun ? { id: lastRun.id, value: lastRun.value, runAt: lastRun.runAt.toISOString(), status: lastRun.status, violations: lastRun.violations } : null,
      runs30d: counts.find((c) => c.materialId === m.id)?.n ?? 0,
    };
  });
}

async function loadMaterial(id: string): Promise<QcMaterialRow> {
  const [row] = await db().select().from(qcMaterials).where(eq(qcMaterials.id, id));
  return assertFound(row, 'qc_material_not_found');
}

type Names = { fullNameAr: string | null; fullNameEn: string | null };

function staff(id: string | null, n: Names | null): StaffRef | null {
  return id ? { id, fullNameAr: n?.fullNameAr ?? '', fullNameEn: n?.fullNameEn ?? '' } : null;
}

function runItem(r: QcRunRow, material: { targetMean: number; targetSd: number }, user: Names | null): QcRunItem {
  return {
    id: r.id,
    materialId: r.materialId,
    value: r.value,
    z: material.targetSd > 0 ? (r.value - material.targetMean) / material.targetSd : null,
    runAt: r.runAt.toISOString(),
    user: staff(r.userId, user),
    source: r.source,
    status: r.status,
    violations: r.violations,
    note: r.note,
  };
}

function maintenanceItem(
  m: typeof maintenanceLogs.$inferSelect,
  inst: { id: string; code: string; name: string },
  user: Names | null,
): MaintenanceItem {
  return {
    id: m.id,
    instrument: inst,
    kind: m.kind,
    performedAt: m.performedAt.toISOString(),
    performedBy: staff(m.performedBy, user),
    performedByName: m.performedByName,
    nextDueAt: iso(m.nextDueAt),
    overdue: !!m.nextDueAt && m.nextDueAt < new Date(),
    description: m.description,
    outcome: m.outcome,
    createdAt: m.createdAt.toISOString(),
  };
}

export default async function qcRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- materials */

  app.get('/materials', { config: { perm: 'qc.read' } }, async (req): Promise<QcMaterialItem[]> => {
    const q = parse(qcMaterialsQuery, req.query);
    const conditions: SQL[] = [];
    if (q.instrumentId) conditions.push(or(eq(qcMaterials.instrumentId, q.instrumentId), isNull(qcMaterials.instrumentId))!);
    if (q.analyteId) conditions.push(eq(qcMaterials.analyteId, q.analyteId));
    if (q.active !== 'all') conditions.push(eq(qcMaterials.isActive, q.active === 'true'));
    const rows = await db()
      .select()
      .from(qcMaterials)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(qcMaterials.name), asc(qcMaterials.level), asc(qcMaterials.createdAt));
    return materialItems(rows);
  });

  app.get('/materials/:id', { config: { perm: 'qc.read' } }, async (req): Promise<QcMaterialItem> => {
    const { id } = parse(idParams, req.params);
    const [item] = await materialItems([await loadMaterial(id)]);
    return item!;
  });

  app.post('/materials', { config: { perm: 'qc.write' } }, async (req, reply): Promise<QcMaterialItem> => {
    const body = parse(qcMaterialBody, req.body);
    await checkRefs(body);
    const [row] = await db()
      .insert(qcMaterials)
      .values({
        labId: ctx().labId,
        instrumentId: body.instrumentId ?? null,
        analyteId: body.analyteId,
        name: body.name,
        lot: body.lot,
        level: body.level,
        targetMean: body.targetMean,
        targetSd: body.targetSd,
        unit: body.unit ?? null,
        expiresOn: body.expiresOn ?? null,
        isActive: body.isActive ?? true,
      })
      .returning();
    await audit({ action: 'qc.material_create', entityType: 'qc_material', entityId: row!.id, summary: `${row!.name} ${row!.level} lot ${row!.lot}: ${row!.targetMean} ± ${row!.targetSd}`, after: row });
    reply.status(201);
    const [item] = await materialItems([row!]);
    return item!;
  });

  app.patch('/materials/:id', { config: { perm: 'qc.write' } }, async (req): Promise<QcMaterialItem> => {
    const { id } = parse(idParams, req.params);
    const body = parse(qcMaterialUpdateBody, req.body);
    const before = await loadMaterial(id);
    await checkRefs(body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) {
      const [same] = await materialItems([before]);
      return same!;
    }
    const [after] = await db().update(qcMaterials).set(patch).where(eq(qcMaterials.id, id)).returning();
    const changed = Object.keys(patch) as Array<keyof QcMaterialRow>;
    await audit({
      action: 'qc.material_update',
      entityType: 'qc_material',
      entityId: id,
      summary: `${after!.name} ${after!.level} lot ${after!.lot}: ${changed.join(', ')}`,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, after![k]])),
    });
    const [item] = await materialItems([after!]);
    return item!;
  });

  /** QC history is kept: a material with runs can only be deactivated. */
  app.delete('/materials/:id', { config: { perm: 'qc.write' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const material = await loadMaterial(id);
    const [runs] = await db().select({ n: count() }).from(qcRuns).where(eq(qcRuns.materialId, id));
    if ((runs?.n ?? 0) > 0) throw conflict('qc_material_has_runs', 'This material has QC runs; deactivate it instead of deleting it');
    await db().delete(qcMaterials).where(eq(qcMaterials.id, id));
    await audit({ action: 'qc.material_delete', entityType: 'qc_material', entityId: id, summary: `${material.name} ${material.level} lot ${material.lot} deleted`, before: material });
    return { ok: true };
  });

  /** Levey-Jennings data: target mean, ±1/2/3 SD lines and the runs as points. */
  app.get('/materials/:id/chart', { config: { perm: 'qc.read' } }, async (req): Promise<QcChart> => {
    const { id } = parse(idParams, req.params);
    const q = parse(qcChartQuery, req.query);
    const material = await loadMaterial(id);
    const conditions: SQL[] = [eq(qcRuns.materialId, id)];
    if (q.from || q.to) {
      const { start, end } = await dayRange(q.from, q.to);
      conditions.push(gte(qcRuns.runAt, start), lt(qcRuns.runAt, end));
    }
    const rows = (await db().select().from(qcRuns).where(and(...conditions)).orderBy(desc(qcRuns.runAt)).limit(q.limit)).reverse();
    const { targetMean: mean, targetSd: sd } = material;
    const values = rows.map((r) => r.value);
    const n = values.length;
    const observedMean = n ? values.reduce((s, v) => s + v, 0) / n : null;
    const observedSd = n > 1 && observedMean !== null ? Math.sqrt(values.reduce((s, v) => s + (v - observedMean) ** 2, 0) / (n - 1)) : null;
    const [item] = await materialItems([material]);
    return {
      material: item!,
      mean,
      sd,
      lines: { mean, plus1: mean + sd, plus2: mean + 2 * sd, plus3: mean + 3 * sd, minus1: mean - sd, minus2: mean - 2 * sd, minus3: mean - 3 * sd },
      points: rows.map((r) => ({ id: r.id, runAt: r.runAt.toISOString(), value: r.value, z: sd > 0 ? (r.value - mean) / sd : 0, status: r.status, violations: r.violations, source: r.source })),
      stats: {
        n,
        observedMean,
        observedSd,
        cvPct: observedMean && observedSd !== null ? (observedSd / Math.abs(observedMean)) * 100 : null,
      },
    };
  });

  /* ---------------------------------------------------------------- runs */

  app.get('/runs', { config: { perm: 'qc.read' } }, async (req) => {
    const q = parse(qcRunsQuery, req.query);
    const conditions: SQL[] = [];
    if (q.materialId) conditions.push(eq(qcRuns.materialId, q.materialId));
    if (q.instrumentId) conditions.push(eq(qcMaterials.instrumentId, q.instrumentId));
    if (q.status) conditions.push(eq(qcRuns.status, q.status));
    if (q.from || q.to) {
      const { start, end } = await dayRange(q.from, q.to);
      conditions.push(gte(qcRuns.runAt, start), lt(qcRuns.runAt, end));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db()
      .select({ r: qcRuns, mean: qcMaterials.targetMean, sd: qcMaterials.targetSd, user: { fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn } })
      .from(qcRuns)
      .innerJoin(qcMaterials, eq(qcMaterials.id, qcRuns.materialId))
      .leftJoin(users, eq(users.id, qcRuns.userId))
      .where(where)
      .orderBy(desc(qcRuns.runAt))
      .limit(q.limit)
      .offset(q.offset);
    const [total] = await db().select({ n: count() }).from(qcRuns).innerJoin(qcMaterials, eq(qcMaterials.id, qcRuns.materialId)).where(where);
    return page(
      rows.map((x) => runItem(x.r, { targetMean: x.mean, targetSd: x.sd }, x.user)),
      total?.n ?? 0,
    );
  });

  app.post('/runs', { config: { perm: 'qc.write' } }, async (req, reply): Promise<QcRunItem> => {
    const body = parse(qcRunBody, req.body);
    const material = await loadMaterial(body.materialId);
    if (!material.isActive) throw conflict('qc_material_inactive');
    const run = await recordQcRun({
      material,
      value: body.value,
      runAt: body.runAt ? new Date(body.runAt) : undefined,
      source: 'manual',
      note: body.note ?? null,
      userId: req.auth!.userId,
    });
    reply.status(201);
    return runItem(run, material, req.auth!.user);
  });

  /* ---------------------------------------------------------------- maintenance */

  app.get('/maintenance', { config: { perm: 'qc.read' } }, async (req) => {
    const q = parse(maintenanceQuery, req.query);
    const conditions: SQL[] = [];
    if (q.instrumentId) conditions.push(eq(maintenanceLogs.instrumentId, q.instrumentId));
    if (q.kind) conditions.push(eq(maintenanceLogs.kind, q.kind));
    if (q.from || q.to) {
      const { start, end } = await dayRange(q.from, q.to);
      conditions.push(gte(maintenanceLogs.performedAt, start), lt(maintenanceLogs.performedAt, end));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db()
      .select({ m: maintenanceLogs, inst: { id: instruments.id, code: instruments.code, name: instruments.name }, user: { fullNameAr: users.fullNameAr, fullNameEn: users.fullNameEn } })
      .from(maintenanceLogs)
      .innerJoin(instruments, eq(instruments.id, maintenanceLogs.instrumentId))
      .leftJoin(users, eq(users.id, maintenanceLogs.performedBy))
      .where(where)
      .orderBy(desc(maintenanceLogs.performedAt))
      .limit(q.limit)
      .offset(q.offset);
    const [total] = await db().select({ n: count() }).from(maintenanceLogs).where(where);
    return page(
      rows.map((r) => maintenanceItem(r.m, r.inst, r.user)),
      total?.n ?? 0,
    );
  });

  app.post('/maintenance', { config: { perm: 'qc.write' } }, async (req, reply): Promise<MaintenanceItem> => {
    const body = parse(maintenanceBody, req.body);
    const [inst] = await db().select({ id: instruments.id, code: instruments.code, name: instruments.name }).from(instruments).where(eq(instruments.id, body.instrumentId));
    if (!inst) throw badRequest('instrument_not_found');
    const auth = req.auth!;
    const [row] = await db()
      .insert(maintenanceLogs)
      .values({
        labId: ctx().labId,
        instrumentId: inst.id,
        kind: body.kind,
        performedAt: body.performedAt ? new Date(body.performedAt) : new Date(),
        performedBy: auth.userId,
        performedByName: body.performedByName ?? null,
        nextDueAt: body.nextDueAt ? new Date(body.nextDueAt) : null,
        description: body.description ?? null,
        outcome: body.outcome,
      })
      .returning();
    await audit({
      action: 'qc.maintenance',
      entityType: 'maintenance_log',
      entityId: row!.id,
      summary: `${inst.code}: ${body.kind} maintenance (${body.outcome})${body.description ? ` – ${body.description.slice(0, 80)}` : ''}`,
      after: row,
    });
    reply.status(201);
    return maintenanceItem(row!, inst, auth.user);
  });
}

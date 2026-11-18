/**
 * /qc routes (port of apps/api/src/modules/qc/routes.ts): QC materials (target mean and SD per
 * analyte, lot and level), QC runs judged with the Westgard rules (qc-runs.ts), Levey-Jennings
 * chart data, and the instrument maintenance log (the QC page builds the due list from it).
 */
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
import { badRequest, conflict, ctx, now } from '../../core/context';
import { by, find, get, insert, remove, rows, update, type Row } from '../../core/db';
import { audit, dayRange, page, parse } from '../../core/lib';
import { route } from '../../core/router';
import { byText, newestFirst, typedNumber, typedText } from './helpers';
import { iso } from './ingest';
import { recordQcRun, type QcMaterialRow, type QcRunRow } from './qc-runs';

const DAY = 86_400_000;

function checkRefs(input: { instrumentId?: string | null; analyteId?: string }): void {
  if (input.instrumentId && !find('instruments', input.instrumentId)) throw badRequest('instrument_not_found');
  if (input.analyteId && !find('analytes', input.analyteId)) throw badRequest('analyte_not_found');
}

function materialItems(list: QcMaterialRow[]): QcMaterialItem[] {
  const since = now().getTime() - 30 * DAY;
  return list.map((m) => {
    const a = find('analytes', m.analyteId);
    const inst = m.instrumentId ? find('instruments', m.instrumentId) : undefined;
    const runs = by('qcRuns', 'materialId', m.id);
    const lastRun = newestFirst(runs, (r) => r.runAt)[0];
    return {
      id: m.id,
      instrument: inst ? { id: inst.id, code: inst.code, name: inst.name } : null,
      analyte: a ? { id: a.id, code: a.code, nameEn: a.nameEn, nameAr: a.nameAr, unit: a.unit } : { id: m.analyteId, code: '?', nameEn: '', nameAr: '', unit: null },
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
      runs30d: runs.filter((r) => r.runAt.getTime() >= since).length,
    };
  });
}

function loadMaterial(id: string | undefined): QcMaterialRow {
  return get('qcMaterials', id, 'qc_material_not_found');
}

type Names = { fullNameAr: string | null; fullNameEn: string | null };

function staff(id: string | null, n: Names | null | undefined): StaffRef | null {
  return id ? { id, fullNameAr: n?.fullNameAr ?? '', fullNameEn: n?.fullNameEn ?? '' } : null;
}

function runItem(r: QcRunRow, material: { targetMean: number; targetSd: number }, user: Names | null | undefined): QcRunItem {
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

function maintenanceItem(m: Row<'maintenanceLogs'>, inst: { id: string; code: string; name: string }, user: Names | null | undefined): MaintenanceItem {
  return {
    id: m.id,
    instrument: inst,
    kind: m.kind,
    performedAt: m.performedAt.toISOString(),
    performedBy: staff(m.performedBy, user),
    performedByName: m.performedByName,
    nextDueAt: iso(m.nextDueAt),
    overdue: !!m.nextDueAt && m.nextDueAt.getTime() < now().getTime(),
    description: m.description,
    outcome: m.outcome,
    createdAt: m.createdAt.toISOString(),
  };
}

const inRange = (at: Date, range: { start: Date; end: Date } | null) => !range || (at >= range.start && at < range.end);

export function registerQcRoutes(): void {
  /* ---------------------------------------------------------------- materials */

  route('GET', '/qc/materials', { perm: 'qc.read' }, (req): QcMaterialItem[] => {
    const q = parse(qcMaterialsQuery, req.query);
    const active = q.active ?? 'true';
    const list = rows('qcMaterials')
      .filter(
        (m) =>
          (!q.instrumentId || m.instrumentId === q.instrumentId || m.instrumentId === null) &&
          (!q.analyteId || m.analyteId === q.analyteId) &&
          (active === 'all' || m.isActive === (active === 'true')),
      )
      .sort((a, b) => byText(a.name, b.name) || byText(a.level, b.level) || a.createdAt.getTime() - b.createdAt.getTime());
    return materialItems(list);
  });

  route('GET', '/qc/materials/:id', { perm: 'qc.read' }, (req): QcMaterialItem => materialItems([loadMaterial(req.params.id)])[0]!);

  route('POST', '/qc/materials', { perm: 'qc.write' }, (req): QcMaterialItem => {
    const body = parse(qcMaterialBody, req.body);
    checkRefs(body);
    if (!body.analyteId) throw badRequest('analyte_not_found');
    const row = insert('qcMaterials', {
      labId: ctx().labId,
      instrumentId: body.instrumentId ?? null,
      analyteId: body.analyteId,
      name: body.name ?? typedText(req.body, 'name') ?? '',
      lot: body.lot ?? typedText(req.body, 'lot') ?? '',
      level: body.level ?? typedText(req.body, 'level') ?? '',
      targetMean: body.targetMean ?? typedNumber(req.body, 'targetMean'),
      targetSd: body.targetSd ?? typedNumber(req.body, 'targetSd'),
      unit: body.unit ?? null,
      expiresOn: body.expiresOn ?? null,
      isActive: body.isActive ?? true,
      createdAt: now(),
    });
    audit({ action: 'qc.material_create', entityType: 'qc_material', entityId: row.id, summary: `${row.name} ${row.level} lot ${row.lot}: ${row.targetMean} ± ${row.targetSd}`, after: { ...row } });
    return materialItems([row])[0]!;
  });

  route('PATCH', '/qc/materials/:id', { perm: 'qc.write' }, (req): QcMaterialItem => {
    const body = parse(qcMaterialUpdateBody, req.body);
    const material = loadMaterial(req.params.id);
    const before = { ...material };
    checkRefs(body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<QcMaterialRow>;
    if (!Object.keys(patch).length) return materialItems([material])[0]!;
    update('qcMaterials', material, patch);
    const changed = Object.keys(patch) as Array<keyof QcMaterialRow>;
    audit({
      action: 'qc.material_update',
      entityType: 'qc_material',
      entityId: material.id,
      summary: `${material.name} ${material.level} lot ${material.lot}: ${changed.join(', ')}`,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, material[k]])),
    });
    return materialItems([material])[0]!;
  });

  /** QC history is kept: a material with runs can only be deactivated. */
  route('DELETE', '/qc/materials/:id', { perm: 'qc.write' }, (req) => {
    const material = loadMaterial(req.params.id);
    if (by('qcRuns', 'materialId', material.id).length > 0) throw conflict('qc_material_has_runs', 'This material has QC runs; deactivate it instead of deleting it');
    const before = { ...material };
    remove('qcMaterials', (m) => m.id === material.id);
    audit({ action: 'qc.material_delete', entityType: 'qc_material', entityId: before.id, summary: `${before.name} ${before.level} lot ${before.lot} deleted`, before });
    return { ok: true };
  });

  /** Levey-Jennings data: target mean, ±1/2/3 SD lines and the runs as points. */
  route('GET', '/qc/materials/:id/chart', { perm: 'qc.read' }, (req): QcChart => {
    const q = parse(qcChartQuery, req.query);
    const material = loadMaterial(req.params.id);
    const range = q.from || q.to ? dayRange(q.from, q.to) : null;
    const points = newestFirst(
      by('qcRuns', 'materialId', material.id).filter((r) => inRange(r.runAt, range)),
      (r) => r.runAt,
    )
      .slice(0, q.limit ?? 60)
      .reverse();
    const { targetMean: mean, targetSd: sd } = material;
    const values = points.map((r) => r.value);
    const n = values.length;
    const observedMean = n ? values.reduce((s, v) => s + v, 0) / n : null;
    const observedSd = n > 1 && observedMean !== null ? Math.sqrt(values.reduce((s, v) => s + (v - observedMean) ** 2, 0) / (n - 1)) : null;
    return {
      material: materialItems([material])[0]!,
      mean,
      sd,
      lines: { mean, plus1: mean + sd, plus2: mean + 2 * sd, plus3: mean + 3 * sd, minus1: mean - sd, minus2: mean - 2 * sd, minus3: mean - 3 * sd },
      points: points.map((r) => ({ id: r.id, runAt: r.runAt.toISOString(), value: r.value, z: sd > 0 ? (r.value - mean) / sd : 0, status: r.status, violations: r.violations, source: r.source })),
      stats: {
        n,
        observedMean,
        observedSd,
        cvPct: observedMean && observedSd !== null ? (observedSd / Math.abs(observedMean)) * 100 : null,
      },
    };
  });

  /* ---------------------------------------------------------------- runs */

  route('GET', '/qc/runs', { perm: 'qc.read' }, (req) => {
    const q = parse(qcRunsQuery, req.query);
    const range = q.from || q.to ? dayRange(q.from, q.to) : null;
    const source = q.materialId ? by('qcRuns', 'materialId', q.materialId) : rows('qcRuns');
    const matching = source.flatMap((r) => {
      const m = find('qcMaterials', r.materialId);
      if (!m) return [];
      if (q.instrumentId && m.instrumentId !== q.instrumentId) return [];
      if (q.status && r.status !== q.status) return [];
      if (!inRange(r.runAt, range)) return [];
      return [{ r, m }];
    });
    const items = newestFirst(matching, (x) => x.r.runAt)
      .slice(q.offset, q.offset + q.limit)
      .map(({ r, m }) => runItem(r, m, r.userId ? find('users', r.userId) : null));
    return page(items, matching.length);
  });

  route('POST', '/qc/runs', { perm: 'qc.write' }, (req): QcRunItem => {
    const body = parse(qcRunBody, req.body);
    const material = loadMaterial(body.materialId);
    if (!material.isActive) throw conflict('qc_material_inactive');
    const run = recordQcRun({
      material,
      value: body.value ?? typedNumber(req.body, 'value'),
      runAt: body.runAt ? new Date(body.runAt) : undefined,
      source: 'manual',
      note: body.note ?? null,
      userId: req.auth!.userId,
    });
    return runItem(run, material, req.auth!.user);
  });

  /* ---------------------------------------------------------------- maintenance */

  route('GET', '/qc/maintenance', { perm: 'qc.read' }, (req) => {
    const q = parse(maintenanceQuery, req.query);
    const range = q.from || q.to ? dayRange(q.from, q.to) : null;
    const source = q.instrumentId ? by('maintenanceLogs', 'instrumentId', q.instrumentId) : rows('maintenanceLogs');
    const matching = source.filter((m) => (!q.kind || m.kind === q.kind) && inRange(m.performedAt, range));
    const items = newestFirst(matching, (m) => m.performedAt)
      .flatMap((m) => {
        const inst = find('instruments', m.instrumentId);
        return inst ? [{ m, inst }] : [];
      })
      .slice(q.offset, q.offset + q.limit)
      .map(({ m, inst }) => maintenanceItem(m, { id: inst.id, code: inst.code, name: inst.name }, m.performedBy ? find('users', m.performedBy) : null));
    return page(items, matching.length);
  });

  route('POST', '/qc/maintenance', { perm: 'qc.write' }, (req): MaintenanceItem => {
    const body = parse(maintenanceBody, req.body);
    const inst = find('instruments', body.instrumentId);
    if (!inst) throw badRequest('instrument_not_found');
    const auth = req.auth!;
    const row = insert('maintenanceLogs', {
      labId: ctx().labId,
      instrumentId: inst.id,
      kind: body.kind ?? 'service',
      performedAt: body.performedAt ? new Date(body.performedAt) : now(),
      performedBy: auth.userId,
      performedByName: body.performedByName ?? null,
      nextDueAt: body.nextDueAt ? new Date(body.nextDueAt) : null,
      description: body.description ?? null,
      outcome: body.outcome ?? 'ok',
      createdAt: now(),
    });
    audit({
      action: 'qc.maintenance',
      entityType: 'maintenance_log',
      entityId: row.id,
      summary: `${inst.code}: ${row.kind} maintenance (${row.outcome})${row.description ? ` – ${row.description.slice(0, 80)}` : ''}`,
      after: { ...row },
    });
    return maintenanceItem(row, { id: inst.id, code: inst.code, name: inst.name }, auth.user);
  });
}

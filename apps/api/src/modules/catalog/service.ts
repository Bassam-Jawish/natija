import { and, asc, eq, ilike, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  analytes,
  containers,
  departments,
  instruments,
  orderItems,
  packages,
  packageTests,
  referenceRanges,
  rejectionReasons,
  results,
  samples,
  sampleTypes,
  testAnalytes,
  tests,
  users,
} from '@natija/db';
import { formulaVariables, validateFormula } from '@natija/domain';
import type {
  CatalogAnalyte,
  CatalogAnalyteDetail,
  CatalogAnalyteInput,
  CatalogContainerInput,
  CatalogDepartmentInput,
  CatalogFormulaCheck,
  CatalogLookups,
  CatalogPackage,
  CatalogPackageInput,
  CatalogRange,
  CatalogRangeCheck,
  CatalogRangeGap,
  CatalogRangeInput,
  CatalogRangeIssue,
  CatalogRejectionReasonInput,
  CatalogSampleTypeInput,
  CatalogTest,
  CatalogTestDetail,
  CatalogTestInput,
} from '@natija/contracts';
import { ctx, db } from '../../db';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { changes, countRows, fieldError, record, rowsOf, inSequence } from '../audit/kit';

type In<T extends z.ZodTypeAny> = z.output<T>;
type RangeIn = In<typeof CatalogRangeInput>;

const changed = (kind: string) => publish({ type: 'catalog.changed', data: { kind } });

/** Every id must exist in this lab (row-level security hides other labs' rows). */
async function assertIdsExist(table: typeof departments | typeof sampleTypes | typeof containers | typeof analytes | typeof tests | typeof instruments, ids: string[], field: string) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = await db().select({ id: table.id }).from(table).where(inArray(table.id, unique));
  if (found.length !== unique.length) fieldError(field, 'not_found');
}

/* ================================================================== lookups */

export async function lookups(): Promise<CatalogLookups> {
  const [deps, sts, conts, reasons, insts, byDept, bySt, byCont, byReason] = await inSequence([
    () => db().select().from(departments).orderBy(asc(departments.sortOrder), asc(departments.code)),
    () => db().select().from(sampleTypes).orderBy(asc(sampleTypes.code)),
    () => db().select().from(containers).orderBy(asc(containers.code)),
    () => db().select().from(rejectionReasons).orderBy(asc(rejectionReasons.code)),
    () => db()
      .select({ id: instruments.id, code: instruments.code, name: instruments.name, status: instruments.status })
      .from(instruments)
      .orderBy(asc(instruments.code)),
    () => rowsOf<{ id: string; n: number }>(sql`select department_id as id, count(*)::int as n from tests group by department_id`),
    () => rowsOf<{ id: string; n: number }>(sql`select sample_type_id as id, count(*)::int as n from tests group by sample_type_id`),
    () => rowsOf<{ id: string; n: number }>(sql`select container_id as id, count(*)::int as n from tests group by container_id`),
    () => rowsOf<{ id: string; n: number }>(
      sql`select rejection_reason_id as id, count(*)::int as n from samples where rejection_reason_id is not null group by rejection_reason_id`,
    ),
  ]);
  const map = (rows: Array<{ id: string; n: number }>) => new Map(rows.map((r) => [r.id, r.n]));
  const [d, s, c, r] = [map(byDept), map(bySt), map(byCont), map(byReason)];
  return {
    departments: deps.map((x) => ({ id: x.id, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn, sortOrder: x.sortOrder, testCount: d.get(x.id) ?? 0 })),
    sampleTypes: sts.map((x) => ({ id: x.id, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn, testCount: s.get(x.id) ?? 0 })),
    containers: conts.map((x) => ({ id: x.id, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn, capColor: x.capColor, volumeMl: x.volumeMl, testCount: c.get(x.id) ?? 0 })),
    rejectionReasons: reasons.map((x) => ({ id: x.id, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn, useCount: r.get(x.id) ?? 0 })),
    instruments: insts,
  };
}

/* ================================================================== simple lists */

type SimpleKind = 'department' | 'sample_type' | 'container' | 'rejection_reason';

const SIMPLE = {
  department: departments,
  sample_type: sampleTypes,
  container: containers,
  rejection_reason: rejectionReasons,
} as const;

type SimpleInput = {
  department: In<typeof CatalogDepartmentInput>;
  sample_type: In<typeof CatalogSampleTypeInput>;
  container: In<typeof CatalogContainerInput>;
  rejection_reason: In<typeof CatalogRejectionReasonInput>;
};

export async function createSimple<K extends SimpleKind>(kind: K, input: SimpleInput[K]) {
  const table = SIMPLE[kind] as typeof departments;
  const [row] = await db()
    .insert(table)
    .values({ labId: ctx().labId, ...(input as In<typeof CatalogDepartmentInput>) })
    .returning();
  await record({ action: `catalog.${kind}.created`, entityType: kind, entityId: row!.id, summary: row!.code, after: input });
  changed(kind);
  return row!;
}

export async function updateSimple<K extends SimpleKind>(kind: K, id: string, input: SimpleInput[K]) {
  const table = SIMPLE[kind] as typeof departments;
  const [before] = await db().select().from(table).where(eq(table.id, id));
  if (!before) throw notFound();
  const [row] = await db()
    .update(table)
    .set(input as In<typeof CatalogDepartmentInput>)
    .where(eq(table.id, id))
    .returning();
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) await record({ action: `catalog.${kind}.updated`, entityType: kind, entityId: id, summary: row!.code, ...diff });
  changed(kind);
  return row!;
}

export async function deleteSimple(kind: SimpleKind, id: string) {
  const table = SIMPLE[kind] as typeof departments;
  const [before] = await db().select().from(table).where(eq(table.id, id));
  if (!before) throw notFound();
  let uses = 0;
  if (kind === 'department') {
    uses =
      (await countRows(tests, eq(tests.departmentId, id))) +
      (await countRows(samples, eq(samples.departmentId, id))) +
      (await countRows(instruments, eq(instruments.departmentId, id))) +
      (await countRows(users, sql`${id}::uuid = any(${users.departmentIds})`));
  } else if (kind === 'sample_type') {
    uses =
      (await countRows(tests, eq(tests.sampleTypeId, id))) +
      (await countRows(samples, eq(samples.sampleTypeId, id))) +
      (await countRows(referenceRanges, eq(referenceRanges.sampleTypeId, id)));
  } else if (kind === 'container') {
    uses = (await countRows(tests, eq(tests.containerId, id))) + (await countRows(samples, eq(samples.containerId, id)));
  } else {
    uses = await countRows(samples, eq(samples.rejectionReasonId, id));
  }
  if (uses > 0) throw conflict('in_use', `Used by ${uses} record(s)`);
  await db().delete(table).where(eq(table.id, id));
  await record({ action: `catalog.${kind}.deleted`, entityType: kind, entityId: id, summary: before.code, before });
  changed(kind);
  return { ok: true };
}

/* ================================================================== tests */

const testColumns = {
  id: tests.id,
  code: tests.code,
  nameAr: tests.nameAr,
  nameEn: tests.nameEn,
  reportNameAr: tests.reportNameAr,
  reportNameEn: tests.reportNameEn,
  departmentId: tests.departmentId,
  sampleTypeId: tests.sampleTypeId,
  containerId: tests.containerId,
  units: tests.units,
  fixedPrice: tests.fixedPrice,
  tatHours: tests.tatHours,
  method: tests.method,
  isExternal: tests.isExternal,
  separateTube: tests.separateTube,
  isFavorite: tests.isFavorite,
  isActive: tests.isActive,
  sortOrder: tests.sortOrder,
  notes: tests.notes,
  capColor: containers.capColor,
  analyteCount: sql<number>`(select count(*)::int from test_analytes ta where ta.test_id = "tests"."id")`,
};

export async function listTests(f: { q?: string; departmentId?: string; active?: 'true' | 'false' | 'all' }): Promise<CatalogTest[]> {
  const where: SQL[] = [];
  if (f.departmentId) where.push(eq(tests.departmentId, f.departmentId));
  if (f.active === 'true') where.push(eq(tests.isActive, true));
  if (f.active === 'false') where.push(eq(tests.isActive, false));
  if (f.q) {
    const term = f.q.replace(/[%_]/g, '');
    where.push(or(ilike(tests.code, `${term}%`), ilike(tests.nameEn, `%${term}%`), ilike(tests.nameAr, `%${term}%`))!);
  }
  return db()
    .select(testColumns)
    .from(tests)
    .innerJoin(containers, eq(containers.id, tests.containerId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(tests.sortOrder), asc(tests.code));
}

export async function getTest(id: string): Promise<CatalogTestDetail> {
  const [row] = await db().select(testColumns).from(tests).innerJoin(containers, eq(containers.id, tests.containerId)).where(eq(tests.id, id));
  if (!row) throw notFound();
  const [analyteRows, packageRows, ordered] = await inSequence([
    () => db()
      .select({ id: analytes.id, code: analytes.code, nameAr: analytes.nameAr, nameEn: analytes.nameEn, unit: analytes.unit, resultType: analytes.resultType })
      .from(testAnalytes)
      .innerJoin(analytes, eq(analytes.id, testAnalytes.analyteId))
      .where(eq(testAnalytes.testId, id))
      .orderBy(asc(testAnalytes.sortOrder)),
    () => db()
      .select({ id: packages.id, code: packages.code, nameAr: packages.nameAr, nameEn: packages.nameEn })
      .from(packageTests)
      .innerJoin(packages, eq(packages.id, packageTests.packageId))
      .where(eq(packageTests.testId, id)),
    () => countRows(orderItems, eq(orderItems.testId, id)),
  ]);
  return { ...row, analytes: analyteRows, packages: packageRows, ordered };
}

async function validateTestRefs(input: In<typeof CatalogTestInput>) {
  await assertIdsExist(departments, [input.departmentId], 'departmentId');
  await assertIdsExist(sampleTypes, [input.sampleTypeId], 'sampleTypeId');
  await assertIdsExist(containers, [input.containerId], 'containerId');
  if (new Set(input.analyteIds).size !== input.analyteIds.length) fieldError('analyteIds', 'duplicate');
  await assertIdsExist(analytes, input.analyteIds, 'analyteIds');
}

async function setTestAnalytes(testId: string, analyteIds: string[]) {
  await db().delete(testAnalytes).where(eq(testAnalytes.testId, testId));
  if (analyteIds.length) {
    await db()
      .insert(testAnalytes)
      .values(analyteIds.map((analyteId, i) => ({ labId: ctx().labId, testId, analyteId, sortOrder: i })));
  }
}

export async function createTest(input: In<typeof CatalogTestInput>) {
  await validateTestRefs(input);
  const { analyteIds, ...fields } = input;
  const [row] = await db()
    .insert(tests)
    .values({ labId: ctx().labId, ...fields })
    .returning();
  await setTestAnalytes(row!.id, analyteIds);
  await record({ action: 'catalog.test.created', entityType: 'test', entityId: row!.id, summary: `${row!.code} · ${row!.nameEn}`, after: input });
  changed('test');
  return getTest(row!.id);
}

export async function updateTest(id: string, input: In<typeof CatalogTestInput>) {
  const [before] = await db().select().from(tests).where(eq(tests.id, id));
  if (!before) throw notFound();
  await validateTestRefs(input);
  const { analyteIds, ...fields } = input;
  const previousAnalytes = (
    await db().select({ id: testAnalytes.analyteId }).from(testAnalytes).where(eq(testAnalytes.testId, id)).orderBy(asc(testAnalytes.sortOrder))
  ).map((r) => r.id);
  await db()
    .update(tests)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(tests.id, id));
  const analytesChanged = previousAnalytes.join(',') !== analyteIds.join(',');
  if (analytesChanged) await setTestAnalytes(id, analyteIds);
  const diff = changes({ ...before, analyteIds: previousAnalytes } as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) await record({ action: 'catalog.test.updated', entityType: 'test', entityId: id, summary: `${input.code} · ${input.nameEn}`, ...diff });
  changed('test');
  return getTest(id);
}

export async function deleteTest(id: string) {
  const [before] = await db().select().from(tests).where(eq(tests.id, id));
  if (!before) throw notFound();
  if ((await countRows(orderItems, eq(orderItems.testId, id))) > 0) throw conflict('test_ordered', 'The test has been ordered; deactivate it instead');
  await db().delete(tests).where(eq(tests.id, id));
  await record({ action: 'catalog.test.deleted', entityType: 'test', entityId: id, summary: `${before.code} · ${before.nameEn}`, before });
  changed('test');
  return { ok: true };
}

/* ================================================================== analytes */

const analyteColumns = {
  id: analytes.id,
  code: analytes.code,
  nameAr: analytes.nameAr,
  nameEn: analytes.nameEn,
  unit: analytes.unit,
  resultType: analytes.resultType,
  decimals: analytes.decimals,
  options: analytes.options,
  formula: analytes.formula,
  deltaPct: analytes.deltaPct,
  loinc: analytes.loinc,
  sortOrder: analytes.sortOrder,
  isActive: analytes.isActive,
  rangeCount: sql<number>`(select count(*)::int from reference_ranges r where r.analyte_id = "analytes"."id")`,
  testCodes: sql<string[]>`coalesce((select array_agg(t.code::text order by t.code) from test_analytes ta join tests t on t.id = ta.test_id where ta.analyte_id = "analytes"."id"), '{}'::text[])`,
};

export async function listAnalytes(f: { q?: string; type?: string; testId?: string }): Promise<CatalogAnalyte[]> {
  const where: SQL[] = [];
  if (f.type) where.push(eq(analytes.resultType, f.type as CatalogAnalyte['resultType']));
  if (f.testId) where.push(sql`exists (select 1 from test_analytes ta where ta.analyte_id = "analytes"."id" and ta.test_id = ${f.testId})`);
  if (f.q) {
    const term = f.q.replace(/[%_]/g, '');
    where.push(or(ilike(analytes.code, `${term}%`), ilike(analytes.nameEn, `%${term}%`), ilike(analytes.nameAr, `%${term}%`))!);
  }
  return db()
    .select(analyteColumns)
    .from(analytes)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(analytes.sortOrder), asc(analytes.code));
}

function rangeOut(r: typeof referenceRanges.$inferSelect): CatalogRange {
  return {
    id: r.id,
    sex: r.sex,
    ageMinDays: r.ageMinDays,
    ageMaxDays: r.ageMaxDays,
    low: r.low,
    high: r.high,
    criticalLow: r.criticalLow,
    criticalHigh: r.criticalHigh,
    textRange: r.textRange,
    sampleTypeId: r.sampleTypeId,
    instrumentId: r.instrumentId,
    note: r.note,
    sortOrder: r.sortOrder,
  };
}

export async function getAnalyte(id: string): Promise<CatalogAnalyteDetail> {
  const [row] = await db().select(analyteColumns).from(analytes).where(eq(analytes.id, id));
  if (!row) throw notFound();
  const [ranges, testRows, resultCount] = await inSequence([
    () => db().select().from(referenceRanges).where(eq(referenceRanges.analyteId, id)).orderBy(asc(referenceRanges.sortOrder), asc(referenceRanges.ageMinDays)),
    () => db()
      .select({ id: tests.id, code: tests.code, nameAr: tests.nameAr, nameEn: tests.nameEn })
      .from(testAnalytes)
      .innerJoin(tests, eq(tests.id, testAnalytes.testId))
      .where(eq(testAnalytes.analyteId, id)),
    () => countRows(results, eq(results.analyteId, id)),
  ]);
  return { ...row, ranges: ranges.map(rangeOut), tests: testRows, results: resultCount };
}

/** Calculated analytes reachable from `start` through formulas, following `graph`; returns the cycle path back to start. */
function findCycle(start: string, graph: Map<string, string[]>): string[] | null {
  const seen = new Set<string>();
  const walk = (code: string, path: string[]): string[] | null => {
    for (const next of graph.get(code) ?? []) {
      if (next === start) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

/** Parse a formula and check its variables against the lab's analyte codes (and for cycles). */
export async function checkFormula(input: { formula: string; analyteId?: string; code?: string }): Promise<CatalogFormulaCheck> {
  const all = await db()
    .select({ id: analytes.id, code: analytes.code, nameAr: analytes.nameAr, nameEn: analytes.nameEn, unit: analytes.unit, formula: analytes.formula, resultType: analytes.resultType })
    .from(analytes)
    .orderBy(asc(analytes.code));
  const self = input.analyteId ? all.find((a) => a.id === input.analyteId) : undefined;
  const selfCode = input.code ?? self?.code ?? null;
  const allowed = all.filter((a) => a.id !== input.analyteId && a.code !== selfCode).map(({ code, nameAr, nameEn, unit }) => ({ code, nameAr, nameEn, unit }));
  const base = { variables: [] as string[], unknown: [] as string[], cycle: null as string[] | null, allowed };
  const formula = input.formula.trim();
  if (!formula) return { ...base, ok: false, error: 'empty' };
  let variables: string[];
  try {
    validateFormula(formula);
    variables = formulaVariables(formula);
  } catch (err) {
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const codes = new Set(all.map((a) => a.code));
  const resolve = (v: string) => (codes.has(v) ? v : codes.has(v.toUpperCase()) ? v.toUpperCase() : null);
  const isSelf = (v: string) => selfCode !== null && (v === selfCode || v.toUpperCase() === selfCode);
  const unknown = variables.filter((v) => !resolve(v) && !isSelf(v));
  let cycle: string[] | null = null;
  if (selfCode) {
    const graph = new Map<string, string[]>();
    for (const a of all) {
      if (a.resultType !== 'calculated' || !a.formula || a.code === selfCode) continue;
      try {
        graph.set(a.code, formulaVariables(a.formula).map((v) => resolve(v) ?? v));
      } catch {
        /* a broken stored formula cannot form a cycle we can follow */
      }
    }
    graph.set(selfCode, variables.map((v) => resolve(v) ?? (isSelf(v) ? selfCode : v)));
    cycle = findCycle(selfCode, graph);
  }
  return { ...base, ok: unknown.length === 0 && !cycle, error: null, variables, unknown, cycle };
}

async function validateAnalyte(input: In<typeof CatalogAnalyteInput>, id?: string) {
  if (input.resultType !== 'calculated') return;
  const check = await checkFormula({ formula: input.formula ?? '', analyteId: id, code: input.code });
  if (check.error) throw new AppError(400, 'formula_invalid', check.error, { formula: [check.error] });
  if (check.unknown.length) throw new AppError(400, 'formula_unknown_variable', check.unknown.join(', '), { formula: check.unknown.map((v) => `unknown:${v}`) });
  if (check.cycle) throw new AppError(400, 'formula_cycle', check.cycle.join(' → '), { formula: [`cycle:${check.cycle.join(' → ')}`] });
}

function analyteFields(input: In<typeof CatalogAnalyteInput>) {
  return {
    ...input,
    options: input.resultType === 'option' ? input.options : [],
    formula: input.resultType === 'calculated' ? input.formula : null,
  };
}

export async function createAnalyte(input: In<typeof CatalogAnalyteInput>) {
  await validateAnalyte(input);
  const fields = analyteFields(input);
  const [row] = await db()
    .insert(analytes)
    .values({ labId: ctx().labId, ...fields })
    .returning();
  await record({ action: 'catalog.analyte.created', entityType: 'analyte', entityId: row!.id, summary: `${row!.code} · ${row!.nameEn}`, after: fields });
  changed('analyte');
  return getAnalyte(row!.id);
}

export async function updateAnalyte(id: string, input: In<typeof CatalogAnalyteInput>) {
  const [before] = await db().select().from(analytes).where(eq(analytes.id, id));
  if (!before) throw notFound();
  await validateAnalyte(input, id);
  if (before.code !== input.code) {
    const dependents = await db()
      .select({ code: analytes.code, formula: analytes.formula })
      .from(analytes)
      .where(and(eq(analytes.resultType, 'calculated'), isNotNull(analytes.formula), ne(analytes.id, id)));
    const using = dependents.filter((d) => {
      try {
        return formulaVariables(d.formula!).some((v) => v === before.code || v.toUpperCase() === before.code);
      } catch {
        return false;
      }
    });
    if (using.length) throw conflict('analyte_code_in_formula', using.map((d) => d.code).join(', '));
  }
  if (before.resultType !== input.resultType && (await countRows(results, eq(results.analyteId, id))) > 0) {
    throw conflict('analyte_has_results', 'The result type cannot change once results exist');
  }
  const fields = analyteFields(input);
  await db().update(analytes).set(fields).where(eq(analytes.id, id));
  const diff = changes(before as Record<string, unknown>, fields as Record<string, unknown>);
  if (diff) await record({ action: 'catalog.analyte.updated', entityType: 'analyte', entityId: id, summary: `${input.code} · ${input.nameEn}`, ...diff });
  changed('analyte');
  return getAnalyte(id);
}

export async function deleteAnalyte(id: string) {
  const [before] = await db().select().from(analytes).where(eq(analytes.id, id));
  if (!before) throw notFound();
  if ((await countRows(results, eq(results.analyteId, id))) > 0) throw conflict('analyte_has_results', 'Results exist; deactivate it instead');
  const usedBy = await db().select({ code: tests.code }).from(testAnalytes).innerJoin(tests, eq(tests.id, testAnalytes.testId)).where(eq(testAnalytes.analyteId, id));
  if (usedBy.length) throw conflict('analyte_in_test', usedBy.map((t) => t.code).join(', '));
  const formulas = await db()
    .select({ code: analytes.code, formula: analytes.formula })
    .from(analytes)
    .where(and(eq(analytes.resultType, 'calculated'), isNotNull(analytes.formula)));
  const inFormula = formulas.filter((d) => {
    try {
      return formulaVariables(d.formula!).some((v) => v === before.code || v.toUpperCase() === before.code);
    } catch {
      return false;
    }
  });
  if (inFormula.length) throw conflict('analyte_code_in_formula', inFormula.map((d) => d.code).join(', '));
  await db().delete(analytes).where(eq(analytes.id, id));
  await record({ action: 'catalog.analyte.deleted', entityType: 'analyte', entityId: id, summary: `${before.code} · ${before.nameEn}`, before });
  changed('analyte');
  return { ok: true };
}

/* ================================================================== reference ranges */

type Interval = { min: number; max: number | null };

function gapsOf(intervals: Interval[]): Array<{ fromDays: number; toDays: number | null }> {
  const sorted = [...intervals].sort((a, b) => a.min - b.min);
  const gaps: Array<{ fromDays: number; toDays: number | null }> = [];
  let cursor = 0;
  for (const it of sorted) {
    if (it.min > cursor) gaps.push({ fromDays: cursor, toDays: it.min - 1 });
    const end = it.max === null ? Number.POSITIVE_INFINITY : it.max + 1;
    if (end > cursor) cursor = end;
    if (cursor === Number.POSITIVE_INFINITY) break;
  }
  if (cursor !== Number.POSITIVE_INFINITY) gaps.push({ fromDays: cursor, toDays: null });
  return gaps;
}

const overlaps = (a: RangeIn, b: RangeIn) =>
  a.ageMinDays <= (b.ageMaxDays ?? Number.POSITIVE_INFINITY) && b.ageMinDays <= (a.ageMaxDays ?? Number.POSITIVE_INFINITY);

/**
 * Validate a full set of ranges for one analyte. Errors: rows that overlap for the same sex,
 * specimen and instrument, inverted ages or limits, empty rows. Warnings: critical limits inside
 * the normal range. Gaps: ages with no applicable range (base rows only, per sex).
 */
export function checkRanges(rows: RangeIn[]): CatalogRangeCheck {
  const errors: CatalogRangeIssue[] = [];
  const warnings: CatalogRangeIssue[] = [];
  rows.forEach((r, i) => {
    if (r.ageMaxDays !== null && r.ageMaxDays < r.ageMinDays) errors.push({ row: i, code: 'age_order' });
    if (r.low !== null && r.high !== null && r.low > r.high) errors.push({ row: i, code: 'low_above_high' });
    if (r.criticalLow !== null && r.criticalHigh !== null && r.criticalLow >= r.criticalHigh) errors.push({ row: i, code: 'critical_order' });
    if (r.low === null && r.high === null && r.criticalLow === null && r.criticalHigh === null && !r.textRange) errors.push({ row: i, code: 'empty_row' });
    if (r.criticalLow !== null && r.low !== null && r.criticalLow > r.low) warnings.push({ row: i, code: 'critical_low_inside' });
    if (r.criticalHigh !== null && r.high !== null && r.criticalHigh < r.high) warnings.push({ row: i, code: 'critical_high_inside' });
  });
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.sex !== b.sex || (a.sampleTypeId ?? null) !== (b.sampleTypeId ?? null) || (a.instrumentId ?? null) !== (b.instrumentId ?? null)) continue;
      if (overlaps(a, b)) errors.push({ row: j, other: i, code: 'overlap' });
    }
  }
  const base = rows.filter((r) => !r.sampleTypeId && !r.instrumentId);
  const gaps: CatalogRangeGap[] = [];
  if (base.length) {
    const toInterval = (r: RangeIn): Interval => ({ min: r.ageMinDays, max: r.ageMaxDays });
    const any = base.filter((r) => r.sex === 'any');
    const hasSexRows = base.some((r) => r.sex !== 'any');
    const sexes: Array<'any' | 'male' | 'female'> = hasSexRows ? ['male', 'female'] : ['any'];
    for (const sex of sexes) {
      const applicable = sex === 'any' ? any : [...any, ...base.filter((r) => r.sex === sex)];
      for (const g of gapsOf(applicable.map(toInterval))) gaps.push({ sex, ...g });
    }
  }
  return { ok: errors.length === 0, errors, warnings, gaps };
}

async function validateRangeRefs(rows: RangeIn[]) {
  await assertIdsExist(sampleTypes, rows.map((r) => r.sampleTypeId).filter((x): x is string => !!x), 'sampleTypeId');
  await assertIdsExist(instruments, rows.map((r) => r.instrumentId).filter((x): x is string => !!x), 'instrumentId');
}

export async function previewRanges(analyteId: string, rows: RangeIn[]): Promise<CatalogRangeCheck> {
  const [a] = await db().select({ id: analytes.id }).from(analytes).where(eq(analytes.id, analyteId));
  if (!a) throw notFound();
  await validateRangeRefs(rows);
  return checkRanges(rows);
}

/** Replace every reference range of an analyte. Overlapping rows are refused; gaps come back as warnings. */
export async function replaceRanges(analyteId: string, rows: RangeIn[]) {
  const [a] = await db().select().from(analytes).where(eq(analytes.id, analyteId));
  if (!a) throw notFound();
  const check = checkRanges(rows);
  if (!check.ok) {
    const errors: Record<string, string[]> = {};
    for (const e of check.errors) (errors[`rows.${e.row}`] ??= []).push(e.other !== undefined ? `${e.code}:${e.other}` : e.code);
    const overlap = check.errors.some((e) => e.code === 'overlap');
    throw badRequest(overlap ? 'range_overlap' : 'range_invalid', overlap ? 'Ranges overlap for the same sex, specimen and instrument' : 'Invalid range rows', errors);
  }
  await validateRangeRefs(rows);
  const before = await db().select().from(referenceRanges).where(eq(referenceRanges.analyteId, analyteId)).orderBy(asc(referenceRanges.sortOrder));
  await db().delete(referenceRanges).where(eq(referenceRanges.analyteId, analyteId));
  if (rows.length) {
    await db()
      .insert(referenceRanges)
      .values(rows.map((r, i) => ({ ...r, labId: ctx().labId, analyteId, sortOrder: i })));
  }
  const strip = (r: RangeIn | typeof referenceRanges.$inferSelect) => ({
    sex: r.sex,
    ageMinDays: r.ageMinDays,
    ageMaxDays: r.ageMaxDays,
    low: r.low,
    high: r.high,
    criticalLow: r.criticalLow,
    criticalHigh: r.criticalHigh,
    textRange: r.textRange,
    sampleTypeId: r.sampleTypeId,
    instrumentId: r.instrumentId,
    note: r.note,
  });
  await record({
    action: 'catalog.ranges.replaced',
    entityType: 'analyte',
    entityId: analyteId,
    summary: `${a.code}: ${before.length} → ${rows.length} range(s)`,
    before: before.map(strip),
    after: rows.map(strip),
  });
  changed('ranges');
  const saved = await db().select().from(referenceRanges).where(eq(referenceRanges.analyteId, analyteId)).orderBy(asc(referenceRanges.sortOrder));
  return { ranges: saved.map(rangeOut), check };
}

/* ================================================================== packages */

export async function listPackages(): Promise<CatalogPackage[]> {
  const rows = await db()
    .select({
      id: packages.id,
      code: packages.code,
      nameAr: packages.nameAr,
      nameEn: packages.nameEn,
      priceMode: packages.priceMode,
      units: packages.units,
      fixedPrice: packages.fixedPrice,
      isActive: packages.isActive,
      testIds: sql<string[]>`coalesce((select array_agg(pt.test_id::text) from package_tests pt where pt.package_id = "packages"."id"), '{}'::text[])`,
      testUnits: sql<number>`coalesce((select sum(t.units) from package_tests pt join tests t on t.id = pt.test_id where pt.package_id = "packages"."id"), 0)`,
    })
    .from(packages)
    .orderBy(asc(packages.code));
  return rows.map((r) => ({ ...r, testUnits: Number(r.testUnits) }));
}

async function getPackage(id: string): Promise<CatalogPackage> {
  const found = (await listPackages()).find((p) => p.id === id);
  if (!found) throw notFound();
  return found;
}

function packageFields(input: In<typeof CatalogPackageInput>) {
  const { testIds, ...fields } = input;
  void testIds;
  return {
    ...fields,
    units: input.priceMode === 'units' ? input.units : null,
    fixedPrice: input.priceMode === 'fixed' ? input.fixedPrice : null,
  };
}

async function setPackageTests(packageId: string, testIds: string[]) {
  await db().delete(packageTests).where(eq(packageTests.packageId, packageId));
  await db()
    .insert(packageTests)
    .values([...new Set(testIds)].map((testId) => ({ labId: ctx().labId, packageId, testId })));
}

export async function createPackage(input: In<typeof CatalogPackageInput>) {
  await assertIdsExist(tests, input.testIds, 'testIds');
  const fields = packageFields(input);
  const [row] = await db()
    .insert(packages)
    .values({ labId: ctx().labId, ...fields })
    .returning();
  await setPackageTests(row!.id, input.testIds);
  await record({ action: 'catalog.package.created', entityType: 'package', entityId: row!.id, summary: `${row!.code} · ${row!.nameEn}`, after: { ...fields, testIds: input.testIds } });
  changed('package');
  return getPackage(row!.id);
}

export async function updatePackage(id: string, input: In<typeof CatalogPackageInput>) {
  const before = await getPackage(id);
  await assertIdsExist(tests, input.testIds, 'testIds');
  const fields = packageFields(input);
  await db().update(packages).set(fields).where(eq(packages.id, id));
  const sortedBefore = [...before.testIds].sort().join(',');
  const sortedAfter = [...new Set(input.testIds)].sort().join(',');
  if (sortedBefore !== sortedAfter) await setPackageTests(id, input.testIds);
  const diff = changes(
    { ...before, testIds: [...before.testIds].sort() } as Record<string, unknown>,
    { ...fields, testIds: [...new Set(input.testIds)].sort() } as Record<string, unknown>,
  );
  if (diff) await record({ action: 'catalog.package.updated', entityType: 'package', entityId: id, summary: `${input.code} · ${input.nameEn}`, ...diff });
  changed('package');
  return getPackage(id);
}

export async function deletePackage(id: string) {
  const before = await getPackage(id);
  if ((await countRows(orderItems, eq(orderItems.packageId, id))) > 0) throw conflict('package_ordered', 'The package has been ordered; deactivate it instead');
  await db().delete(packages).where(eq(packages.id, id));
  await record({ action: 'catalog.package.deleted', entityType: 'package', entityId: id, summary: `${before.code} · ${before.nameEn}`, before });
  changed('package');
  return { ok: true };
}

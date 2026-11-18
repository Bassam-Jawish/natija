/**
 * Test catalog (port of apps/api/src/modules/catalog): departments, specimens, tubes, rejection
 * reasons, tests, analytes, reference ranges and packages. Any signed-in user can read; changes
 * need catalog.manage. Overlapping ranges, broken formulas, codes in use and ordered tests are
 * refused as on the server. Deletes also remove what the database removes by cascade.
 */
import { z } from 'zod';
import { formulaVariables, validateFormula } from '@natija/domain';
import {
  CatalogAnalyteInput,
  CatalogContainerInput,
  CatalogDepartmentInput,
  CatalogFormulaCheckInput,
  CatalogPackageInput,
  CatalogRangeInput,
  CatalogRejectionReasonInput,
  CatalogSampleTypeInput,
  CatalogTestInput,
  type CatalogAnalyte,
  type CatalogAnalyteDetail,
  type CatalogFormulaCheck,
  type CatalogLookups,
  type CatalogPackage,
  type CatalogRange,
  type CatalogRangeCheck,
  type CatalogRangeGap,
  type CatalogRangeIssue,
  type CatalogTest,
  type CatalogTestDetail,
} from '@natija/contracts';
import { AppError, badRequest, conflict, notFound, now } from '../../core/context';
import { by, find, insert, remove, rows, update, type Row } from '../../core/db';
import { parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { assertUnique, changes, cmp, contains, fieldError, input, inputRows, likeTerm, record, startsWith } from './kit';

type In<T extends z.ZodTypeAny> = z.output<T>;
type RangeIn = In<typeof CatalogRangeInput>;

const changed = (kind: string) => publish({ type: 'catalog.changed', data: { kind } });

type RefTable = 'departments' | 'sampleTypes' | 'containers' | 'analytes' | 'tests' | 'instruments';

/** Every id must exist in this lab (find() hides other labs' rows, like row-level security). */
function assertIdsExist(table: RefTable, ids: Array<string | null | undefined>, field: string): void {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  if (unique.some((id) => !find(table, id))) fieldError(field, 'not_found');
}

function countBy(values: Array<string | null | undefined>): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) if (v) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}

/* ================================================================== lookups */

export function lookups(): CatalogLookups {
  const tests = rows('tests');
  const d = countBy(tests.map((t) => t.departmentId));
  const s = countBy(tests.map((t) => t.sampleTypeId));
  const c = countBy(tests.map((t) => t.containerId));
  const r = countBy(rows('samples').map((x) => x.rejectionReasonId));
  return {
    departments: [...rows('departments')]
      .sort((a, b) => cmp(a.sortOrder, b.sortOrder) || cmp(a.code, b.code))
      .map((x) => ({ id: x.id, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn, sortOrder: x.sortOrder, testCount: d.get(x.id) ?? 0 })),
    sampleTypes: [...rows('sampleTypes')]
      .sort((a, b) => cmp(a.code, b.code))
      .map((x) => ({ id: x.id, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn, testCount: s.get(x.id) ?? 0 })),
    containers: [...rows('containers')]
      .sort((a, b) => cmp(a.code, b.code))
      .map((x) => ({ id: x.id, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn, capColor: x.capColor, volumeMl: x.volumeMl, testCount: c.get(x.id) ?? 0 })),
    rejectionReasons: [...rows('rejectionReasons')]
      .sort((a, b) => cmp(a.code, b.code))
      .map((x) => ({ id: x.id, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn, useCount: r.get(x.id) ?? 0 })),
    instruments: [...rows('instruments')]
      .sort((a, b) => cmp(a.code, b.code))
      .map((x) => ({ id: x.id, code: x.code, name: x.name, status: x.status })),
  };
}

/* ================================================================== simple lists */

type SimpleKind = 'department' | 'sample_type' | 'container' | 'rejection_reason';

const SIMPLE = {
  department: { table: 'departments', unique: 'departments_code_uq' },
  sample_type: { table: 'sampleTypes', unique: 'sample_types_code_uq' },
  container: { table: 'containers', unique: 'containers_code_uq' },
  rejection_reason: { table: 'rejectionReasons', unique: 'rejection_reasons_code_uq' },
} as const;

type SimpleInput = {
  department: In<typeof CatalogDepartmentInput>;
  sample_type: In<typeof CatalogSampleTypeInput>;
  container: In<typeof CatalogContainerInput>;
  rejection_reason: In<typeof CatalogRejectionReasonInput>;
};

export function createSimple<K extends SimpleKind>(kind: K, input: SimpleInput[K]) {
  const { table, unique } = SIMPLE[kind];
  const values = input as In<typeof CatalogDepartmentInput>;
  assertUnique(table, 'code', values.code, unique);
  const row = insert(table as 'departments', { ...values });
  record({ action: `catalog.${kind}.created`, entityType: kind, entityId: row.id, summary: row.code, after: input });
  changed(kind);
  return row;
}

export function updateSimple<K extends SimpleKind>(kind: K, id: string, input: SimpleInput[K]) {
  const { table, unique } = SIMPLE[kind];
  const row = find(table as 'departments', id);
  if (!row) throw notFound();
  const values = input as In<typeof CatalogDepartmentInput>;
  assertUnique(table, 'code', values.code, unique, id);
  const before = { ...row };
  update(table as 'departments', row, { ...values });
  const diff = changes(before as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) record({ action: `catalog.${kind}.updated`, entityType: kind, entityId: id, summary: row.code, ...diff });
  changed(kind);
  return row;
}

export function deleteSimple(kind: SimpleKind, id: string) {
  const { table } = SIMPLE[kind];
  const before = find(table as 'departments', id);
  if (!before) throw notFound();
  let uses = 0;
  if (kind === 'department') {
    uses =
      by('tests', 'departmentId', id).length +
      by('samples', 'departmentId', id).length +
      by('instruments', 'departmentId', id).length +
      rows('users').filter((u) => u.departmentIds.includes(id)).length;
  } else if (kind === 'sample_type') {
    uses = by('tests', 'sampleTypeId', id).length + by('samples', 'sampleTypeId', id).length + by('referenceRanges', 'sampleTypeId', id).length;
  } else if (kind === 'container') {
    uses = by('tests', 'containerId', id).length + by('samples', 'containerId', id).length;
  } else {
    uses = by('samples', 'rejectionReasonId', id).length;
  }
  if (uses > 0) throw conflict('in_use', `Used by ${uses} record(s)`);
  remove(table as 'departments', (r) => r.id === id);
  record({ action: `catalog.${kind}.deleted`, entityType: kind, entityId: id, summary: before.code, before });
  changed(kind);
  return { ok: true };
}

/* ================================================================== tests */

function testOut(t: Row<'tests'>, capColor: string): CatalogTest {
  return {
    id: t.id,
    code: t.code,
    nameAr: t.nameAr,
    nameEn: t.nameEn,
    reportNameAr: t.reportNameAr,
    reportNameEn: t.reportNameEn,
    departmentId: t.departmentId,
    sampleTypeId: t.sampleTypeId,
    containerId: t.containerId,
    units: t.units,
    fixedPrice: t.fixedPrice,
    tatHours: t.tatHours,
    method: t.method,
    isExternal: t.isExternal,
    separateTube: t.separateTube,
    isFavorite: t.isFavorite,
    isActive: t.isActive,
    sortOrder: t.sortOrder,
    notes: t.notes,
    capColor,
    analyteCount: by('testAnalytes', 'testId', t.id).length,
  };
}

export function listTests(f: { q?: string; departmentId?: string; active?: 'true' | 'false' | 'all' }): CatalogTest[] {
  const term = f.q ? likeTerm(f.q) : '';
  const out: CatalogTest[] = [];
  for (const t of rows('tests')) {
    if (f.departmentId && t.departmentId !== f.departmentId) continue;
    if (f.active === 'true' && !t.isActive) continue;
    if (f.active === 'false' && t.isActive) continue;
    if (f.q && !(startsWith(t.code, term) || contains(t.nameEn, term) || contains(t.nameAr, term))) continue;
    const container = find('containers', t.containerId);
    if (!container) continue;
    out.push(testOut(t, container.capColor));
  }
  return out.sort((a, b) => cmp(a.sortOrder, b.sortOrder) || cmp(a.code, b.code));
}

export function getTest(id: string): CatalogTestDetail {
  const t = find('tests', id);
  const container = t ? find('containers', t.containerId) : undefined;
  if (!t || !container) throw notFound();
  const analytes = by('testAnalytes', 'testId', id)
    .sort((a, b) => cmp(a.sortOrder, b.sortOrder))
    .map((ta) => find('analytes', ta.analyteId))
    .filter((a): a is Row<'analytes'> => !!a)
    .map((a) => ({ id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, unit: a.unit, resultType: a.resultType }));
  const packages = by('packageTests', 'testId', id)
    .map((pt) => find('packages', pt.packageId))
    .filter((p): p is Row<'packages'> => !!p)
    .map((p) => ({ id: p.id, code: p.code, nameAr: p.nameAr, nameEn: p.nameEn }));
  return { ...testOut(t, container.capColor), analytes, packages, ordered: by('orderItems', 'testId', id).length };
}

function validateTestRefs(input: In<typeof CatalogTestInput>): void {
  assertIdsExist('departments', [input.departmentId], 'departmentId');
  assertIdsExist('sampleTypes', [input.sampleTypeId], 'sampleTypeId');
  assertIdsExist('containers', [input.containerId], 'containerId');
  if (new Set(input.analyteIds).size !== input.analyteIds.length) fieldError('analyteIds', 'duplicate');
  assertIdsExist('analytes', input.analyteIds, 'analyteIds');
}

function setTestAnalytes(testId: string, analyteIds: string[]): void {
  remove('testAnalytes', (r) => r.testId === testId);
  analyteIds.forEach((analyteId, i) => insert('testAnalytes', { testId, analyteId, sortOrder: i }));
}

function analyteIdsOf(testId: string): string[] {
  return by('testAnalytes', 'testId', testId)
    .sort((a, b) => cmp(a.sortOrder, b.sortOrder))
    .map((r) => r.analyteId);
}

export function createTest(input: In<typeof CatalogTestInput>): CatalogTestDetail {
  validateTestRefs(input);
  assertUnique('tests', 'code', input.code, 'tests_code_uq');
  const { analyteIds, ...fields } = input;
  const row = insert('tests', fields);
  setTestAnalytes(row.id, analyteIds);
  record({ action: 'catalog.test.created', entityType: 'test', entityId: row.id, summary: `${row.code} · ${row.nameEn}`, after: input });
  changed('test');
  return getTest(row.id);
}

export function updateTest(id: string, input: In<typeof CatalogTestInput>): CatalogTestDetail {
  const row = find('tests', id);
  if (!row) throw notFound();
  validateTestRefs(input);
  assertUnique('tests', 'code', input.code, 'tests_code_uq', id);
  const before = { ...row };
  const { analyteIds, ...fields } = input;
  const previousAnalytes = analyteIdsOf(id);
  update('tests', row, { ...fields, updatedAt: now() });
  if (previousAnalytes.join(',') !== analyteIds.join(',')) setTestAnalytes(id, analyteIds);
  const diff = changes({ ...before, analyteIds: previousAnalytes } as Record<string, unknown>, input as Record<string, unknown>);
  if (diff) record({ action: 'catalog.test.updated', entityType: 'test', entityId: id, summary: `${input.code} · ${input.nameEn}`, ...diff });
  changed('test');
  return getTest(id);
}

export function deleteTest(id: string) {
  const before = find('tests', id);
  if (!before) throw notFound();
  if (by('orderItems', 'testId', id).length > 0) throw conflict('test_ordered', 'The test has been ordered; deactivate it instead');
  remove('tests', (t) => t.id === id);
  remove('testAnalytes', (r) => r.testId === id);
  remove('packageTests', (r) => r.testId === id);
  remove('priceOverrides', (r) => r.testId === id);
  record({ action: 'catalog.test.deleted', entityType: 'test', entityId: id, summary: `${before.code} · ${before.nameEn}`, before });
  changed('test');
  return { ok: true };
}

/* ================================================================== analytes */

function analyteOut(a: Row<'analytes'>): CatalogAnalyte {
  const testCodes = by('testAnalytes', 'analyteId', a.id)
    .map((ta) => find('tests', ta.testId)?.code)
    .filter((code): code is string => !!code)
    .sort(cmp);
  return {
    id: a.id,
    code: a.code,
    nameAr: a.nameAr,
    nameEn: a.nameEn,
    unit: a.unit,
    resultType: a.resultType,
    decimals: a.decimals,
    options: a.options,
    formula: a.formula,
    deltaPct: a.deltaPct,
    loinc: a.loinc,
    sortOrder: a.sortOrder,
    isActive: a.isActive,
    rangeCount: by('referenceRanges', 'analyteId', a.id).length,
    testCodes,
  };
}

export function listAnalytes(f: { q?: string; type?: string; testId?: string }): CatalogAnalyte[] {
  const inTest = f.testId ? new Set(by('testAnalytes', 'testId', f.testId).map((r) => r.analyteId)) : null;
  const term = f.q ? likeTerm(f.q) : '';
  return rows('analytes')
    .filter((a) => {
      if (f.type && a.resultType !== f.type) return false;
      if (inTest && !inTest.has(a.id)) return false;
      if (f.q && !(startsWith(a.code, term) || contains(a.nameEn, term) || contains(a.nameAr, term))) return false;
      return true;
    })
    .sort((a, b) => cmp(a.sortOrder, b.sortOrder) || cmp(a.code, b.code))
    .map(analyteOut);
}

function rangeOut(r: Row<'referenceRanges'>): CatalogRange {
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

function rangesOf(analyteId: string): Row<'referenceRanges'>[] {
  return by('referenceRanges', 'analyteId', analyteId).sort((a, b) => cmp(a.sortOrder, b.sortOrder) || cmp(a.ageMinDays, b.ageMinDays));
}

export function getAnalyte(id: string): CatalogAnalyteDetail {
  const a = find('analytes', id);
  if (!a) throw notFound();
  const tests = by('testAnalytes', 'analyteId', id)
    .map((ta) => find('tests', ta.testId))
    .filter((t): t is Row<'tests'> => !!t)
    .map((t) => ({ id: t.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn }));
  return { ...analyteOut(a), ranges: rangesOf(id).map(rangeOut), tests, results: by('results', 'analyteId', id).length };
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
export function checkFormula(input: { formula: string; analyteId?: string; code?: string }): CatalogFormulaCheck {
  const all = [...rows('analytes')].sort((a, b) => cmp(a.code, b.code));
  const self = input.analyteId ? all.find((a) => a.id === input.analyteId) : undefined;
  const selfCode = input.code ?? self?.code ?? null;
  const allowed = all.filter((a) => a.id !== input.analyteId && a.code !== selfCode).map(({ code, nameAr, nameEn, unit }) => ({ code, nameAr, nameEn, unit }));
  const base = { variables: [] as string[], unknown: [] as string[], cycle: null as string[] | null, allowed };
  const formula = (input.formula ?? '').trim();
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

function validateAnalyte(input: In<typeof CatalogAnalyteInput>, id?: string): void {
  if (input.resultType !== 'calculated') return;
  const check = checkFormula({ formula: input.formula ?? '', analyteId: id, code: input.code });
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

/** Whether a stored formula uses an analyte code as a variable. */
function usesCode(formula: string, code: string): boolean {
  try {
    return formulaVariables(formula).some((v) => v === code || v.toUpperCase() === code);
  } catch {
    return false;
  }
}

export function createAnalyte(input: In<typeof CatalogAnalyteInput>): CatalogAnalyteDetail {
  validateAnalyte(input);
  assertUnique('analytes', 'code', input.code, 'analytes_code_uq');
  const fields = analyteFields(input);
  const row = insert('analytes', fields);
  record({ action: 'catalog.analyte.created', entityType: 'analyte', entityId: row.id, summary: `${row.code} · ${row.nameEn}`, after: fields });
  changed('analyte');
  return getAnalyte(row.id);
}

export function updateAnalyte(id: string, input: In<typeof CatalogAnalyteInput>): CatalogAnalyteDetail {
  const row = find('analytes', id);
  if (!row) throw notFound();
  validateAnalyte(input, id);
  if (input.code !== undefined && row.code !== input.code) {
    const using = rows('analytes').filter((d) => d.resultType === 'calculated' && !!d.formula && d.id !== id && usesCode(d.formula, row.code));
    if (using.length) throw conflict('analyte_code_in_formula', using.map((d) => d.code).join(', '));
  }
  if (input.resultType !== undefined && row.resultType !== input.resultType && by('results', 'analyteId', id).length > 0) {
    throw conflict('analyte_has_results', 'The result type cannot change once results exist');
  }
  assertUnique('analytes', 'code', input.code, 'analytes_code_uq', id);
  const before = { ...row };
  const fields = analyteFields(input);
  update('analytes', row, fields);
  const diff = changes(before as Record<string, unknown>, fields as Record<string, unknown>);
  if (diff) record({ action: 'catalog.analyte.updated', entityType: 'analyte', entityId: id, summary: `${input.code} · ${input.nameEn}`, ...diff });
  changed('analyte');
  return getAnalyte(id);
}

export function deleteAnalyte(id: string) {
  const before = find('analytes', id);
  if (!before) throw notFound();
  if (by('results', 'analyteId', id).length > 0) throw conflict('analyte_has_results', 'Results exist; deactivate it instead');
  const usedBy = by('testAnalytes', 'analyteId', id)
    .map((ta) => find('tests', ta.testId))
    .filter((t): t is Row<'tests'> => !!t);
  if (usedBy.length) throw conflict('analyte_in_test', usedBy.map((t) => t.code).join(', '));
  const inFormula = rows('analytes').filter((d) => d.resultType === 'calculated' && !!d.formula && usesCode(d.formula, before.code));
  if (inFormula.length) throw conflict('analyte_code_in_formula', inFormula.map((d) => d.code).join(', '));
  const materials = new Set(by('qcMaterials', 'analyteId', id).map((m) => m.id));
  remove('analytes', (a) => a.id === id);
  remove('testAnalytes', (r) => r.analyteId === id);
  remove('referenceRanges', (r) => r.analyteId === id);
  remove('instrumentMappings', (r) => r.analyteId === id);
  if (materials.size) {
    remove('qcMaterials', (m) => materials.has(m.id));
    remove('qcRuns', (r) => materials.has(r.materialId));
  }
  record({ action: 'catalog.analyte.deleted', entityType: 'analyte', entityId: id, summary: `${before.code} · ${before.nameEn}`, before });
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
export function checkRanges(list: RangeIn[]): CatalogRangeCheck {
  const errors: CatalogRangeIssue[] = [];
  const warnings: CatalogRangeIssue[] = [];
  list.forEach((r, i) => {
    if (r.ageMaxDays !== null && r.ageMaxDays < r.ageMinDays) errors.push({ row: i, code: 'age_order' });
    if (r.low !== null && r.high !== null && r.low > r.high) errors.push({ row: i, code: 'low_above_high' });
    if (r.criticalLow !== null && r.criticalHigh !== null && r.criticalLow >= r.criticalHigh) errors.push({ row: i, code: 'critical_order' });
    if (r.low === null && r.high === null && r.criticalLow === null && r.criticalHigh === null && !r.textRange) errors.push({ row: i, code: 'empty_row' });
    if (r.criticalLow !== null && r.low !== null && r.criticalLow > r.low) warnings.push({ row: i, code: 'critical_low_inside' });
    if (r.criticalHigh !== null && r.high !== null && r.criticalHigh < r.high) warnings.push({ row: i, code: 'critical_high_inside' });
  });
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.sex !== b.sex || (a.sampleTypeId ?? null) !== (b.sampleTypeId ?? null) || (a.instrumentId ?? null) !== (b.instrumentId ?? null)) continue;
      if (overlaps(a, b)) errors.push({ row: j, other: i, code: 'overlap' });
    }
  }
  const base = list.filter((r) => !r.sampleTypeId && !r.instrumentId);
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

function validateRangeRefs(list: RangeIn[]): void {
  assertIdsExist('sampleTypes', list.map((r) => r.sampleTypeId).filter((x): x is string => !!x), 'sampleTypeId');
  assertIdsExist('instruments', list.map((r) => r.instrumentId).filter((x): x is string => !!x), 'instrumentId');
}

export function previewRanges(analyteId: string, list: RangeIn[]): CatalogRangeCheck {
  if (!find('analytes', analyteId)) throw notFound();
  validateRangeRefs(list);
  return checkRanges(list);
}

/** Replace every reference range of an analyte. Overlapping rows are refused; gaps come back as warnings. */
export function replaceRanges(analyteId: string, list: RangeIn[]): { ranges: CatalogRange[]; check: CatalogRangeCheck } {
  const a = find('analytes', analyteId);
  if (!a) throw notFound();
  const check = checkRanges(list);
  if (!check.ok) {
    const errors: Record<string, string[]> = {};
    for (const e of check.errors) (errors[`rows.${e.row}`] ??= []).push(e.other !== undefined ? `${e.code}:${e.other}` : e.code);
    const overlap = check.errors.some((e) => e.code === 'overlap');
    throw badRequest(overlap ? 'range_overlap' : 'range_invalid', overlap ? 'Ranges overlap for the same sex, specimen and instrument' : 'Invalid range rows', errors);
  }
  validateRangeRefs(list);
  const before = by('referenceRanges', 'analyteId', analyteId).sort((x, y) => cmp(x.sortOrder, y.sortOrder));
  remove('referenceRanges', (r) => r.analyteId === analyteId);
  list.forEach((r, i) => insert('referenceRanges', { ...r, analyteId, sortOrder: i }));
  const strip = (r: RangeIn | Row<'referenceRanges'>) => ({
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
  record({
    action: 'catalog.ranges.replaced',
    entityType: 'analyte',
    entityId: analyteId,
    summary: `${a.code}: ${before.length} → ${list.length} range(s)`,
    before: before.map(strip),
    after: list.map(strip),
  });
  changed('ranges');
  const saved = by('referenceRanges', 'analyteId', analyteId).sort((x, y) => cmp(x.sortOrder, y.sortOrder));
  return { ranges: saved.map(rangeOut), check };
}

/* ================================================================== packages */

export function listPackages(): CatalogPackage[] {
  return [...rows('packages')]
    .sort((a, b) => cmp(a.code, b.code))
    .map((p) => {
      const testIds = by('packageTests', 'packageId', p.id).map((pt) => pt.testId);
      const testUnits = testIds.reduce((sum, id) => sum + (find('tests', id)?.units ?? 0), 0);
      return {
        id: p.id,
        code: p.code,
        nameAr: p.nameAr,
        nameEn: p.nameEn,
        priceMode: p.priceMode,
        units: p.units,
        fixedPrice: p.fixedPrice,
        isActive: p.isActive,
        testIds,
        testUnits: Number(testUnits),
      };
    });
}

function getPackage(id: string): CatalogPackage {
  const found = listPackages().find((p) => p.id === id);
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

function setPackageTests(packageId: string, testIds: string[]): void {
  remove('packageTests', (r) => r.packageId === packageId);
  for (const testId of new Set(testIds)) insert('packageTests', { packageId, testId });
}

export function createPackage(input: In<typeof CatalogPackageInput>): CatalogPackage {
  assertIdsExist('tests', input.testIds, 'testIds');
  assertUnique('packages', 'code', input.code, 'packages_code_uq');
  const fields = packageFields(input);
  const row = insert('packages', fields);
  setPackageTests(row.id, input.testIds);
  record({ action: 'catalog.package.created', entityType: 'package', entityId: row.id, summary: `${row.code} · ${row.nameEn}`, after: { ...fields, testIds: input.testIds } });
  changed('package');
  return getPackage(row.id);
}

export function updatePackage(id: string, input: In<typeof CatalogPackageInput>): CatalogPackage {
  const before = getPackage(id);
  assertIdsExist('tests', input.testIds, 'testIds');
  assertUnique('packages', 'code', input.code, 'packages_code_uq', id);
  const fields = packageFields(input);
  update('packages', find('packages', id)!, fields);
  const sortedBefore = [...before.testIds].sort().join(',');
  const sortedAfter = [...new Set(input.testIds)].sort().join(',');
  if (sortedBefore !== sortedAfter) setPackageTests(id, input.testIds);
  const diff = changes(
    { ...before, testIds: [...before.testIds].sort() } as Record<string, unknown>,
    { ...fields, testIds: [...new Set(input.testIds)].sort() } as Record<string, unknown>,
  );
  if (diff) record({ action: 'catalog.package.updated', entityType: 'package', entityId: id, summary: `${input.code} · ${input.nameEn}`, ...diff });
  changed('package');
  return getPackage(id);
}

export function deletePackage(id: string) {
  const before = getPackage(id);
  if (by('orderItems', 'packageId', id).length > 0) throw conflict('package_ordered', 'The package has been ordered; deactivate it instead');
  remove('packages', (p) => p.id === id);
  remove('packageTests', (r) => r.packageId === id);
  record({ action: 'catalog.package.deleted', entityType: 'package', entityId: id, summary: `${before.code} · ${before.nameEn}`, before });
  changed('package');
  return { ok: true };
}

/* ================================================================== routes */

export function registerCatalog(): void {
  const manage = { perm: 'catalog.manage' };

  route('GET', '/catalog/lookups', () => lookups());

  const simple = [
    { path: 'departments', kind: 'department', schema: CatalogDepartmentInput },
    { path: 'sample-types', kind: 'sample_type', schema: CatalogSampleTypeInput },
    { path: 'containers', kind: 'container', schema: CatalogContainerInput },
    { path: 'rejection-reasons', kind: 'rejection_reason', schema: CatalogRejectionReasonInput },
  ] as const;
  for (const s of simple) {
    route('GET', `/catalog/${s.path}`, () => {
      const all = lookups();
      return {
        department: all.departments,
        sample_type: all.sampleTypes,
        container: all.containers,
        rejection_reason: all.rejectionReasons,
      }[s.kind];
    });
    route('POST', `/catalog/${s.path}`, manage, (req) => createSimple(s.kind, input(s.schema, req.body) as never));
    route('PUT', `/catalog/${s.path}/:id`, manage, (req) => updateSimple(s.kind, req.params.id, input(s.schema, req.body) as never));
    route('DELETE', `/catalog/${s.path}/:id`, manage, (req) => deleteSimple(s.kind, req.params.id));
  }

  route('GET', '/catalog/tests', (req) =>
    listTests(
      parse(
        z.object({ q: z.string().trim().max(80).optional(), departmentId: z.string().uuid().optional(), active: z.enum(['true', 'false', 'all']).default('all') }),
        req.query,
      ),
    ),
  );
  route('GET', '/catalog/tests/:id', (req) => getTest(req.params.id));
  route('POST', '/catalog/tests', manage, (req) => createTest(input(CatalogTestInput, req.body)));
  route('PUT', '/catalog/tests/:id', manage, (req) => updateTest(req.params.id, input(CatalogTestInput, req.body)));
  route('DELETE', '/catalog/tests/:id', manage, (req) => deleteTest(req.params.id));

  route('GET', '/catalog/analytes', (req) =>
    listAnalytes(
      parse(
        z.object({ q: z.string().trim().max(80).optional(), type: z.enum(['numeric', 'text', 'option', 'calculated']).optional(), testId: z.string().uuid().optional() }),
        req.query,
      ),
    ),
  );
  route('GET', '/catalog/analytes/:id', (req) => getAnalyte(req.params.id));
  route('POST', '/catalog/analytes', manage, (req) => createAnalyte(input(CatalogAnalyteInput, req.body)));
  route('PUT', '/catalog/analytes/:id', manage, (req) => updateAnalyte(req.params.id, input(CatalogAnalyteInput, req.body)));
  route('DELETE', '/catalog/analytes/:id', manage, (req) => deleteAnalyte(req.params.id));

  route('PUT', '/catalog/analytes/:id/ranges', manage, (req) => replaceRanges(req.params.id, inputRows(CatalogRangeInput, req.body?.rows)));
  /** Dry run for the editor: overlap errors, warnings and age gaps without saving. */
  route('POST', '/catalog/analytes/:id/ranges/check', manage, (req) => previewRanges(req.params.id, inputRows(CatalogRangeInput, req.body?.rows)));

  route('POST', '/catalog/formula/check', manage, (req) => checkFormula(input(CatalogFormulaCheckInput, req.body)));

  route('GET', '/catalog/packages', () => listPackages());
  route('POST', '/catalog/packages', manage, (req) => createPackage(input(CatalogPackageInput, req.body)));
  route('PUT', '/catalog/packages/:id', manage, (req) => updatePackage(req.params.id, input(CatalogPackageInput, req.body)));
  route('DELETE', '/catalog/packages/:id', manage, (req) => deletePackage(req.params.id));
}

import { ROLE_TEMPLATES } from '@natija/domain';
import { PROFILES, type InstrumentModel } from '@natija/protocols';
import type { DB } from '../index';
import * as s from '../schema';
import {
  ANALYTES,
  CONTAINERS,
  DEPARTMENTS,
  EXPENSE_CATEGORIES,
  PACKAGES,
  PAYMENT_METHODS,
  REJECTION_REASONS,
  SAMPLE_TYPES,
  TESTS,
  type AnalyteDef,
  type TestDef,
} from './catalog-data';
import { DOCTORS, type LabDef } from './labs-data';
import { hashPassword } from './password';

export type LabSeed = {
  lab: typeof s.labs.$inferSelect;
  def: LabDef;
  departments: Map<string, string>;
  sampleTypes: Map<string, string>;
  containers: Map<string, string>;
  rejectionReasons: Map<string, string>;
  analytes: Map<string, { id: string; def: AnalyteDef }>;
  tests: Map<string, { id: string; def: TestDef; analyteIds: string[] }>;
  packages: Map<string, { id: string; testCodes: string[] }>;
  payers: Map<string, typeof s.payerGroups.$inferSelect>;
  doctors: string[];
  users: Map<string, string>;
  branches: Map<string, string>;
  instruments: Map<InstrumentModel, string>;
  paymentMethods: Map<string, string>;
  expenseCategories: string[];
};

export const INSTRUMENT_CODES: Record<InstrumentModel, string> = {
  sysmex_xn: 'XN550',
  mindray_bs430: 'BS430',
  cobas_pure: 'PURE',
  cobas_e411: 'E411',
  ichroma3: 'ICHROMA',
  medica_easystat: 'EASYSTAT',
};

export async function seedLab(db: DB, def: LabDef, password: string): Promise<LabSeed> {
  const [lab] = await db
    .insert(s.labs)
    .values({
      code: def.code,
      nameAr: def.nameAr,
      nameEn: def.nameEn,
      taglineAr: def.taglineAr,
      taglineEn: def.taglineEn,
      city: def.city,
      addressAr: def.addressAr,
      addressEn: def.addressEn,
      phone: def.phone,
      email: def.email,
      directorNameAr: def.directorNameAr,
      directorNameEn: def.directorNameEn,
      directorTitleAr: def.directorTitleAr,
      directorTitleEn: def.directorTitleEn,
      brandColor: def.brandColor,
      logoSvg: def.logoSvg,
      currency: 'SYP',
      timezone: 'Asia/Damascus',
      settings: {
        segregationOfDuties: true,
        digits: 'latin',
        defaultLanguage: 'ar',
        reportLanguage: 'bilingual',
        deltaCheckDays: 365,
        showUsd: false,
        requireCollectionStep: true,
        demo: true,
      },
    })
    .returning();
  const labId = lab!.id;
  const byCode = <T extends { code: string; id: string }>(rows: T[]) => new Map(rows.map((r) => [r.code, r.id]));

  const branches = byCode(
    await db
      .insert(s.branches)
      .values(def.branches.map((b) => ({ labId, code: b.code, nameAr: b.ar, nameEn: b.en, isMain: !!b.main })))
      .returning(),
  );
  const departments = byCode(
    await db
      .insert(s.departments)
      .values(DEPARTMENTS.map((d, i) => ({ labId, code: d.code, nameAr: d.ar, nameEn: d.en, sortOrder: i })))
      .returning(),
  );
  const sampleTypes = byCode(
    await db.insert(s.sampleTypes).values(SAMPLE_TYPES.map((t) => ({ labId, code: t.code, nameAr: t.ar, nameEn: t.en }))).returning(),
  );
  const containers = byCode(
    await db
      .insert(s.containers)
      .values(CONTAINERS.map((c) => ({ labId, code: c.code, nameAr: c.ar, nameEn: c.en, capColor: c.cap, volumeMl: c.ml })))
      .returning(),
  );
  const rejectionReasons = byCode(
    await db.insert(s.rejectionReasons).values(REJECTION_REASONS.map((r) => ({ labId, code: r.code, nameAr: r.ar, nameEn: r.en }))).returning(),
  );

  const analyteRows = await db
    .insert(s.analytes)
    .values(
      ANALYTES.map((a, i) => ({
        labId,
        code: a.code,
        nameEn: a.en,
        nameAr: a.ar,
        unit: a.unit ?? null,
        resultType: a.type ?? 'numeric',
        decimals: a.decimals ?? 1,
        options: a.options ?? [],
        formula: a.formula ?? null,
        deltaPct: a.deltaPct ?? null,
        loinc: a.loinc ?? null,
        sortOrder: i,
      })),
    )
    .returning();
  const analytes = new Map(analyteRows.map((r) => [r.code, { id: r.id, def: ANALYTES.find((a) => a.code === r.code)! }]));

  const rangeRows = ANALYTES.flatMap((a) =>
    (a.ranges ?? []).map((r, i) => ({
      labId,
      analyteId: analytes.get(a.code)!.id,
      sex: r.sex ?? ('any' as const),
      ageMinDays: r.ageMin ?? 0,
      ageMaxDays: r.ageMax ?? null,
      low: r.low ?? null,
      high: r.high ?? null,
      criticalLow: r.critLow ?? null,
      criticalHigh: r.critHigh ?? null,
      textRange: r.text ?? null,
      sortOrder: i,
    })),
  );
  if (rangeRows.length) await db.insert(s.referenceRanges).values(rangeRows);

  const testRows = await db
    .insert(s.tests)
    .values(
      TESTS.map((t, i) => ({
        labId,
        code: t.code,
        nameEn: t.en,
        nameAr: t.ar,
        departmentId: departments.get(t.dept)!,
        sampleTypeId: sampleTypes.get(t.sampleType)!,
        containerId: containers.get(t.container)!,
        units: t.units,
        tatHours: t.tat ?? 24,
        method: t.method ?? null,
        isFavorite: !!t.favorite,
        separateTube: !!t.separateTube,
        sortOrder: i,
      })),
    )
    .returning();
  const tests = new Map(
    testRows.map((r) => {
      const d = TESTS.find((t) => t.code === r.code)!;
      return [r.code, { id: r.id, def: d, analyteIds: d.analytes.map((c) => analytes.get(c)!.id) }];
    }),
  );
  await db.insert(s.testAnalytes).values(
    [...tests.values()].flatMap((t) => t.analyteIds.map((analyteId, i) => ({ labId, testId: t.id, analyteId, sortOrder: i }))),
  );

  const packageRows = await db
    .insert(s.packages)
    .values(PACKAGES.map((p) => ({ labId, code: p.code, nameAr: p.ar, nameEn: p.en, priceMode: p.mode, units: p.units })))
    .returning();
  const packages = new Map(packageRows.map((r) => [r.code, { id: r.id, testCodes: PACKAGES.find((p) => p.code === r.code)!.tests }]));
  await db.insert(s.packageTests).values(
    [...packages.values()].flatMap((p) => p.testCodes.map((code) => ({ labId, packageId: p.id, testId: tests.get(code)!.id }))),
  );

  const payerRows = await db
    .insert(s.payerGroups)
    .values(
      def.payers.map((p) => ({
        labId,
        code: p.code,
        nameAr: p.ar,
        nameEn: p.en,
        kind: p.kind,
        unitPrice: p.unitPrice,
        patientSharePct: p.patientSharePct ?? 100,
        discountPct: p.discountPct ?? 0,
        onAccount: !!p.onAccount,
        organization: p.organization ?? null,
      })),
    )
    .returning();
  const payers = new Map(payerRows.map((r) => [r.code, r]));

  const doctorRows = await db
    .insert(s.doctors)
    .values(
      DOCTORS.slice(0, def.code === 'yasmin' ? 12 : 9).map((d, i) => ({
        labId,
        nameAr: d.ar,
        nameEn: d.en,
        specialtyAr: d.specAr,
        specialtyEn: d.specEn,
        clinic: d.clinic,
        phone: `+963 9${(30 + i) % 100} 000 ${String(100 + i).padStart(3, '0')}`,
      })),
    )
    .returning({ id: s.doctors.id });
  const doctors = doctorRows.map((d) => d.id);

  const roleRows = await db
    .insert(s.roles)
    .values(ROLE_TEMPLATES.map((r) => ({ labId, key: r.key, nameAr: r.nameAr, nameEn: r.nameEn, permissions: r.permissions, isSystem: true })))
    .returning();
  const roleIds = new Map(roleRows.map((r) => [r.key, r.id]));

  const users = new Map<string, string>();
  for (const u of def.users) {
    const [row] = await db
      .insert(s.users)
      .values({
        labId,
        username: u.username,
        fullNameAr: u.nameAr,
        fullNameEn: u.nameEn,
        title: u.title ?? null,
        passwordHash: await hashPassword(password),
        departmentIds: (u.departments ?? []).map((c) => departments.get(c)!),
      })
      .returning({ id: s.users.id });
    users.set(u.username, row!.id);
    await db.insert(s.userRoles).values(u.roles.map((key) => ({ labId, userId: row!.id, roleId: roleIds.get(key)! })));
  }

  const methodRows = await db
    .insert(s.paymentMethods)
    .values(PAYMENT_METHODS.map((m, i) => ({ labId, code: m.code, nameAr: m.ar, nameEn: m.en, isCash: m.isCash, sortOrder: i })))
    .returning();
  const paymentMethods = byCode(methodRows);
  const categoryRows = await db
    .insert(s.expenseCategories)
    .values(EXPENSE_CATEGORIES.map((c) => ({ labId, nameAr: c.ar, nameEn: c.en })))
    .returning({ id: s.expenseCategories.id });

  const instruments = new Map<InstrumentModel, string>();
  for (const model of def.instruments) {
    const p = PROFILES[model];
    const [inst] = await db
      .insert(s.instruments)
      .values({
        labId,
        code: INSTRUMENT_CODES[model],
        name: p.name,
        model,
        manufacturer: p.manufacturer,
        departmentId: departments.get(p.department) ?? null,
        protocol: p.protocol,
        transport: p.transport,
        host: p.transport === 'tcp_client' ? '192.168.10.20' : null,
        port: p.defaultPort,
        serialPort: p.transport === 'serial' ? 'COM3' : null,
        baudRate: p.serial?.baudRate ?? null,
        integrationLevel: 'L0',
        isSimulated: true,
        status: 'unknown',
        notes: p.note,
      })
      .returning({ id: s.instruments.id });
    instruments.set(model, inst!.id);
    const mappings = p.tests
      .filter((t) => analytes.has(t.analyte))
      .map((t) => ({ labId, instrumentId: inst!.id, instrumentCode: t.code, analyteId: analytes.get(t.analyte)!.id, instrumentUnit: t.unit, unitFactor: 1 }));
    if (mappings.length) await db.insert(s.instrumentMappings).values(mappings);
  }

  // QC materials on the instruments each lab owns.
  const qc: Array<{ model: InstrumentModel; analyte: string; name: string; level: string; mean: number; sd: number; unit: string }> = [
    { model: 'sysmex_xn', analyte: 'HGB', name: 'XN Check', level: 'L1', mean: 6.1, sd: 0.15, unit: 'g/dL' },
    { model: 'sysmex_xn', analyte: 'HGB', name: 'XN Check', level: 'L2', mean: 12.9, sd: 0.25, unit: 'g/dL' },
    { model: 'sysmex_xn', analyte: 'WBC', name: 'XN Check', level: 'L2', mean: 7.2, sd: 0.22, unit: '10³/µL' },
    { model: 'mindray_bs430', analyte: 'GLU', name: 'Chemistry control', level: 'L1', mean: 92, sd: 3, unit: 'mg/dL' },
    { model: 'mindray_bs430', analyte: 'GLU', name: 'Chemistry control', level: 'L2', mean: 246, sd: 7, unit: 'mg/dL' },
    { model: 'cobas_pure', analyte: 'GLU', name: 'PreciControl ClinChem', level: 'L1', mean: 95, sd: 2.8, unit: 'mg/dL' },
    { model: 'cobas_pure', analyte: 'K', name: 'PreciControl ClinChem', level: 'L1', mean: 4.1, sd: 0.08, unit: 'mmol/L' },
    { model: 'cobas_e411', analyte: 'TSH', name: 'PreciControl Universal', level: 'L1', mean: 1.45, sd: 0.07, unit: 'µIU/mL' },
    { model: 'cobas_e411', analyte: 'TSH', name: 'PreciControl Universal', level: 'L2', mean: 8.1, sd: 0.35, unit: 'µIU/mL' },
  ];
  const qcRows = qc
    .filter((m) => instruments.has(m.model))
    .map((m) => ({
      labId,
      instrumentId: instruments.get(m.model)!,
      analyteId: analytes.get(m.analyte)!.id,
      name: m.name,
      lot: `LOT-${m.analyte}-${m.level}-2611`,
      level: m.level,
      targetMean: m.mean,
      targetSd: m.sd,
      unit: m.unit,
      expiresOn: '2027-06-30',
    }));
  if (qcRows.length) await db.insert(s.qcMaterials).values(qcRows);

  return {
    lab: lab!,
    def,
    departments,
    sampleTypes,
    containers,
    rejectionReasons,
    analytes,
    tests,
    packages,
    payers,
    doctors,
    users,
    branches,
    instruments,
    paymentMethods,
    expenseCategories: categoryRows.map((c) => c.id),
  };
}

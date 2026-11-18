/**
 * Request and response shapes for lab administration, the finance back office,
 * dashboards and reports. Input schemas are validated on the server (zod) and reused by
 * the web app; response types describe JSON as it arrives (dates are ISO strings).
 */
import { z } from 'zod';
import { isoDate } from './common';

/* ================================================================== helpers */

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(200);
/** Optional free text; empty strings become null. */
const optText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const optNumber = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? null : v));
const optUuid = uuid.nullish().transform((v) => v ?? null);
const money = z.number().min(0).max(1_000_000_000_000);
const sortOrder = z.number().int().min(0).max(99_999).default(0);
/** Short codes: letters, digits and . _ - (tests, departments, payers…). */
const code = (max = 30) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/, 'invalid_code');
/** Analyte codes double as formula variables, so they must be valid identifiers (WBC, NEUT%, NEUT#). */
const analyteCode = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z_][A-Za-z0-9_.%#]*$/, 'invalid_analyte_code');

export const adminIdParam = z.object({ id: uuid });

/** Optional date range (calendar days in the lab's time zone). */
export const adminRangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
export const adminListQuery = adminRangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(100).optional(),
});

export type AdminNamed = { id: string; code: string; nameAr: string; nameEn: string };

/* ================================================================== catalog */

export const CATALOG_CAP_COLORS = ['lavender', 'gold', 'lightblue', 'grey', 'green', 'red', 'black', 'yellow', 'brown', 'white'] as const;
export const CATALOG_ANALYTE_TYPES = ['numeric', 'text', 'option', 'calculated'] as const;
export const CATALOG_PRICE_MODES = ['sum', 'units', 'fixed'] as const;

export const CatalogDepartmentInput = z.object({ code: code(20), nameAr: name, nameEn: name, sortOrder });
export const CatalogSampleTypeInput = z.object({ code: code(20), nameAr: name, nameEn: name });
export const CatalogContainerInput = z.object({
  code: code(20),
  nameAr: name,
  nameEn: name,
  capColor: z.enum(CATALOG_CAP_COLORS),
  volumeMl: optNumber(0, 10_000),
});
export const CatalogRejectionReasonInput = z.object({ code: code(30), nameAr: name, nameEn: name });

export const CatalogTestInput = z.object({
  code: code(30),
  nameEn: name,
  nameAr: name,
  reportNameEn: optText(200),
  reportNameAr: optText(200),
  departmentId: uuid,
  sampleTypeId: uuid,
  containerId: uuid,
  units: z.number().min(0).max(100_000),
  fixedPrice: optNumber(0, 1_000_000_000_000),
  tatHours: z.number().int().min(1).max(24 * 120),
  method: optText(200),
  isExternal: z.boolean().default(false),
  separateTube: z.boolean().default(false),
  isFavorite: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder,
  notes: optText(1000),
  /** Analytes in report order. */
  analyteIds: z.array(uuid).max(200).default([]),
});

export const CatalogAnalyteInput = z
  .object({
    code: analyteCode,
    nameEn: name,
    nameAr: name,
    unit: optText(40),
    resultType: z.enum(CATALOG_ANALYTE_TYPES),
    decimals: z.number().int().min(0).max(6).default(1),
    options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    formula: optText(1000),
    deltaPct: optNumber(0, 100_000),
    loinc: optText(20),
    sortOrder,
    isActive: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.resultType === 'calculated' && !v.formula) ctx.addIssue({ code: 'custom', path: ['formula'], message: 'formula_required' });
    if (v.resultType === 'option' && v.options.length === 0) ctx.addIssue({ code: 'custom', path: ['options'], message: 'options_required' });
  });

/** 150 years in days: the upper bound for age limits. */
export const CATALOG_MAX_AGE_DAYS = 54_750;

export const CatalogRangeInput = z.object({
  sex: z.enum(['any', 'male', 'female']).default('any'),
  ageMinDays: z.number().int().min(0).max(CATALOG_MAX_AGE_DAYS).default(0),
  ageMaxDays: optNumber(0, CATALOG_MAX_AGE_DAYS),
  low: optNumber(-1e12, 1e12),
  high: optNumber(-1e12, 1e12),
  criticalLow: optNumber(-1e12, 1e12),
  criticalHigh: optNumber(-1e12, 1e12),
  textRange: optText(300),
  sampleTypeId: optUuid,
  instrumentId: optUuid,
  note: optText(300),
});
export const CatalogRangesInput = z.object({ rows: z.array(CatalogRangeInput).max(100) });

export const CatalogFormulaCheckInput = z.object({ formula: z.string().max(1000), analyteId: uuid.optional(), code: z.string().max(30).optional() });

export const CatalogPackageInput = z
  .object({
    code: code(30),
    nameAr: name,
    nameEn: name,
    priceMode: z.enum(CATALOG_PRICE_MODES),
    units: optNumber(0, 1_000_000),
    fixedPrice: optNumber(0, 1_000_000_000_000),
    isActive: z.boolean().default(true),
    testIds: z.array(uuid).min(1).max(200),
  })
  .superRefine((v, ctx) => {
    if (v.priceMode === 'units' && v.units === null) ctx.addIssue({ code: 'custom', path: ['units'], message: 'units_required' });
    if (v.priceMode === 'fixed' && v.fixedPrice === null) ctx.addIssue({ code: 'custom', path: ['fixedPrice'], message: 'price_required' });
  });

export type CatalogDepartment = AdminNamed & { sortOrder: number; testCount: number };
export type CatalogSampleType = AdminNamed & { testCount: number };
export type CatalogContainer = AdminNamed & { capColor: string; volumeMl: number | null; testCount: number };
export type CatalogRejectionReason = AdminNamed & { useCount: number };
export type CatalogInstrumentRef = { id: string; code: string; name: string; status: string };

export type CatalogLookups = {
  departments: CatalogDepartment[];
  sampleTypes: CatalogSampleType[];
  containers: CatalogContainer[];
  rejectionReasons: CatalogRejectionReason[];
  instruments: CatalogInstrumentRef[];
};

export type CatalogTest = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  reportNameAr: string | null;
  reportNameEn: string | null;
  departmentId: string;
  sampleTypeId: string;
  containerId: string;
  units: number;
  fixedPrice: number | null;
  tatHours: number;
  method: string | null;
  isExternal: boolean;
  separateTube: boolean;
  isFavorite: boolean;
  isActive: boolean;
  sortOrder: number;
  notes: string | null;
  analyteCount: number;
  /** Capped tube colour, for the list. */
  capColor: string;
};
export type CatalogTestDetail = CatalogTest & {
  analytes: Array<{ id: string; code: string; nameAr: string; nameEn: string; unit: string | null; resultType: string }>;
  packages: Array<{ id: string; code: string; nameAr: string; nameEn: string }>;
  ordered: number;
};

export type CatalogAnalyte = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unit: string | null;
  resultType: (typeof CATALOG_ANALYTE_TYPES)[number];
  decimals: number;
  options: string[];
  formula: string | null;
  deltaPct: number | null;
  loinc: string | null;
  sortOrder: number;
  isActive: boolean;
  rangeCount: number;
  testCodes: string[];
};
export type CatalogRange = z.output<typeof CatalogRangeInput> & { id?: string; sortOrder?: number };
export type CatalogRangeGap = { sex: 'any' | 'male' | 'female'; fromDays: number; toDays: number | null };
export type CatalogRangeIssue = { row: number; other?: number; code: string };
export type CatalogRangeCheck = { ok: boolean; errors: CatalogRangeIssue[]; warnings: CatalogRangeIssue[]; gaps: CatalogRangeGap[] };
export type CatalogAnalyteDetail = CatalogAnalyte & {
  ranges: CatalogRange[];
  tests: Array<{ id: string; code: string; nameAr: string; nameEn: string }>;
  results: number;
};
export type CatalogFormulaCheck = { ok: boolean; error: string | null; variables: string[]; unknown: string[]; cycle: string[] | null; allowed: Array<{ code: string; nameAr: string; nameEn: string; unit: string | null }> };

export type CatalogPackage = AdminNamed & {
  priceMode: (typeof CATALOG_PRICE_MODES)[number];
  units: number | null;
  fixedPrice: number | null;
  isActive: boolean;
  testIds: string[];
  testUnits: number;
};

/* ================================================================== pricing */

export const PRICING_PAYER_KINDS = ['public', 'insurer', 'client_lab', 'other'] as const;

export const PricingPayerGroupInput = z.object({
  code: code(30),
  nameAr: name,
  nameEn: name,
  kind: z.enum(PRICING_PAYER_KINDS),
  unitPrice: money,
  patientSharePct: z.number().min(0).max(100),
  discountPct: z.number().min(0).max(100),
  onAccount: z.boolean().default(false),
  organization: optText(200),
  contactName: optText(200),
  phone: optText(40),
  isActive: z.boolean().default(true),
});
export const PricingOverrideInput = z.object({ payerGroupId: uuid, testId: uuid, price: money });
export const PricingBulkUnitPriceInput = z
  .object({
    payerGroupIds: z.array(uuid).min(1).max(100),
    mode: z.enum(['set', 'percent']),
    value: z.number().min(-90).max(1_000_000_000),
    roundTo: z.number().int().min(1).max(100_000).default(1),
    reason: optText(300),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'set' && v.value < 0) ctx.addIssue({ code: 'custom', path: ['value'], message: 'must_be_positive' });
    if (v.mode === 'percent' && v.value > 1000) ctx.addIssue({ code: 'custom', path: ['value'], message: 'too_large' });
  });

export type PricingPayerGroup = AdminNamed & {
  kind: (typeof PRICING_PAYER_KINDS)[number];
  unitPrice: number;
  patientSharePct: number;
  discountPct: number;
  onAccount: boolean;
  organization: string | null;
  contactName: string | null;
  phone: string | null;
  isActive: boolean;
  overrideCount: number;
  orderCount: number;
};
export type PricingOverride = { id: string; payerGroupId: string; testId: string; price: number; testCode: string; testNameAr: string; testNameEn: string; computedPrice: number };
export type PricingCell = { price: number; net: number; patientShare: number; insurerShare: number; source: 'override' | 'fixed' | 'units' };
export type PricingPriceList = {
  payers: PricingPayerGroup[];
  rows: Array<{ testId: string; code: string; nameAr: string; nameEn: string; departmentId: string; units: number; fixedPrice: number | null; prices: Record<string, PricingCell> }>;
};
export type PricingBulkResult = { changes: Array<{ payerGroupId: string; code: string; before: number; after: number }> };

/* ================================================================== doctors */

export const DoctorUpsertInput = z.object({
  nameAr: name,
  nameEn: optText(200),
  specialtyAr: optText(200),
  specialtyEn: optText(200),
  phone: optText(40),
  clinic: optText(200),
  notes: optText(1000),
  isActive: z.boolean().default(true),
});
export type DoctorRow = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  specialtyAr: string | null;
  specialtyEn: string | null;
  phone: string | null;
  clinic: string | null;
  notes: string | null;
  isActive: boolean;
  orderCount: number;
};
export type DoctorReferral = {
  doctorId: string | null;
  nameAr: string | null;
  nameEn: string | null;
  specialtyAr: string | null;
  specialtyEn: string | null;
  orders: number;
  patients: number;
  tests: number;
  /** Null when the signed-in user cannot see finance figures. */
  revenue: number | null;
};

/* ================================================================== staff */

export const StaffUserInput = z.object({
  fullNameAr: name,
  fullNameEn: name,
  title: optText(40),
  email: optText(200).refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'invalid_email'),
  phone: optText(40),
  language: z
    .enum(['ar', 'en'])
    .nullish()
    .transform((v) => v ?? null),
  roleIds: z.array(uuid).min(1).max(20),
  departmentIds: z.array(uuid).max(50).default([]),
  branchIds: z.array(uuid).max(50).default([]),
});
export const StaffUserCreateInput = StaffUserInput.extend({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{1,58}[a-z0-9]$/, 'invalid_username'),
});
export const StaffRoleInput = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'invalid_key'),
  nameAr: name,
  nameEn: name,
  permissions: z.array(z.string().max(60)).max(200),
});
export const StaffRoleUpdateInput = StaffRoleInput.omit({ key: true });

export type StaffUser = {
  id: string;
  username: string;
  fullNameAr: string;
  fullNameEn: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  language: 'ar' | 'en' | null;
  status: 'active' | 'disabled';
  roleIds: string[];
  departmentIds: string[];
  branchIds: string[];
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
};
export type StaffRole = { id: string; key: string; nameAr: string; nameEn: string; permissions: string[]; isSystem: boolean; userCount: number };
export type StaffPermissionGroup = { group: string; ar: string; en: string; permissions: Array<{ key: string; ar: string; en: string }> };
/** Returned once when a user is created or a password is reset; never stored in clear. */
export type StaffTemporaryPassword = { user: StaffUser; temporaryPassword: string };

/* ================================================================== settings */

export const SettingsLabProfileInput = z.object({
  nameAr: name,
  nameEn: name,
  taglineAr: optText(300),
  taglineEn: optText(300),
  phone: optText(60),
  email: optText(200).refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'invalid_email'),
  city: optText(100),
  addressAr: optText(300),
  addressEn: optText(300),
  directorNameAr: optText(200),
  directorNameEn: optText(200),
  directorTitleAr: optText(200),
  directorTitleEn: optText(200),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'invalid_color'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'invalid_currency'),
  timezone: z.string().trim().min(1).max(64),
});
export const SettingsLabInput = z.object({
  segregationOfDuties: z.boolean(),
  requireCollectionStep: z.boolean(),
  digits: z.enum(['latin', 'arabic']),
  defaultLanguage: z.enum(['ar', 'en']),
  reportLanguage: z.enum(['ar', 'en', 'bilingual']),
  reportFooterAr: optText(1000),
  reportFooterEn: optText(1000),
  deltaCheckDays: z.number().int().min(1).max(3650),
  showUsd: z.boolean(),
  usdRate: optNumber(0, 10_000_000),
});
/** The SVG text; the 100 KB limit is checked on its UTF-8 size by the server. */
export const SettingsLogoInput = z.object({ svg: z.string().min(1).max(250_000) });
export const SettingsPaymentMethodInput = z.object({
  code: code(20),
  nameAr: name,
  nameEn: name,
  isCash: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder,
});
export const SettingsBranchInput = z.object({
  code: code(20),
  nameAr: name,
  nameEn: name,
  addressAr: optText(300),
  addressEn: optText(300),
  phone: optText(60),
  isMain: z.boolean().default(false),
});

export type SettingsLabProfile = z.output<typeof SettingsLabProfileInput> & {
  id: string;
  code: string;
  logoSvg: string | null;
  settings: z.output<typeof SettingsLabInput> & { demo?: boolean };
  updatedAt: string;
};
export type SettingsLogoResult = { svg: string; bytes: number; removed: string[] };
export type SettingsPaymentMethod = AdminNamed & { isCash: boolean; isActive: boolean; sortOrder: number; useCount: number };
export type SettingsBranch = AdminNamed & { addressAr: string | null; addressEn: string | null; phone: string | null; isMain: boolean; orderCount: number };

/* ================================================================== finance */

export const FinanceOpenSessionInput = z.object({ openingFloat: money, branchId: optUuid });
export const FinanceCloseSessionInput = z.object({ countedCash: money, note: optText(500) });
export const FinanceRefundInput = z.object({
  invoiceId: uuid,
  amount: z.number().positive().max(1_000_000_000_000),
  methodId: uuid,
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().max(80).optional(),
});
export const FinanceDecideInput = z.object({ approve: z.boolean(), note: optText(500) });
export const FinanceExpenseInput = z.object({
  categoryId: uuid,
  amount: z.number().positive().max(1_000_000_000_000),
  /** Calendar day the expense was paid; defaults to now. */
  paidOn: isoDate.optional(),
  note: optText(500),
  /** Paid in cash from the signed-in user's open cash session. */
  fromDrawer: z.boolean().default(false),
});
export const FinanceExpenseCategoryInput = z.object({ nameAr: name, nameEn: name });

export type FinanceMethodTotal = { methodId: string; code: string; nameAr: string; nameEn: string; isCash: boolean; payments: number; refunds: number; net: number; count: number };
export type FinanceCashTotals = {
  openingFloat: number;
  cashPayments: number;
  cashRefunds: number;
  cashExpenses: number;
  expectedCash: number;
  byMethod: FinanceMethodTotal[];
  paymentCount: number;
};
export type FinanceCashSession = {
  id: string;
  status: 'open' | 'closed';
  openedBy: string;
  openedByNameAr: string | null;
  openedByNameEn: string | null;
  closedByNameAr: string | null;
  closedByNameEn: string | null;
  branchId: string | null;
  openedAt: string;
  closedAt: string | null;
  openingFloat: number;
  countedCash: number | null;
  expectedCash: number | null;
  difference: number | null;
  note: string | null;
  totals: FinanceCashTotals;
};
export type FinancePayment = {
  id: string;
  kind: 'payment' | 'refund';
  amount: number;
  currency: string;
  methodId: string;
  methodNameAr: string;
  methodNameEn: string;
  isCash: boolean;
  reference: string | null;
  note: string | null;
  receivedAt: string;
  receivedByNameAr: string | null;
  receivedByNameEn: string | null;
  cashSessionId: string | null;
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  accession: string;
  patientNameAr: string;
  patientNameEn: string | null;
};
export type FinanceInvoice = {
  id: string;
  number: string;
  orderId: string;
  accession: string;
  patientId: string;
  patientNameAr: string;
  patientNameEn: string | null;
  mrn: string;
  payerGroupId: string;
  payerNameAr: string;
  payerNameEn: string;
  payerKind: string;
  currency: string;
  subtotal: number;
  discountTotal: number;
  insurerTotal: number;
  patientTotal: number;
  paidTotal: number;
  balance: number;
  status: 'open' | 'partial' | 'paid' | 'void';
  createdAt: string;
};
export type FinanceStatement = {
  payer: PricingPayerGroup;
  from: string;
  to: string;
  invoices: FinanceInvoice[];
  totals: { count: number; subtotal: number; discountTotal: number; insurerTotal: number; patientTotal: number; paidTotal: number; balance: number };
};
export type FinanceApproval = {
  id: string;
  kind: 'discount' | 'free' | 'refund' | 'cancel';
  status: 'pending' | 'approved' | 'rejected';
  amount: number | null;
  percent: number | null;
  reason: string;
  requestedAt: string;
  requestedBy: string | null;
  requestedByNameAr: string | null;
  requestedByNameEn: string | null;
  decidedAt: string | null;
  decidedByNameAr: string | null;
  decidedByNameEn: string | null;
  decisionNote: string | null;
  orderId: string | null;
  accession: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  patientNameAr: string | null;
  patientNameEn: string | null;
  invoiceSubtotal: number | null;
  invoiceNet: number | null;
  /** The discount the approval would apply, in money. */
  effectiveAmount: number | null;
};
export type FinanceExpense = {
  id: string;
  categoryId: string;
  categoryNameAr: string;
  categoryNameEn: string;
  amount: number;
  currency: string;
  paidAt: string;
  note: string | null;
  cashSessionId: string | null;
  sessionClosed: boolean;
  createdByNameAr: string | null;
  createdByNameEn: string | null;
};
export type FinanceExpenseList = { items: FinanceExpense[]; total: number; sum: number; byCategory: Array<{ categoryId: string; nameAr: string; nameEn: string; amount: number }> };
export type FinanceExpenseCategory = { id: string; nameAr: string; nameEn: string; useCount: number };
export type FinanceSummary = {
  from: string;
  to: string;
  billed: number;
  discounts: number;
  net: number;
  collected: number;
  refunds: number;
  outstanding: number;
  insurerReceivables: number;
  expenses: number;
  netCash: number;
  invoices: number;
  byMethod: FinanceMethodTotal[];
  byDay: Array<{ date: string; net: number; collected: number; expenses: number }>;
};

/* ================================================================== analytics */

export type AdminDayPoint = { date: string };
export type AnalyticsTatStats = { count: number; median: number | null; p90: number | null; onTimePct: number | null };
export type AnalyticsDashboard = {
  from: string;
  to: string;
  kpis: { patients: number; newPatients: number; orders: number; tests: number };
  money: { revenue: number; billed: number; discounts: number; collected: number; outstanding: number; insurer: number } | null;
  wip: { toCollect: number; toReceive: number; inAnalysis: number; toVerify: number; toValidate: number; toRelease: number; toDeliver: number };
  criticals: {
    count: number;
    items: Array<{ resultId: string; orderId: string; accession: string; patientNameAr: string; patientNameEn: string | null; analyteCode: string; analyteNameAr: string; analyteNameEn: string; value: string; unit: string | null; flag: string | null; at: string }>;
  };
  rejections: { count: number; byReason: Array<{ reasonId: string | null; nameAr: string | null; nameEn: string | null; count: number }> };
  tat: AnalyticsTatStats & { byDepartment: Array<AnalyticsTatStats & { departmentId: string; code: string; nameAr: string; nameEn: string }> };
  overdue: {
    count: number;
    items: Array<{ itemId: string; orderId: string; accession: string; priority: string; patientNameAr: string; patientNameEn: string | null; testCode: string; testNameAr: string; testNameEn: string; status: string; dueAt: string; overdueMinutes: number }>;
  };
  ordersByHour: Array<{ hour: number; orders: number }>;
  testsByDepartment: Array<{ departmentId: string; code: string; nameAr: string; nameEn: string; tests: number }>;
  topTests: Array<{ testId: string; code: string; nameAr: string; nameEn: string; count: number }>;
  payerMix: Array<{ payerGroupId: string; code: string; nameAr: string; nameEn: string; kind: string; orders: number; net: number | null }>;
  instruments: { counts: Record<string, number>; items: Array<{ id: string; code: string; name: string; status: string; lastMessageAt: string | null }> };
  revenueDays: Array<{ date: string; net: number; collected: number }> | null;
};

export type AnalyticsTat = {
  overall: AnalyticsTatStats & { mean: number | null };
  phases: { collectToReceive: number | null; receiveToResult: number | null; resultToValidate: number | null };
  byDepartment: Array<AnalyticsTatStats & { departmentId: string; code: string; nameAr: string; nameEn: string }>;
  byTest: Array<AnalyticsTatStats & { testId: string; code: string; nameAr: string; nameEn: string; tatHours: number }>;
  byDay: Array<AdminDayPoint & { count: number; median: number | null; p90: number | null }>;
  histogram: Array<{ bucket: string; count: number }>;
};
export type AnalyticsVolume = {
  totals: { orders: number; tests: number; patients: number; newPatients: number; samples: number };
  byDay: Array<AdminDayPoint & { orders: number; tests: number; patients: number }>;
  byHour: Array<{ hour: number; orders: number }>;
  byWeekday: Array<{ weekday: number; orders: number }>;
  byDepartment: Array<{ departmentId: string; code: string; nameAr: string; nameEn: string; tests: number }>;
  byTest: Array<{ testId: string; code: string; nameAr: string; nameEn: string; count: number }>;
  bySource: Array<{ source: string; orders: number }>;
  byPriority: Array<{ priority: string; orders: number }>;
};
export type AnalyticsRevenue = {
  totals: { billed: number; discounts: number; net: number; patientShare: number; insurerShare: number; collected: number; refunds: number; outstanding: number };
  byDay: Array<AdminDayPoint & { net: number; collected: number }>;
  byPayer: Array<{ payerGroupId: string; code: string; nameAr: string; nameEn: string; kind: string; invoices: number; net: number; patient: number; insurer: number; paid: number; outstanding: number }>;
  byDepartment: Array<{ departmentId: string; code: string; nameAr: string; nameEn: string; net: number; tests: number }>;
  byMethod: FinanceMethodTotal[];
  topTests: Array<{ testId: string; code: string; nameAr: string; nameEn: string; count: number; net: number }>;
};
export type AnalyticsProductivity = {
  users: Array<{
    userId: string | null;
    nameAr: string | null;
    nameEn: string | null;
    entered: number;
    verified: number;
    validated: number;
    ordersCreated: number;
    samplesCollected: number;
    samplesReceived: number;
  }>;
};
export type AnalyticsRejections = {
  totals: { evaluated: number; rejected: number; ratePct: number | null };
  byReason: Array<{ reasonId: string | null; code: string | null; nameAr: string | null; nameEn: string | null; count: number }>;
  byDepartment: Array<{ departmentId: string | null; nameAr: string | null; nameEn: string | null; count: number }>;
  byCollector: Array<{ userId: string | null; nameAr: string | null; nameEn: string | null; count: number }>;
  byDay: Array<AdminDayPoint & { rejected: number }>;
  recent: Array<{ sampleId: string; barcode: string; orderId: string; accession: string; patientNameAr: string; patientNameEn: string | null; reasonNameAr: string | null; reasonNameEn: string | null; note: string | null; rejectedAt: string; rejectedByNameAr: string | null; rejectedByNameEn: string | null }>;
};
export type AnalyticsInstruments = {
  counts: Record<string, number>;
  items: Array<{
    id: string;
    code: string;
    name: string;
    model: string;
    status: string;
    integrationLevel: string;
    isSimulated: boolean;
    isActive: boolean;
    lastMessageAt: string | null;
    messages: number;
    errors: number;
    unmatched: number;
    results: number;
    qcRuns: number;
    qcWarnings: number;
    qcRejected: number;
    lastMaintenanceAt: string | null;
  }>;
};
export type AnalyticsDoctors = { items: DoctorReferral[]; totals: { orders: number; patients: number; tests: number; revenue: number | null }; walkIn: DoctorReferral };

export const ANALYTICS_REPORTS = ['tat', 'volume', 'revenue', 'productivity', 'rejections', 'instruments', 'doctors'] as const;
export type AnalyticsReport = (typeof ANALYTICS_REPORTS)[number];

/* ================================================================== audit & outbox */

export const adminAuditQuery = adminListQuery.extend({
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  userId: uuid.optional(),
  action: z.string().max(80).optional(),
});
export type AuditLogRow = {
  id: string;
  seq: number;
  at: string;
  userId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
};
export type AuditLogFacets = { entityTypes: string[]; actions: string[]; users: Array<{ id: string; fullNameAr: string; fullNameEn: string }> };
export type AuditChainCheck = {
  ok: boolean;
  checked: number;
  verifiedAt: string;
  lastSeq: number | null;
  broken: { id: string; seq: number; at: string; action: string; reason: 'hash_mismatch' | 'chain_break' } | null;
};

export const adminOutboxQuery = adminListQuery.extend({
  channel: z.enum(['sms', 'email', 'whatsapp']).optional(),
  status: z.enum(['pending', 'simulated', 'sent', 'failed']).optional(),
});
export type OutboxMessage = {
  id: string;
  channel: 'sms' | 'email' | 'whatsapp';
  toAddress: string;
  subject: string | null;
  body: string;
  status: 'pending' | 'simulated' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  provider: string | null;
  orderId: string | null;
  accession: string | null;
  createdAt: string;
  sentAt: string | null;
};
export type OutboxList = { items: OutboxMessage[]; total: number; counts: Record<string, number>; providerConfigured: boolean };

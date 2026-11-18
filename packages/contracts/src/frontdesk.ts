/**
 * Front desk: patients, orders and desk billing. Zod schemas validate requests on the server
 * (and can validate forms in the browser); the types describe what the API returns.
 * Timestamps travel as ISO strings, money as numbers in the lab currency.
 */
import { z } from 'zod';
import { isoDate, pageQuery, uuid } from './common';

/* ================================================================== enums */

export const SEXES = ['male', 'female'] as const;
export const CONTACT_PREFS = ['whatsapp', 'sms', 'call', 'none'] as const;
export const AGE_UNITS = ['years', 'months', 'days'] as const;
export const ORDER_SOURCES = ['walk_in', 'referral', 'client_lab', 'home'] as const;
export const PRIORITIES = ['routine', 'urgent', 'stat'] as const;
export const DELIVERY_CHANNELS = ['print', 'whatsapp', 'sms', 'email'] as const;
export const ORDER_STATUSES = ['registered', 'collected', 'in_progress', 'partial', 'completed', 'delivered', 'cancelled'] as const;
export const ATTACHMENT_KINDS = ['referral', 'id', 'previous_result', 'other'] as const;

export type Sex = (typeof SEXES)[number];
export type ContactPref = (typeof CONTACT_PREFS)[number];
export type AgeUnit = (typeof AGE_UNITS)[number];
export type OrderSource = (typeof ORDER_SOURCES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export type InvoiceStatusValue = 'open' | 'partial' | 'paid' | 'void';

/* ================================================================== helpers */

const text = (max: number) => z.string().trim().max(max);
/** Optional free text: blank becomes null (clears the field); undefined means "not sent". */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish();
const optEmail = z
  .union([z.literal(''), z.string().trim().max(120).email()])
  .nullish()
  .transform((v) => (v === '' ? null : v));
const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/* ================================================================== patients */

export const ageInput = z
  .object({ value: z.number().int().min(0).max(150), unit: z.enum(AGE_UNITS) })
  .refine((a) => (a.unit === 'years' ? a.value <= 130 : a.unit === 'months' ? a.value <= 36 * 12 : a.value <= 3 * 365), {
    message: 'age_out_of_range',
    path: ['value'],
  });

const patientFields = {
  firstNameAr: text(60).min(1),
  fatherNameAr: optText(60),
  motherNameAr: optText(60),
  lastNameAr: text(60).min(1),
  firstNameEn: optText(60),
  lastNameEn: optText(60),
  sex: z.enum(SEXES),
  /** Exact birth date, or… */
  birthDate: isoDate.nullish(),
  /** …an age entered at the desk; the birth date is then estimated. */
  age: ageInput.nullish(),
  phone: optText(30),
  contactPref: z.enum(CONTACT_PREFS),
  email: optEmail,
  nationalId: optText(30),
  address: optText(300),
  /** Relevant medical history and clinical notes. */
  notes: optText(2000),
};

export const patientCreateInput = z
  .object({ ...patientFields, contactPref: z.enum(CONTACT_PREFS).default('whatsapp') })
  .refine((p) => !!p.birthDate || !!p.age, { message: 'birth_date_or_age', path: ['birthDate'] });
export type PatientCreateInput = z.input<typeof patientCreateInput>;

export const patientUpdateInput = z.object(patientFields).partial();
export type PatientUpdateInput = z.input<typeof patientUpdateInput>;

export const patientListQuery = pageQuery.extend({
  q: optText(80),
  sex: z.enum(SEXES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const duplicateCheckInput = z.object({
  firstNameAr: text(60).min(1),
  fatherNameAr: optText(60),
  lastNameAr: optText(60),
  sex: z.enum(SEXES).nullish(),
  birthDate: isoDate.nullish(),
  age: ageInput.nullish(),
  phone: optText(30),
  /** Leave this record out (when checking an existing patient). */
  excludeId: uuid.nullish(),
});
export type DuplicateCheckInput = z.input<typeof duplicateCheckInput>;

export const mergeInput = z.object({
  /** Record that disappears; its orders and attachments move to the target. */
  sourceId: uuid,
  /** Record that stays. */
  targetId: uuid,
  reason: text(500).min(3),
  /** Merge even when sex differs or birth dates are more than two years apart. */
  force: z.boolean().default(false),
});
export type MergeInput = z.input<typeof mergeInput>;

export const attachmentQuery = z.object({
  kind: z.enum(ATTACHMENT_KINDS).default('other'),
  orderId: uuid.optional(),
});

export type PatientSummary = {
  id: string;
  mrn: string;
  fullNameAr: string;
  fullNameEn: string | null;
  sex: Sex;
  birthDate: string;
  birthDateEstimated: boolean;
  phone: string | null;
};

export type PatientListItem = PatientSummary & {
  contactPref: ContactPref;
  createdAt: string;
  lastVisitAt: string | null;
  orderCount: number;
};

export type PatientDetail = PatientSummary & {
  firstNameAr: string;
  fatherNameAr: string | null;
  motherNameAr: string | null;
  lastNameAr: string;
  firstNameEn: string | null;
  lastNameEn: string | null;
  contactPref: ContactPref;
  email: string | null;
  nationalId: string | null;
  address: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; fullNameAr: string; fullNameEn: string } | null;
  /** Set when this record was merged into another one. */
  mergedInto: PatientSummary | null;
  orderCount: number;
  lastVisitAt: string | null;
  attachmentCount: number;
};

export type DuplicateCandidate = PatientSummary & {
  score: number;
  /** name | birth | phone */
  reasons: string[];
  lastVisitAt: string | null;
};

export type MergeResult = { targetId: string; movedOrders: number; movedAttachments: number; filledFields: string[] };

export type AttachmentRow = {
  id: string;
  patientId: string;
  orderId: string | null;
  kind: AttachmentKind;
  fileName: string;
  mime: string;
  size: number;
  createdAt: string;
  uploadedBy: { fullNameAr: string; fullNameEn: string } | null;
};

export type TrendPoint = {
  orderId: string;
  accession: string;
  at: string;
  value: number;
  flag: string | null;
  isCritical: boolean;
  status: string;
};

export type AnalyteTrend = {
  analyteId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unit: string | null;
  decimals: number;
  refLow: number | null;
  refHigh: number | null;
  /** Oldest first. */
  points: TrendPoint[];
};

export type PatientHistory = { orders: OrderListItem[]; analytes: AnalyteTrend[] };

/* ================================================================== orders: input */

export const orderItemInput = z.union([z.object({ testId: uuid }).strict(), z.object({ packageId: uuid }).strict()]);
export type OrderItemInput = z.input<typeof orderItemInput>;

const discountFields = {
  amount: z.number().positive().optional(),
  percent: z.number().positive().max(100).optional(),
};
const oneOfAmountOrPercent = (d: { amount?: number; percent?: number }) => (d.amount !== undefined) !== (d.percent !== undefined);

/** A manual discount ("حسم"): an amount or a percentage, with the reason. */
export const discountInput = z
  .object({ ...discountFields, reason: text(300).min(3) })
  .refine(oneOfAmountOrPercent, { message: 'amount_or_percent', path: ['amount'] });
export type DiscountInput = z.input<typeof discountInput>;

/** In a quote the reason may still be missing. */
export const discountQuoteInput = z
  .object({ ...discountFields, reason: optText(300) })
  .refine(oneOfAmountOrPercent, { message: 'amount_or_percent', path: ['amount'] });

export const paymentNowInput = z.object({
  amount: z.number().positive(),
  methodId: uuid,
  reference: optText(120),
  /** Random per attempt; a retry with the same key never charges twice. */
  idempotencyKey: text(80).min(8),
});

export const orderQuoteInput = z.object({
  payerGroupId: uuid,
  items: z.array(orderItemInput).max(100),
  discount: discountQuoteInput.nullish(),
});
export type OrderQuoteInput = z.input<typeof orderQuoteInput>;

export const orderCreateInput = z.object({
  patientId: uuid,
  payerGroupId: uuid,
  doctorId: uuid.nullish(),
  referralClinic: optText(120),
  source: z.enum(ORDER_SOURCES).default('walk_in'),
  externalRef: optText(60),
  priority: z.enum(PRIORITIES).default('routine'),
  clinicalInfo: optText(2000),
  notes: optText(2000),
  fasting: z.boolean().default(false),
  pregnant: z.boolean().default(false),
  deliveryChannel: z.enum(DELIVERY_CHANNELS).default('print'),
  branchId: uuid.nullish(),
  items: z.array(orderItemInput).min(1).max(100),
  discount: discountInput.nullish(),
  payment: paymentNowInput.nullish(),
});
export type OrderCreateInput = z.input<typeof orderCreateInput>;

export const orderListQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  source: z.enum(ORDER_SOURCES).optional(),
  payerGroupId: uuid.optional(),
  doctorId: uuid.optional(),
  patientId: uuid.optional(),
  /** Order number (prefix), patient name, MRN or phone. */
  q: optText(80),
  /** Only orders with something left to pay. */
  unpaid: flag.optional(),
});

export const orderUpdateInput = z.object({
  /** The version the user saw; a newer version on the server means someone else changed it. */
  version: z.number().int().min(1),
  doctorId: uuid.nullish(),
  referralClinic: optText(120),
  priority: z.enum(PRIORITIES).optional(),
  clinicalInfo: optText(2000),
  notes: optText(2000),
  deliveryChannel: z.enum(DELIVERY_CHANNELS).optional(),
  fasting: z.boolean().optional(),
  pregnant: z.boolean().optional(),
  externalRef: optText(60),
});
export type OrderUpdateInput = z.input<typeof orderUpdateInput>;

export const addItemsInput = z.object({ items: z.array(orderItemInput).min(1).max(50) });
export const reasonInput = z.object({ reason: text(500).min(3) });
export const labelsPrintedInput = z.object({ sampleIds: z.array(uuid).max(50).optional() });

/* ================================================================== orders: output */

export type FormTest = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  departmentId: string;
  sampleTypeId: string;
  sampleTypeCode: string;
  sampleTypeNameAr: string;
  sampleTypeNameEn: string;
  containerId: string;
  containerCode: string;
  containerNameAr: string;
  containerNameEn: string;
  capColor: string;
  units: number;
  fixedPrice: number | null;
  isFavorite: boolean;
  tatHours: number;
  separateTube: boolean;
  isExternal: boolean;
  analyteCodes: string[];
};

export type FormPackage = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  priceMode: 'sum' | 'units' | 'fixed';
  units: number | null;
  fixedPrice: number | null;
  testIds: string[];
};

export type FormPayer = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: 'public' | 'insurer' | 'client_lab' | 'other';
  unitPrice: number;
  patientSharePct: number;
  discountPct: number;
  onAccount: boolean;
  organization: string | null;
};

export type OrderFormData = {
  currency: string;
  tests: FormTest[];
  packages: FormPackage[];
  departments: Array<{ id: string; code: string; nameAr: string; nameEn: string }>;
  payerGroups: FormPayer[];
  defaultPayerGroupId: string | null;
  priceOverrides: Array<{ payerGroupId: string; testId: string; price: number }>;
  doctors: Array<{ id: string; nameAr: string; nameEn: string | null; specialtyAr: string | null; specialtyEn: string | null; clinic: string | null; phone: string | null }>;
  paymentMethods: Array<{ id: string; code: string; nameAr: string; nameEn: string; isCash: boolean }>;
  branches: Array<{ id: string; code: string; nameAr: string; nameEn: string; isMain: boolean }>;
  /** The signed-in user's open cash session (needed to take cash). */
  cashSession: { id: string; openedAt: string } | null;
};

export type QuoteLine = {
  key: string;
  testId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  packageId: string | null;
  packageCode: string | null;
  units: number;
  unitPrice: number;
  /** Price before any discount (after spreading a package price over its tests). */
  price: number;
  discount: number;
  net: number;
  patientShare: number;
  insurerShare: number;
  containerId: string;
  capColor: string;
  sampleTypeId: string;
  departmentId: string;
  isExternal: boolean;
  tubeSeq: number;
};

export type QuoteTube = {
  seq: number;
  containerId: string;
  containerCode: string;
  containerNameAr: string;
  containerNameEn: string;
  capColor: string;
  sampleTypeId: string;
  sampleTypeNameAr: string;
  sampleTypeNameEn: string;
  testCodes: string[];
};

export type QuoteWarning =
  /** The test was already in the order (alone or in a package); it is done once. */
  | { kind: 'duplicate_test'; testId: string; code: string }
  /** Every test of the package was already in the order, so the package was left out. */
  | { kind: 'package_covered'; packageId: string; code: string }
  /** Two tests measure the same analyte. */
  | { kind: 'analyte_overlap'; analyteCode: string; testCodes: string[] };

export type QuoteTotals = {
  subtotal: number;
  discountTotal: number;
  net: number;
  insurerTotal: number;
  patientTotal: number;
};

export type OrderQuote = {
  payerGroupId: string;
  currency: string;
  lines: QuoteLine[];
  packages: Array<{ packageId: string; code: string; nameAr: string; nameEn: string; priceMode: string; price: number }>;
  tubes: QuoteTube[];
  totals: QuoteTotals;
  /** Manual discount: applied at once for users who can approve discounts, otherwise sent for approval. */
  discount: { requested: number; applied: boolean; needsApproval: boolean } | null;
  warnings: QuoteWarning[];
};

export type OrderCreated = {
  id: string;
  accession: string;
  dailyNo: number;
  portalCode: string;
  status: OrderStatusValue;
  tubes: number;
  invoice: { id: string; number: string; patientTotal: number; insurerTotal: number; paidTotal: number; balance: number; status: InvoiceStatusValue };
  approvalId: string | null;
  payment: { id: string; amount: number } | null;
  warnings: QuoteWarning[];
};

export type OrderListItem = {
  id: string;
  accession: string;
  dailyNo: number;
  createdAt: string;
  status: OrderStatusValue;
  priority: Priority;
  source: OrderSource;
  patient: PatientSummary;
  payer: { id: string; code: string; nameAr: string; nameEn: string; kind: string };
  doctor: { id: string; nameAr: string; nameEn: string | null } | null;
  testCodes: string[];
  testCount: number;
  releasedCount: number;
  patientTotal: number;
  paidTotal: number;
  balance: number;
  invoiceStatus: InvoiceStatusValue | null;
  hasCritical: boolean;
};

export type ResultCounts = { total: number; pending: number; resulted: number; verified: number; validated: number; released: number; critical: number };

export type OrderItemRow = {
  id: string;
  testId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  departmentId: string;
  departmentNameAr: string;
  departmentNameEn: string;
  packageId: string | null;
  packageCode: string | null;
  packageNameAr: string | null;
  packageNameEn: string | null;
  sampleId: string | null;
  barcode: string | null;
  capColor: string | null;
  status: string;
  units: number;
  unitPrice: number;
  price: number;
  discount: number;
  isExternal: boolean;
  tatHours: number;
  /** When the result is expected (order time + turnaround). */
  dueAt: string;
  cancelledAt: string | null;
  resultCounts: ResultCounts;
};

export type OrderTube = {
  id: string;
  barcode: string;
  seq: number;
  status: string;
  containerId: string;
  containerCode: string;
  containerNameAr: string;
  containerNameEn: string;
  capColor: string;
  sampleTypeCode: string;
  sampleTypeNameAr: string;
  sampleTypeNameEn: string;
  testCodes: string[];
  collectedAt: string | null;
  receivedAt: string | null;
  labelPrintedAt: string | null;
};

export type InvoiceLineRow = {
  id: string;
  orderItemId: string | null;
  testId: string | null;
  code: string | null;
  nameAr: string | null;
  nameEn: string | null;
  packageCode: string | null;
  description: string;
  units: number;
  unitPrice: number;
  price: number;
  discount: number;
  insurerShare: number;
  patientShare: number;
};

export type PaymentRow = {
  id: string;
  kind: 'payment' | 'refund';
  amount: number;
  currency: string;
  methodId: string;
  methodCode: string;
  methodNameAr: string;
  methodNameEn: string;
  isCash: boolean;
  reference: string | null;
  receivedAt: string;
  receivedBy: { fullNameAr: string; fullNameEn: string } | null;
};

export type ApprovalRow = {
  id: string;
  kind: string;
  amount: number | null;
  percent: number | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  requestedBy: { fullNameAr: string; fullNameEn: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

export type InvoiceDetail = {
  id: string;
  number: string;
  orderId: string;
  accession: string;
  status: InvoiceStatusValue;
  currency: string;
  subtotal: number;
  discountTotal: number;
  insurerTotal: number;
  patientTotal: number;
  paidTotal: number;
  balance: number;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  payer: { id: string; code: string; nameAr: string; nameEn: string; kind: string; patientSharePct: number; onAccount: boolean };
  patient: PatientSummary;
  lines: InvoiceLineRow[];
  payments: PaymentRow[];
  approvals: ApprovalRow[];
};

export type OrderDetail = {
  id: string;
  accession: string;
  dailyNo: number;
  status: OrderStatusValue;
  priority: Priority;
  source: OrderSource;
  externalRef: string | null;
  referralClinic: string | null;
  clinicalInfo: string | null;
  notes: string | null;
  fasting: boolean;
  pregnant: boolean;
  deliveryChannel: DeliveryChannel;
  portalCode: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  patient: PatientSummary & { contactPref: ContactPref; notes: string | null };
  payer: { id: string; code: string; nameAr: string; nameEn: string; kind: string; patientSharePct: number; onAccount: boolean };
  doctor: { id: string; nameAr: string; nameEn: string | null; clinic: string | null; phone: string | null } | null;
  branch: { id: string; nameAr: string; nameEn: string } | null;
  createdBy: { id: string; fullNameAr: string; fullNameEn: string } | null;
  cancelledBy: { id: string; fullNameAr: string; fullNameEn: string } | null;
  items: OrderItemRow[];
  tubes: OrderTube[];
  resultCounts: ResultCounts;
  invoice: InvoiceDetail | null;
  latestReport: { id: string; version: number; status: string; releasedAt: string; verifyCode: string } | null;
  /** Nothing validated yet, so the order can still be cancelled. */
  cancellable: boolean;
};

export type ItemsChanged = {
  orderId: string;
  added: number;
  newTubes: number;
  warnings: QuoteWarning[];
  invoice: { patientTotal: number; paidTotal: number; balance: number; status: InvoiceStatusValue } | null;
};

export type CancelResult = { orderId: string; status: 'cancelled'; invoiceVoided: boolean; refundDue: number };

export type ActivityEntry = {
  id: string;
  at: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
};

export type OrderLabels = {
  order: { id: string; accession: string; dailyNo: number; createdAt: string; priority: Priority; status: OrderStatusValue };
  patient: { fullNameAr: string; fullNameEn: string | null; shortNameAr: string; shortNameEn: string | null; sex: Sex; birthDate: string };
  labels: Array<{
    sampleId: string;
    barcode: string;
    seq: number;
    status: string;
    containerCode: string;
    containerNameAr: string;
    containerNameEn: string;
    capColor: string;
    sampleTypeCode: string;
    testCodes: string[];
    labelPrintedAt: string | null;
  }>;
};

export type OrderReceipt = {
  lab: {
    code: string;
    nameAr: string;
    nameEn: string;
    phone: string | null;
    addressAr: string | null;
    addressEn: string | null;
    logoSvg: string | null;
    currency: string;
  };
  order: { id: string; accession: string; dailyNo: number; createdAt: string; portalCode: string; status: OrderStatusValue };
  patient: PatientSummary;
  doctor: { nameAr: string; nameEn: string | null } | null;
  invoice: InvoiceDetail | null;
};

/* ================================================================== billing */

export const paymentInput = z.object({
  invoiceId: uuid,
  amount: z.number().positive(),
  methodId: uuid,
  reference: optText(120),
  idempotencyKey: text(80).min(8),
});
export type PaymentInput = z.input<typeof paymentInput>;

export type PaymentResult = {
  payment: PaymentRow;
  invoice: { id: string; patientTotal: number; paidTotal: number; balance: number; status: InvoiceStatusValue };
  /** True when the idempotency key had been used: the original payment is returned, nothing is charged. */
  duplicate: boolean;
};

export type DiscountResult = {
  applied: boolean;
  approvalId: string | null;
  amount: number;
  invoice: { id: string; patientTotal: number; paidTotal: number; balance: number; status: InvoiceStatusValue };
};

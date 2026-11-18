/**
 * Shared request/response shapes for the laboratory side: samples, worklists, results,
 * reports, delivery and the public patient portal. Dates travel as ISO strings.
 */
import { z } from 'zod';

const id = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');
/** Accepts `a,b` or repeated query keys. */
function csv<T extends string>(values: readonly [T, ...T[]]) {
  return z.preprocess(
    (v) =>
      v === undefined || v === null || v === ''
        ? undefined
        : (Array.isArray(v) ? v : String(v).split(','))
            .map((s) => String(s).trim())
            .filter(Boolean),
    z.array(z.enum(values)).optional(),
  );
}

/* ================================================================== shared */

export const BENCH_SAMPLE_STATUSES = ['pending', 'collected', 'in_transit', 'received', 'rejected', 'in_analysis', 'stored', 'disposed'] as const;
export type BenchSampleStatus = (typeof BENCH_SAMPLE_STATUSES)[number];
export type BenchResultStatus = 'pending' | 'resulted' | 'verified' | 'validated' | 'released';
export type BenchItemStatus =
  | 'ordered'
  | 'collected'
  | 'received'
  | 'in_analysis'
  | 'resulted'
  | 'verified'
  | 'validated'
  | 'released'
  | 'rejected'
  | 'cancelled';
export type BenchFlag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';
export type BenchPriority = 'routine' | 'urgent' | 'stat';
export type BenchDeliveryChannel = 'print' | 'whatsapp' | 'sms' | 'email' | 'portal';
export type ReportLanguage = 'ar' | 'en' | 'bilingual';

export type BenchRef = { id: string; code: string; nameAr: string; nameEn: string };
export type BenchContainer = BenchRef & { capColor: string };
export type BenchUserRef = { id: string; fullNameAr: string; fullNameEn: string; title: string | null };
export type BenchPatient = {
  id: string;
  mrn: string;
  fullNameAr: string;
  fullNameEn: string | null;
  sex: 'male' | 'female';
  birthDate: string;
  phone: string | null;
};
export type BenchOrderRef = {
  id: string;
  accession: string;
  dailyNo: number;
  priority: BenchPriority;
  status: string;
  createdAt: string;
  fasting: boolean;
  pregnant: boolean;
  clinicalInfo: string | null;
  notes: string | null;
};

/* ================================================================== samples */

export type BenchMeta = {
  departments: Array<BenchRef & { sortOrder: number }>;
  containers: BenchContainer[];
  sampleTypes: BenchRef[];
  rejectionReasons: BenchRef[];
  instruments: Array<{ id: string; code: string; name: string; departmentId: string | null; status: string }>;
  /** Departments the signed-in user may work in; empty means every department. */
  myDepartmentIds: string[];
  settings: { requireCollectionStep: boolean; segregationOfDuties: boolean; reportLanguage: ReportLanguage };
};

export const benchSampleListQuery = z.object({
  /** `collection`: orders with tubes still to collect, grouped by order. */
  view: z.enum(['list', 'collection']).default('list'),
  status: csv(BENCH_SAMPLE_STATUSES),
  departmentId: id.optional(),
  orderId: id.optional(),
  from: day.optional(),
  to: day.optional(),
  /** Which time the date range applies to. */
  dateBy: z.enum(['created', 'collected', 'received', 'rejected', 'stored']).default('created'),
  sort: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().max(80).optional(),
  /** Include each tube's event timeline. */
  events: boolish.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type BenchSampleListQuery = z.input<typeof benchSampleListQuery>;

export type BenchSampleTest = { orderItemId: string; testId: string; code: string; nameAr: string; nameEn: string; status: BenchItemStatus; departmentId: string };
export type BenchSampleEvent = {
  id: string;
  type: string;
  at: string;
  user: BenchUserRef | null;
  fromLocation: string | null;
  toLocation: string | null;
  note: string | null;
};
export type BenchSample = {
  id: string;
  barcode: string;
  seq: number;
  status: BenchSampleStatus;
  order: BenchOrderRef;
  patient: BenchPatient;
  container: BenchContainer;
  sampleType: BenchRef;
  department: BenchRef | null;
  tests: BenchSampleTest[];
  collectedAt: string | null;
  collectedBy: BenchUserRef | null;
  receivedAt: string | null;
  receivedBy: BenchUserRef | null;
  rejectedAt: string | null;
  rejectionReason: BenchRef | null;
  rejectionNote: string | null;
  storedAt: string | null;
  disposedAt: string | null;
  storageLocation: string | null;
  recollectOfId: string | null;
  /** The replacement tube when this one was rejected and recollected. */
  recollectedAs: { id: string; barcode: string } | null;
  labelPrintedAt: string | null;
  createdAt: string;
  events?: BenchSampleEvent[];
};

export type CollectionQueueOrder = {
  order: BenchOrderRef;
  patient: BenchPatient;
  tubes: BenchSample[];
  pendingCount: number;
  totalCount: number;
};
export type CollectionQueue = { items: CollectionQueueOrder[]; total: number };

export const benchCollectInput = z
  .object({
    sampleIds: z.array(id).max(200).optional(),
    barcodes: z.array(z.string().trim().min(1).max(40)).max(200).optional(),
  })
  .refine((v) => (v.sampleIds?.length ?? 0) + (v.barcodes?.length ?? 0) > 0, { message: 'Give sampleIds or barcodes' });
export type BenchCollectOutcome = 'collected' | 'already_collected' | 'not_found' | 'rejected' | 'order_cancelled';
export type BenchCollectResult = { items: Array<{ key: string; outcome: BenchCollectOutcome; sample: BenchSample | null }> };

export const benchReceiveInput = z.object({ barcodes: z.array(z.string().trim().min(1).max(40)).min(1).max(200) });
export type BenchReceiveOutcome = 'received' | 'already_received' | 'not_found' | 'rejected' | 'not_collected' | 'order_cancelled';
export type BenchReceiveResult = { items: Array<{ barcode: string; outcome: BenchReceiveOutcome; sample: BenchSample | null }> };

export const benchRejectInput = z.object({
  reasonId: id,
  note: z.string().trim().max(500).nullable().optional(),
  recollect: z.boolean().default(false),
});
export type BenchRejectResult = { sample: BenchSample; recollect: BenchSample | null };

export const benchTransferInput = z.object({ toLocation: z.string().trim().min(1).max(120), note: z.string().trim().max(500).nullable().optional() });
export const benchStoreInput = z.object({ location: z.string().trim().min(1).max(120), note: z.string().trim().max(500).nullable().optional() });
export const benchDisposeInput = z.object({ note: z.string().trim().max(500).nullable().optional() });

/* ================================================================== results */

export type BenchResultSource = 'manual' | 'instrument' | 'calculated';
export type BenchResult = {
  id: string;
  orderId: string;
  orderItemId: string;
  analyte: { id: string; code: string; nameAr: string; nameEn: string; unit: string | null; resultType: 'numeric' | 'text' | 'option' | 'calculated'; decimals: number; options: string[] };
  test: { id: string; code: string; nameAr: string; nameEn: string; departmentId: string };
  status: BenchResultStatus;
  /** Value as printed (rounded to the analyte's decimals, qualifiers kept). */
  value: string | null;
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
  flag: BenchFlag | null;
  isCritical: boolean;
  deltaFlag: boolean;
  refText: string | null;
  refLow: number | null;
  refHigh: number | null;
  /** The patient's previous validated value for the same analyte. */
  previous: { value: string | null; at: string; flag: BenchFlag | null } | null;
  comment: string | null;
  source: BenchResultSource | null;
  instrument: { id: string; code: string; name: string } | null;
  attempts: number;
  /** Sent back for a rerun and waiting for a new value. */
  rerunRequested: boolean;
  enteredAt: string | null;
  enteredBy: BenchUserRef | null;
  verifiedAt: string | null;
  verifiedBy: BenchUserRef | null;
  validatedAt: string | null;
  validatedBy: BenchUserRef | null;
  releasedAt: string | null;
  amended: boolean;
  version: number;
  criticalCalled: boolean;
};

const resultValue = z.union([z.string().trim().max(200), z.number().finite()]).nullable();
export const benchEnterResultInput = z.object({
  /** Omit to change only the comment; null or "" clears the value. */
  value: resultValue.optional(),
  comment: z.string().trim().max(1000).nullable().optional(),
  dilution: z.number().positive().max(1_000_000).nullable().optional(),
});
export const benchResultBatchInput = z.object({ entries: z.array(benchEnterResultInput.extend({ resultId: id })).min(1).max(500) });
export type BenchResultEntry = z.infer<typeof benchResultBatchInput>['entries'][number];
export const benchResultIdsInput = z.object({ resultIds: z.array(id).min(1).max(500) });
export const benchValidateInput = benchResultIdsInput.extend({ password: z.string().min(1).max(200) });
export const benchRerunInput = z.object({ reason: z.string().trim().min(2).max(500) });
export const benchCriticalCallInput = z.object({
  recipientName: z.string().trim().min(2).max(120),
  recipientRole: z.enum(['doctor', 'patient', 'nurse', 'other']),
  phone: z.string().trim().max(40).nullable().optional(),
  readBack: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});
export const benchAmendInput = z.object({
  value: z.union([z.string().trim().min(1).max(200), z.number().finite()]),
  reason: z.string().trim().min(3).max(500),
  password: z.string().min(1).max(200),
});

export type BenchVerifyResult = { done: string[]; skipped: Array<{ id: string; status: BenchResultStatus }> };
export type BenchCriticalCall = {
  id: string;
  resultId: string;
  calledAt: string;
  calledBy: BenchUserRef | null;
  recipientName: string;
  recipientRole: 'doctor' | 'patient' | 'nurse' | 'other';
  phone: string | null;
  readBack: boolean;
  note: string | null;
};

export type BenchResultHistory = {
  result: BenchResult;
  attempts: Array<{
    id: string;
    source: BenchResultSource;
    value: string | null;
    unit: string | null;
    rawFlag: string | null;
    instrument: { id: string; code: string; name: string } | null;
    dilution: number | null;
    isRerun: boolean;
    measuredAt: string | null;
    enteredBy: BenchUserRef | null;
    note: string | null;
    createdAt: string;
    selected: boolean;
  }>;
  versions: Array<{ id: string; version: number; value: string | null; flag: string | null; status: string; reason: string | null; changedBy: BenchUserRef | null; changedAt: string }>;
  audit: Array<{ id: string; action: string; summary: string | null; actorName: string | null; at: string }>;
  criticalCalls: BenchCriticalCall[];
};

export type BenchResultCounts = { pending: number; resulted: number; verified: number; validated: number; released: number; total: number };

export type BenchOrderResults = {
  order: BenchOrderRef;
  patient: BenchPatient;
  doctor: { nameAr: string; nameEn: string | null } | null;
  sections: Array<{
    department: BenchRef;
    items: Array<{
      orderItemId: string;
      test: { id: string; code: string; nameAr: string; nameEn: string };
      status: BenchItemStatus;
      sample: { id: string; barcode: string; status: BenchSampleStatus } | null;
      results: BenchResult[];
    }>;
  }>;
  criticalCalls: BenchCriticalCall[];
  summary: BenchResultCounts & { criticalUncalled: number };
};

/* ================================================================== worklists */

export const worklistQuery = z.object({
  departmentId: id.optional(),
  instrumentId: id.optional(),
  status: z.enum(['pending', 'to_verify', 'all']).default('pending'),
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(150),
});
export type WorklistQuery = z.input<typeof worklistQuery>;

export type WorklistGroup = {
  /** Tube id. */
  key: string;
  sample: { id: string; barcode: string; status: BenchSampleStatus; receivedAt: string | null; container: BenchContainer; sampleType: BenchRef };
  order: BenchOrderRef;
  patient: BenchPatient;
  /** Since the tube was received (or the order was registered). */
  waitingSince: string;
  results: BenchResult[];
};
export type Worklist = { groups: WorklistGroup[]; total: number; counts: { pending: number; toVerify: number } };

/* ================================================================== validation queue */

export const validationQueueQuery = z.object({
  departmentId: id.optional(),
  priority: z.enum(['routine', 'urgent', 'stat']).optional(),
  critical: boolish.optional(),
  q: z.string().trim().max(80).optional(),
});
export type ValidationQueueRow = {
  order: BenchOrderRef;
  patient: BenchPatient;
  doctor: { nameAr: string; nameEn: string | null } | null;
  departments: BenchRef[];
  counts: BenchResultCounts;
  /** Results waiting for medical validation (resulted or verified). */
  awaiting: number;
  abnormal: number;
  critical: number;
  criticalUncalled: number;
  delta: number;
  /** Nothing in the order is still waiting for a value. */
  allReady: boolean;
  readySince: string | null;
};

/* ================================================================== reports */

export type ReportRow = {
  code: string;
  nameAr: string;
  nameEn: string;
  value: string | null;
  unit: string | null;
  flag: BenchFlag | null;
  isCritical: boolean;
  refText: string | null;
  previous: { value: string | null; at: string } | null;
  comment: string | null;
  amended: boolean;
};

/** Everything printed on a report, frozen at release. */
export type ReportSnapshot = {
  schema: 1;
  version: number;
  replacesVersion: number | null;
  amendReason: string | null;
  verifyCode: string;
  language: ReportLanguage;
  demo: boolean;
  lab: {
    code: string;
    nameAr: string;
    nameEn: string;
    taglineAr: string | null;
    taglineEn: string | null;
    directorNameAr: string | null;
    directorNameEn: string | null;
    directorTitleAr: string | null;
    directorTitleEn: string | null;
    addressAr: string | null;
    addressEn: string | null;
    phone: string | null;
    email: string | null;
    logoSvg: string | null;
    brandColor: string;
    timezone: string;
  };
  patient: { fullNameAr: string; fullNameEn: string | null; sex: 'male' | 'female'; ageAr: string; ageEn: string; mrn: string };
  order: {
    accession: string;
    dailyNo: number;
    priority: BenchPriority;
    createdAt: string;
    collectedAt: string | null;
    receivedAt: string | null;
    validatedAt: string | null;
    releasedAt: string;
    doctor: { nameAr: string; nameEn: string | null } | null;
    referralClinic: string | null;
  };
  sections: Array<{
    department: { code: string; nameAr: string; nameEn: string };
    tests: Array<{ code: string; nameAr: string; nameEn: string; method: string | null; sampleTypeAr: string | null; sampleTypeEn: string | null; rows: ReportRow[] }>;
  }>;
  validators: Array<{ nameAr: string; nameEn: string; title: string | null; at: string }>;
  footerAr: string | null;
  footerEn: string | null;
  /** Some ordered tests are not on this report yet. */
  partial: boolean;
  pendingTests: Array<{ code: string; nameAr: string; nameEn: string; status: BenchItemStatus }>;
};

export type BenchReportVersion = {
  id: string;
  orderId: string;
  version: number;
  status: 'released' | 'superseded';
  releasedAt: string;
  releasedBy: BenchUserRef | null;
  amendReason: string | null;
  verifyCode: string;
  contentHash: string;
};
export type BenchReportDetail = BenchReportVersion & { snapshot: ReportSnapshot };

export type BenchDelivery = {
  id: string;
  channel: BenchDeliveryChannel;
  toAddress: string | null;
  status: 'sent' | 'simulated' | 'failed' | 'opened';
  note: string | null;
  createdAt: string;
  createdBy: BenchUserRef | null;
  reportVersion: number | null;
};

export type BenchOrderReports = {
  order: { id: string; accession: string; status: string; deliveredAt: string | null; deliveryChannel: string; patientPhone: string | null; patientEmail: string | null };
  report: BenchReportDetail | null;
  versions: BenchReportVersion[];
  deliveries: BenchDelivery[];
  /** Validated results waiting to be released, and how many of them still need a critical call. */
  releasable: { validated: number; criticalUncalled: number };
};

export const benchReleaseInput = z.object({ resultIds: z.array(id).max(500).optional() });
export const benchDeliverInput = z.object({
  channel: z.enum(['print', 'whatsapp', 'sms', 'email', 'portal']),
  to: z.string().trim().max(200).nullable().optional(),
});
export type BenchDeliverResult = { delivery: BenchDelivery; url: string | null; link: string | null; orderDelivered: boolean };
export type BenchReportLink = { url: string; expiresAt: string };

export const benchDeliveriesQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  status: z.enum(['pending', 'delivered', 'all']).default('all'),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type BenchDeliveryRow = {
  order: BenchOrderRef & { deliveredAt: string | null; deliveryChannel: string };
  patient: BenchPatient & { email: string | null; contactPref: string };
  report: { id: string; version: number; releasedAt: string; verifyCode: string; partial: boolean };
  lastByChannel: Partial<Record<BenchDeliveryChannel, { at: string; status: BenchDelivery['status'] }>>;
  openedAt: string | null;
};

/* ================================================================== public portal */

export const publicReportOpenInput = z.object({ token: z.string().trim().min(20).max(200), code: z.string().trim().regex(/^\d{6}$/) });
export const publicReportInfoInput = z.object({ token: z.string().trim().min(20).max(200) });
export const publicReportLookupInput = z.object({
  labCode: z.string().trim().toLowerCase().min(1).max(40),
  accession: z.string().trim().min(3).max(24),
  code: z.string().trim().regex(/^\d{6}$/),
});

export type PublicLabBranding = {
  code: string;
  nameAr: string;
  nameEn: string;
  taglineAr: string | null;
  taglineEn: string | null;
  logoSvg: string | null;
  brandColor: string;
  phone: string | null;
  addressAr: string | null;
  addressEn: string | null;
  demo: boolean;
};
export type PublicReportInfo = { lab: PublicLabBranding };
export type PublicReport = {
  lab: PublicLabBranding;
  version: number;
  releasedAt: string;
  verifyCode: string;
  contentHash: string;
  snapshot: ReportSnapshot;
};
export type PublicVerifyResult =
  | { status: 'not_found' }
  | {
      status: 'genuine' | 'superseded';
      lab: { code: string; nameAr: string; nameEn: string; logoSvg: string | null; brandColor: string };
      accession: string;
      version: number;
      latestVersion: number;
      releasedAt: string;
      patientInitials: string;
      testCount: number;
      contentHash: string;
    };

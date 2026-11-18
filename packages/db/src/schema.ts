/**
 * Natija database schema.
 *
 * Every lab-owned table carries `lab_id`. Row-level security (migrations/0001_rls.sql)
 * limits every query made by the application role to the lab set in `app.lab_id`.
 * Foreign keys between lab-owned tables include `lab_id`, so a row can never point
 * at a row that belongs to another lab.
 *
 * Tables without row-level security, on purpose: `labs` (tenant directory),
 * `sessions` and `agents` (looked up by token hash before the lab is known).
 * None of them hold patient data.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ helpers */

const numericNumber = customType<{
  data: number;
  driverData: string;
  config: { precision: number; scale: number };
}>({
  dataType(config) {
    return `numeric(${config?.precision ?? 14}, ${config?.scale ?? 2})`;
  },
  fromDriver(value) {
    return Number(value);
  },
  toDriver(value) {
    return String(value);
  },
});

/** Money: numeric(14,2), read as a JS number. */
const money = (name: string) => numericNumber(name, { precision: 14, scale: 2 });
/** Generic decimal: numeric(10,2), read as a JS number. */
const dec = (name: string) => numericNumber(name, { precision: 10, scale: 2 });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const labId = () =>
  uuid('lab_id')
    .notNull()
    .references(() => labs.id, { onDelete: 'cascade' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();
const emptyUuidArray = sql`'{}'::uuid[]`;
const emptyTextArray = sql`'{}'::text[]`;

/* ------------------------------------------------------------------ types */

export type LabSettings = {
  segregationOfDuties?: boolean;
  digits?: 'latin' | 'arabic';
  defaultLanguage?: 'ar' | 'en';
  reportLanguage?: 'ar' | 'en' | 'bilingual';
  reportFooterAr?: string;
  reportFooterEn?: string;
  deltaCheckDays?: number;
  showUsd?: boolean;
  usdRate?: number;
  requireCollectionStep?: boolean;
  /** Marks a fictional demo lab (shows a "Demo" badge). */
  demo?: boolean;
};

export type Sex = 'male' | 'female';
export type OrderStatus =
  | 'registered'
  | 'collected'
  | 'in_progress'
  | 'partial'
  | 'completed'
  | 'delivered'
  | 'cancelled';
export type ItemStatus =
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
export type SampleStatus =
  | 'pending'
  | 'collected'
  | 'in_transit'
  | 'received'
  | 'rejected'
  | 'in_analysis'
  | 'stored'
  | 'disposed';
export type ResultStatus = 'pending' | 'resulted' | 'verified' | 'validated' | 'released';
export type ResultFlag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';
export type InstrumentModel =
  | 'cobas_pure'
  | 'cobas_e411'
  | 'sysmex_xn'
  | 'ichroma3'
  | 'mindray_bs430'
  | 'medica_easystat'
  | 'other';
export type InstrumentProtocol = 'hl7' | 'astm' | 'medica_text' | 'ichroma_invented';

/* ================================================================== platform */

export const labs = pgTable('labs', {
  id: id(),
  code: varchar('code', { length: 40 }).notNull().unique(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  taglineAr: text('tagline_ar'),
  taglineEn: text('tagline_en'),
  phone: text('phone'),
  email: text('email'),
  city: text('city'),
  addressAr: text('address_ar'),
  addressEn: text('address_en'),
  directorNameAr: text('director_name_ar'),
  directorNameEn: text('director_name_en'),
  directorTitleAr: text('director_title_ar'),
  directorTitleEn: text('director_title_en'),
  logoSvg: text('logo_svg'),
  brandColor: varchar('brand_color', { length: 9 }).notNull().default('#2347B0'),
  currency: varchar('currency', { length: 3 }).notNull().default('SYP'),
  timezone: text('timezone').notNull().default('Asia/Damascus'),
  settings: jsonb('settings').$type<LabSettings>().notNull().default(sql`'{}'::jsonb`),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    labId: labId(),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** On-site Lab Agents. Looked up by token hash, so no row-level security. */
export const agents = pgTable(
  'agents',
  {
    id: id(),
    labId: labId(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').unique(),
    enrollCodeHash: text('enroll_code_hash'),
    enrollExpiresAt: ts('enroll_expires_at'),
    status: text('status').$type<'pending' | 'active' | 'revoked'>().notNull().default('pending'),
    version: text('version'),
    hostInfo: jsonb('host_info').$type<Record<string, unknown>>(),
    isVirtual: boolean('is_virtual').notNull().default(false),
    lastHeartbeatAt: ts('last_heartbeat_at'),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [unique('agents_lab_id_uq').on(t.labId, t.id)],
);

/* ================================================================== lab & staff */

export const branches = pgTable(
  'branches',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 20 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    addressAr: text('address_ar'),
    addressEn: text('address_en'),
    phone: text('phone'),
    isMain: boolean('is_main').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique('branches_lab_id_uq').on(t.labId, t.id), uniqueIndex('branches_code_uq').on(t.labId, t.code)],
);

export const departments = pgTable(
  'departments',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 20 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique('departments_lab_id_uq').on(t.labId, t.id), uniqueIndex('departments_code_uq').on(t.labId, t.code)],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    labId: labId(),
    username: varchar('username', { length: 60 }).notNull(),
    fullNameAr: text('full_name_ar').notNull(),
    fullNameEn: text('full_name_en').notNull(),
    title: text('title'),
    email: text('email'),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    departmentIds: uuid('department_ids').array().notNull().default(emptyUuidArray),
    branchIds: uuid('branch_ids').array().notNull().default(emptyUuidArray),
    language: text('language').$type<'ar' | 'en'>(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('users_lab_id_uq').on(t.labId, t.id), uniqueIndex('users_username_uq').on(t.labId, t.username)],
);

export const roles = pgTable(
  'roles',
  {
    id: id(),
    labId: labId(),
    key: varchar('key', { length: 40 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    permissions: text('permissions').array().notNull().default(emptyTextArray),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique('roles_lab_id_uq').on(t.labId, t.id), uniqueIndex('roles_key_uq').on(t.labId, t.key)],
);

export const userRoles = pgTable(
  'user_roles',
  {
    labId: labId(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'user_roles_pk', columns: [t.userId, t.roleId] }),
    foreignKey({ name: 'user_roles_user_fk', columns: [t.labId, t.userId], foreignColumns: [users.labId, users.id] }).onDelete('cascade'),
    foreignKey({ name: 'user_roles_role_fk', columns: [t.labId, t.roleId], foreignColumns: [roles.labId, roles.id] }).onDelete('cascade'),
  ],
);

/* ================================================================== catalog */

export const sampleTypes = pgTable(
  'sample_types',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 20 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('sample_types_lab_id_uq').on(t.labId, t.id), uniqueIndex('sample_types_code_uq').on(t.labId, t.code)],
);

export const containers = pgTable(
  'containers',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 20 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    capColor: text('cap_color').notNull().default('white'),
    volumeMl: dec('volume_ml'),
    createdAt: createdAt(),
  },
  (t) => [unique('containers_lab_id_uq').on(t.labId, t.id), uniqueIndex('containers_code_uq').on(t.labId, t.code)],
);

export const rejectionReasons = pgTable(
  'rejection_reasons',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 30 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('rejection_reasons_lab_id_uq').on(t.labId, t.id), uniqueIndex('rejection_reasons_code_uq').on(t.labId, t.code)],
);

export const tests = pgTable(
  'tests',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 30 }).notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    reportNameEn: text('report_name_en'),
    reportNameAr: text('report_name_ar'),
    departmentId: uuid('department_id').notNull(),
    sampleTypeId: uuid('sample_type_id').notNull(),
    containerId: uuid('container_id').notNull(),
    /** Price in units; price = units × the payer group's unit price. */
    units: dec('units').notNull().default(0),
    fixedPrice: money('fixed_price'),
    tatHours: integer('tat_hours').notNull().default(24),
    method: text('method'),
    isExternal: boolean('is_external').notNull().default(false),
    separateTube: boolean('separate_tube').notNull().default(false),
    isFavorite: boolean('is_favorite').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tests_lab_id_uq').on(t.labId, t.id),
    uniqueIndex('tests_code_uq').on(t.labId, t.code),
    foreignKey({ name: 'tests_department_fk', columns: [t.labId, t.departmentId], foreignColumns: [departments.labId, departments.id] }),
    foreignKey({ name: 'tests_sample_type_fk', columns: [t.labId, t.sampleTypeId], foreignColumns: [sampleTypes.labId, sampleTypes.id] }),
    foreignKey({ name: 'tests_container_fk', columns: [t.labId, t.containerId], foreignColumns: [containers.labId, containers.id] }),
  ],
);

export const analytes = pgTable(
  'analytes',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 30 }).notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    unit: text('unit'),
    resultType: text('result_type').$type<'numeric' | 'text' | 'option' | 'calculated'>().notNull().default('numeric'),
    decimals: integer('decimals').notNull().default(1),
    options: text('options').array().notNull().default(emptyTextArray),
    /** For calculated analytes, e.g. "CHOL - HDL - TG / 5" using analyte codes. */
    formula: text('formula'),
    /** Delta check: flag when the change from the previous result exceeds this percentage. */
    deltaPct: doublePrecision('delta_pct'),
    loinc: text('loinc'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('analytes_lab_id_uq').on(t.labId, t.id), uniqueIndex('analytes_code_uq').on(t.labId, t.code)],
);

export const testAnalytes = pgTable(
  'test_analytes',
  {
    labId: labId(),
    testId: uuid('test_id').notNull(),
    analyteId: uuid('analyte_id').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'test_analytes_pk', columns: [t.testId, t.analyteId] }),
    foreignKey({ name: 'test_analytes_test_fk', columns: [t.labId, t.testId], foreignColumns: [tests.labId, tests.id] }).onDelete('cascade'),
    foreignKey({ name: 'test_analytes_analyte_fk', columns: [t.labId, t.analyteId], foreignColumns: [analytes.labId, analytes.id] }).onDelete('cascade'),
  ],
);

export const referenceRanges = pgTable(
  'reference_ranges',
  {
    id: id(),
    labId: labId(),
    analyteId: uuid('analyte_id').notNull(),
    sex: text('sex').$type<'any' | Sex>().notNull().default('any'),
    ageMinDays: integer('age_min_days').notNull().default(0),
    /** Null means no upper age limit. */
    ageMaxDays: integer('age_max_days'),
    low: doublePrecision('low'),
    high: doublePrecision('high'),
    criticalLow: doublePrecision('critical_low'),
    criticalHigh: doublePrecision('critical_high'),
    /** Printable text, e.g. "Negative: < 1.0 COI". Used for text results or extra guidance. */
    textRange: text('text_range'),
    /** Optional: range applies only to this specimen type (e.g. CSF glucose). */
    sampleTypeId: uuid('sample_type_id'),
    /** Optional: range applies only to results from this instrument. */
    instrumentId: uuid('instrument_id'),
    note: text('note'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique('reference_ranges_lab_id_uq').on(t.labId, t.id),
    index('reference_ranges_analyte_idx').on(t.analyteId),
    foreignKey({ name: 'reference_ranges_analyte_fk', columns: [t.labId, t.analyteId], foreignColumns: [analytes.labId, analytes.id] }).onDelete('cascade'),
  ],
);

export const packages = pgTable(
  'packages',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 30 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    priceMode: text('price_mode').$type<'sum' | 'units' | 'fixed'>().notNull().default('sum'),
    units: dec('units'),
    fixedPrice: money('fixed_price'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('packages_lab_id_uq').on(t.labId, t.id), uniqueIndex('packages_code_uq').on(t.labId, t.code)],
);

export const packageTests = pgTable(
  'package_tests',
  {
    labId: labId(),
    packageId: uuid('package_id').notNull(),
    testId: uuid('test_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'package_tests_pk', columns: [t.packageId, t.testId] }),
    foreignKey({ name: 'package_tests_package_fk', columns: [t.labId, t.packageId], foreignColumns: [packages.labId, packages.id] }).onDelete('cascade'),
    foreignKey({ name: 'package_tests_test_fk', columns: [t.labId, t.testId], foreignColumns: [tests.labId, tests.id] }).onDelete('cascade'),
  ],
);

/**
 * Payer groups are price tiers: the general public, an insurer plan, a client lab, a union.
 * price = test units × unitPrice; insurer plans split the price into patient and insurer shares.
 */
export const payerGroups = pgTable(
  'payer_groups',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 30 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    kind: text('kind').$type<'public' | 'insurer' | 'client_lab' | 'other'>().notNull().default('public'),
    unitPrice: money('unit_price').notNull().default(0),
    patientSharePct: dec('patient_share_pct').notNull().default(100),
    discountPct: dec('discount_pct').notNull().default(0),
    /** Billed on account (insurer or client lab pays later). */
    onAccount: boolean('on_account').notNull().default(false),
    /** Insurer / third-party administrator, or client lab organisation name. */
    organization: text('organization'),
    contactName: text('contact_name'),
    phone: text('phone'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('payer_groups_lab_id_uq').on(t.labId, t.id), uniqueIndex('payer_groups_code_uq').on(t.labId, t.code)],
);

export const priceOverrides = pgTable(
  'price_overrides',
  {
    id: id(),
    labId: labId(),
    payerGroupId: uuid('payer_group_id').notNull(),
    testId: uuid('test_id').notNull(),
    price: money('price').notNull(),
  },
  (t) => [
    uniqueIndex('price_overrides_uq').on(t.payerGroupId, t.testId),
    foreignKey({ name: 'price_overrides_payer_fk', columns: [t.labId, t.payerGroupId], foreignColumns: [payerGroups.labId, payerGroups.id] }).onDelete('cascade'),
    foreignKey({ name: 'price_overrides_test_fk', columns: [t.labId, t.testId], foreignColumns: [tests.labId, tests.id] }).onDelete('cascade'),
  ],
);

export const doctors = pgTable(
  'doctors',
  {
    id: id(),
    labId: labId(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en'),
    specialtyAr: text('specialty_ar'),
    specialtyEn: text('specialty_en'),
    phone: text('phone'),
    clinic: text('clinic'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('doctors_lab_id_uq').on(t.labId, t.id)],
);

/* ================================================================== patients & orders */

export const patients = pgTable(
  'patients',
  {
    id: id(),
    labId: labId(),
    mrn: varchar('mrn', { length: 20 }).notNull(),
    firstNameAr: text('first_name_ar').notNull(),
    fatherNameAr: text('father_name_ar'),
    motherNameAr: text('mother_name_ar'),
    lastNameAr: text('last_name_ar').notNull(),
    firstNameEn: text('first_name_en'),
    lastNameEn: text('last_name_en'),
    fullNameAr: text('full_name_ar').notNull(),
    fullNameEn: text('full_name_en'),
    /** Normalised Arabic + Latin name, phone and MRN for search and duplicate checks. */
    searchText: text('search_text').notNull(),
    sex: text('sex').$type<Sex>().notNull(),
    birthDate: date('birth_date', { mode: 'string' }).notNull(),
    birthDateEstimated: boolean('birth_date_estimated').notNull().default(false),
    phone: text('phone'),
    contactPref: text('contact_pref').$type<'whatsapp' | 'sms' | 'call' | 'none'>().notNull().default('whatsapp'),
    email: text('email'),
    nationalId: text('national_id'),
    address: text('address'),
    /** Relevant medical history and clinical notes. */
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    mergedIntoId: uuid('merged_into_id'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    unique('patients_lab_id_uq').on(t.labId, t.id),
    uniqueIndex('patients_mrn_uq').on(t.labId, t.mrn),
    index('patients_created_idx').on(t.labId, t.createdAt),
  ],
);

export const patientAttachments = pgTable(
  'patient_attachments',
  {
    id: id(),
    labId: labId(),
    patientId: uuid('patient_id').notNull(),
    orderId: uuid('order_id'),
    kind: text('kind').$type<'referral' | 'id' | 'previous_result' | 'other'>().notNull().default('other'),
    fileName: text('file_name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedBy: uuid('uploaded_by'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'patient_attachments_patient_fk', columns: [t.labId, t.patientId], foreignColumns: [patients.labId, patients.id] }).onDelete('cascade'),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    labId: labId(),
    branchId: uuid('branch_id'),
    /** e.g. 261117-0042: date + daily sequence. */
    accession: varchar('accession', { length: 24 }).notNull(),
    dailyNo: integer('daily_no').notNull(),
    patientId: uuid('patient_id').notNull(),
    payerGroupId: uuid('payer_group_id').notNull(),
    doctorId: uuid('doctor_id'),
    referralClinic: text('referral_clinic'),
    source: text('source').$type<'walk_in' | 'referral' | 'client_lab' | 'home'>().notNull().default('walk_in'),
    /** Reference number given by a client lab or referring clinic. */
    externalRef: text('external_ref'),
    priority: text('priority').$type<'routine' | 'urgent' | 'stat'>().notNull().default('routine'),
    status: text('status').$type<OrderStatus>().notNull().default('registered'),
    clinicalInfo: text('clinical_info'),
    notes: text('notes'),
    fasting: boolean('fasting').notNull().default(false),
    pregnant: boolean('pregnant').notNull().default(false),
    deliveryChannel: text('delivery_channel').$type<'print' | 'whatsapp' | 'sms' | 'email'>().notNull().default('print'),
    /** 6-digit access code printed on the receipt for the patient report link. */
    portalCode: varchar('portal_code', { length: 8 }).notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts('completed_at'),
    deliveredAt: ts('delivered_at'),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: uuid('cancelled_by'),
    cancelReason: text('cancel_reason'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    unique('orders_lab_id_uq').on(t.labId, t.id),
    uniqueIndex('orders_accession_uq').on(t.labId, t.accession),
    index('orders_created_idx').on(t.labId, t.createdAt),
    index('orders_patient_idx').on(t.patientId),
    index('orders_status_idx').on(t.labId, t.status),
    foreignKey({ name: 'orders_patient_fk', columns: [t.labId, t.patientId], foreignColumns: [patients.labId, patients.id] }),
    foreignKey({ name: 'orders_payer_fk', columns: [t.labId, t.payerGroupId], foreignColumns: [payerGroups.labId, payerGroups.id] }),
    foreignKey({ name: 'orders_doctor_fk', columns: [t.labId, t.doctorId], foreignColumns: [doctors.labId, doctors.id] }),
    foreignKey({ name: 'orders_branch_fk', columns: [t.labId, t.branchId], foreignColumns: [branches.labId, branches.id] }),
  ],
);

export const samples = pgTable(
  'samples',
  {
    id: id(),
    labId: labId(),
    orderId: uuid('order_id').notNull(),
    /** Tube barcode: accession + tube number, e.g. 261117-0042-01. */
    barcode: varchar('barcode', { length: 32 }).notNull(),
    seq: integer('seq').notNull(),
    containerId: uuid('container_id').notNull(),
    sampleTypeId: uuid('sample_type_id').notNull(),
    departmentId: uuid('department_id'),
    status: text('status').$type<SampleStatus>().notNull().default('pending'),
    collectedAt: ts('collected_at'),
    collectedBy: uuid('collected_by'),
    receivedAt: ts('received_at'),
    receivedBy: uuid('received_by'),
    rejectedAt: ts('rejected_at'),
    rejectedBy: uuid('rejected_by'),
    rejectionReasonId: uuid('rejection_reason_id'),
    rejectionNote: text('rejection_note'),
    /** Set on the new tube when a rejected tube is recollected. */
    recollectOfId: uuid('recollect_of_id'),
    storageLocation: text('storage_location'),
    storedAt: ts('stored_at'),
    disposedAt: ts('disposed_at'),
    disposedBy: uuid('disposed_by'),
    labelPrintedAt: ts('label_printed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('samples_lab_id_uq').on(t.labId, t.id),
    uniqueIndex('samples_barcode_uq').on(t.labId, t.barcode),
    index('samples_order_idx').on(t.orderId),
    index('samples_status_idx').on(t.labId, t.status),
    foreignKey({ name: 'samples_order_fk', columns: [t.labId, t.orderId], foreignColumns: [orders.labId, orders.id] }).onDelete('cascade'),
    foreignKey({ name: 'samples_container_fk', columns: [t.labId, t.containerId], foreignColumns: [containers.labId, containers.id] }),
    foreignKey({ name: 'samples_sample_type_fk', columns: [t.labId, t.sampleTypeId], foreignColumns: [sampleTypes.labId, sampleTypes.id] }),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    labId: labId(),
    orderId: uuid('order_id').notNull(),
    testId: uuid('test_id').notNull(),
    packageId: uuid('package_id'),
    sampleId: uuid('sample_id'),
    status: text('status').$type<ItemStatus>().notNull().default('ordered'),
    units: dec('units').notNull().default(0),
    unitPrice: money('unit_price').notNull().default(0),
    /** Line price before discount, copied at order time. */
    price: money('price').notNull().default(0),
    discount: money('discount').notNull().default(0),
    isExternal: boolean('is_external').notNull().default(false),
    createdAt: createdAt(),
    releasedAt: ts('released_at'),
    cancelledAt: ts('cancelled_at'),
  },
  (t) => [
    unique('order_items_lab_id_uq').on(t.labId, t.id),
    index('order_items_order_idx').on(t.orderId),
    index('order_items_sample_idx').on(t.sampleId),
    foreignKey({ name: 'order_items_order_fk', columns: [t.labId, t.orderId], foreignColumns: [orders.labId, orders.id] }).onDelete('cascade'),
    foreignKey({ name: 'order_items_test_fk', columns: [t.labId, t.testId], foreignColumns: [tests.labId, tests.id] }),
    foreignKey({ name: 'order_items_sample_fk', columns: [t.labId, t.sampleId], foreignColumns: [samples.labId, samples.id] }),
  ],
);

export const sampleEvents = pgTable(
  'sample_events',
  {
    id: id(),
    labId: labId(),
    sampleId: uuid('sample_id').notNull(),
    type: text('type')
      .$type<'created' | 'collected' | 'received' | 'rejected' | 'moved' | 'stored' | 'disposed' | 'recollect_requested' | 'label_printed' | 'in_analysis'>()
      .notNull(),
    at: ts('at').notNull().defaultNow(),
    userId: uuid('user_id'),
    fromLocation: text('from_location'),
    toLocation: text('to_location'),
    note: text('note'),
  },
  (t) => [
    index('sample_events_sample_idx').on(t.sampleId),
    foreignKey({ name: 'sample_events_sample_fk', columns: [t.labId, t.sampleId], foreignColumns: [samples.labId, samples.id] }).onDelete('cascade'),
  ],
);

/* ================================================================== instruments */

export const instruments = pgTable(
  'instruments',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 30 }).notNull(),
    name: text('name').notNull(),
    model: text('model').$type<InstrumentModel>().notNull(),
    manufacturer: text('manufacturer'),
    departmentId: uuid('department_id'),
    protocol: text('protocol').$type<InstrumentProtocol>().notNull(),
    transport: text('transport').$type<'tcp_server' | 'tcp_client' | 'serial'>().notNull().default('tcp_server'),
    host: text('host'),
    port: integer('port'),
    serialPort: text('serial_port'),
    baudRate: integer('baud_rate'),
    agentId: uuid('agent_id'),
    status: text('status').$type<'online' | 'offline' | 'error' | 'unknown'>().notNull().default('unknown'),
    integrationLevel: text('integration_level').$type<'L0' | 'L1' | 'L2' | 'L3'>().notNull().default('L0'),
    isSimulated: boolean('is_simulated').notNull().default(true),
    lastMessageAt: ts('last_message_at'),
    lastSeenAt: ts('last_seen_at'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('instruments_lab_id_uq').on(t.labId, t.id), uniqueIndex('instruments_code_uq').on(t.labId, t.code)],
);

export const instrumentMappings = pgTable(
  'instrument_mappings',
  {
    id: id(),
    labId: labId(),
    instrumentId: uuid('instrument_id').notNull(),
    /** The code the instrument uses, e.g. "WBC" (Sysmex) or "20990" (Roche ACN). */
    instrumentCode: varchar('instrument_code', { length: 40 }).notNull(),
    analyteId: uuid('analyte_id').notNull(),
    /** Multiply the instrument value by this to get the lab's unit. */
    unitFactor: doublePrecision('unit_factor').notNull().default(1),
    instrumentUnit: text('instrument_unit'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [
    uniqueIndex('instrument_mappings_uq').on(t.instrumentId, t.instrumentCode),
    foreignKey({ name: 'instrument_mappings_instrument_fk', columns: [t.labId, t.instrumentId], foreignColumns: [instruments.labId, instruments.id] }).onDelete('cascade'),
    foreignKey({ name: 'instrument_mappings_analyte_fk', columns: [t.labId, t.analyteId], foreignColumns: [analytes.labId, analytes.id] }).onDelete('cascade'),
  ],
);

export const integrationMessages = pgTable(
  'integration_messages',
  {
    id: id(),
    labId: labId(),
    instrumentId: uuid('instrument_id').notNull(),
    agentId: uuid('agent_id'),
    direction: text('direction').$type<'in' | 'out'>().notNull().default('in'),
    protocol: text('protocol').$type<InstrumentProtocol>().notNull(),
    messageType: text('message_type'),
    controlId: text('control_id'),
    raw: text('raw').notNull(),
    rawHash: varchar('raw_hash', { length: 64 }).notNull(),
    parsed: jsonb('parsed').$type<unknown>(),
    status: text('status').$type<'received' | 'processed' | 'duplicate' | 'error' | 'partial' | 'unmatched'>().notNull().default('received'),
    error: text('error'),
    sampleBarcode: text('sample_barcode'),
    resultsCount: integer('results_count').notNull().default(0),
    isSimulated: boolean('is_simulated').notNull().default(false),
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
  },
  (t) => [
    unique('integration_messages_lab_id_uq').on(t.labId, t.id),
    uniqueIndex('integration_messages_hash_uq').on(t.labId, t.instrumentId, t.rawHash),
    index('integration_messages_received_idx').on(t.labId, t.instrumentId, t.receivedAt),
    foreignKey({ name: 'integration_messages_instrument_fk', columns: [t.labId, t.instrumentId], foreignColumns: [instruments.labId, instruments.id] }).onDelete('cascade'),
  ],
);

export const integrationEvents = pgTable(
  'integration_events',
  {
    id: id(),
    labId: labId(),
    instrumentId: uuid('instrument_id'),
    agentId: uuid('agent_id'),
    level: text('level').$type<'info' | 'warn' | 'error'>().notNull().default('info'),
    event: text('event').notNull(),
    detail: text('detail'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('integration_events_at_idx').on(t.labId, t.at)],
);

export const reviewItems = pgTable(
  'review_items',
  {
    id: id(),
    labId: labId(),
    instrumentId: uuid('instrument_id').notNull(),
    messageId: uuid('message_id'),
    sampleBarcode: text('sample_barcode'),
    instrumentCode: text('instrument_code'),
    valueText: text('value_text'),
    unit: text('unit'),
    flags: text('flags'),
    reason: text('reason')
      .$type<'unknown_sample' | 'unknown_code' | 'unit_mismatch' | 'no_order_item' | 'sample_rejected' | 'result_locked'>()
      .notNull(),
    status: text('status').$type<'open' | 'assigned' | 'dismissed'>().notNull().default('open'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: ts('resolved_at'),
    assignedResultId: uuid('assigned_result_id'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('review_items_status_idx').on(t.labId, t.status)],
);

/* ================================================================== results */

export const results = pgTable(
  'results',
  {
    id: id(),
    labId: labId(),
    orderId: uuid('order_id').notNull(),
    orderItemId: uuid('order_item_id').notNull(),
    analyteId: uuid('analyte_id').notNull(),
    status: text('status').$type<ResultStatus>().notNull().default('pending'),
    valueNum: doublePrecision('value_num'),
    valueText: text('value_text'),
    unit: text('unit'),
    flag: text('flag').$type<ResultFlag>(),
    refLow: doublePrecision('ref_low'),
    refHigh: doublePrecision('ref_high'),
    refText: text('ref_text'),
    critLow: doublePrecision('crit_low'),
    critHigh: doublePrecision('crit_high'),
    isCritical: boolean('is_critical').notNull().default(false),
    deltaFlag: boolean('delta_flag').notNull().default(false),
    deltaPrevValue: doublePrecision('delta_prev_value'),
    deltaPrevAt: ts('delta_prev_at'),
    selectedAttemptId: uuid('selected_attempt_id'),
    instrumentId: uuid('instrument_id'),
    comment: text('comment'),
    enteredBy: uuid('entered_by'),
    enteredAt: ts('entered_at'),
    verifiedBy: uuid('verified_by'),
    verifiedAt: ts('verified_at'),
    validatedBy: uuid('validated_by'),
    validatedAt: ts('validated_at'),
    releasedAt: ts('released_at'),
    amended: boolean('amended').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('results_lab_id_uq').on(t.labId, t.id),
    uniqueIndex('results_item_analyte_uq').on(t.orderItemId, t.analyteId),
    index('results_order_idx').on(t.orderId),
    index('results_status_idx').on(t.labId, t.status),
    index('results_analyte_idx').on(t.analyteId),
    foreignKey({ name: 'results_order_fk', columns: [t.labId, t.orderId], foreignColumns: [orders.labId, orders.id] }).onDelete('cascade'),
    foreignKey({ name: 'results_item_fk', columns: [t.labId, t.orderItemId], foreignColumns: [orderItems.labId, orderItems.id] }).onDelete('cascade'),
    foreignKey({ name: 'results_analyte_fk', columns: [t.labId, t.analyteId], foreignColumns: [analytes.labId, analytes.id] }),
  ],
);

export const resultAttempts = pgTable(
  'result_attempts',
  {
    id: id(),
    labId: labId(),
    resultId: uuid('result_id').notNull(),
    source: text('source').$type<'manual' | 'instrument' | 'calculated'>().notNull(),
    valueNum: doublePrecision('value_num'),
    valueText: text('value_text'),
    unit: text('unit'),
    rawFlag: text('raw_flag'),
    instrumentId: uuid('instrument_id'),
    messageId: uuid('message_id'),
    dilution: doublePrecision('dilution'),
    isRerun: boolean('is_rerun').notNull().default(false),
    measuredAt: ts('measured_at'),
    enteredBy: uuid('entered_by'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('result_attempts_result_idx').on(t.resultId),
    foreignKey({ name: 'result_attempts_result_fk', columns: [t.labId, t.resultId], foreignColumns: [results.labId, results.id] }).onDelete('cascade'),
  ],
);

export const resultVersions = pgTable(
  'result_versions',
  {
    id: id(),
    labId: labId(),
    resultId: uuid('result_id').notNull(),
    version: integer('version').notNull(),
    valueNum: doublePrecision('value_num'),
    valueText: text('value_text'),
    flag: text('flag'),
    status: text('status').notNull(),
    reason: text('reason'),
    changedBy: uuid('changed_by'),
    changedAt: ts('changed_at').notNull().defaultNow(),
  },
  (t) => [
    index('result_versions_result_idx').on(t.resultId),
    foreignKey({ name: 'result_versions_result_fk', columns: [t.labId, t.resultId], foreignColumns: [results.labId, results.id] }).onDelete('cascade'),
  ],
);

export const criticalCalls = pgTable(
  'critical_calls',
  {
    id: id(),
    labId: labId(),
    resultId: uuid('result_id').notNull(),
    orderId: uuid('order_id').notNull(),
    calledBy: uuid('called_by'),
    calledAt: ts('called_at').notNull().defaultNow(),
    recipientName: text('recipient_name').notNull(),
    recipientRole: text('recipient_role').$type<'doctor' | 'patient' | 'nurse' | 'other'>().notNull(),
    phone: text('phone'),
    readBack: boolean('read_back').notNull().default(false),
    note: text('note'),
  },
  (t) => [
    index('critical_calls_result_idx').on(t.resultId),
    foreignKey({ name: 'critical_calls_result_fk', columns: [t.labId, t.resultId], foreignColumns: [results.labId, results.id] }).onDelete('cascade'),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: id(),
    labId: labId(),
    orderId: uuid('order_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<'released' | 'superseded'>().notNull().default('released'),
    /** Everything printed on the report, frozen at release. */
    snapshot: jsonb('snapshot').$type<unknown>().notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    /** Public code behind the QR on the printed report (globally unique). */
    verifyCode: varchar('verify_code', { length: 16 }).notNull().unique(),
    releasedBy: uuid('released_by'),
    releasedAt: ts('released_at').notNull().defaultNow(),
    amendReason: text('amend_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('reports_lab_id_uq').on(t.labId, t.id),
    index('reports_order_idx').on(t.orderId),
    foreignKey({ name: 'reports_order_fk', columns: [t.labId, t.orderId], foreignColumns: [orders.labId, orders.id] }).onDelete('cascade'),
  ],
);

export const reportTokens = pgTable(
  'report_tokens',
  {
    id: id(),
    labId: labId(),
    orderId: uuid('order_id').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    lastUsedAt: ts('last_used_at'),
    uses: integer('uses').notNull().default(0),
    failedAttempts: integer('failed_attempts').notNull().default(0),
  },
  (t) => [
    foreignKey({ name: 'report_tokens_order_fk', columns: [t.labId, t.orderId], foreignColumns: [orders.labId, orders.id] }).onDelete('cascade'),
  ],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: id(),
    labId: labId(),
    orderId: uuid('order_id').notNull(),
    reportId: uuid('report_id'),
    channel: text('channel').$type<'print' | 'whatsapp' | 'sms' | 'email' | 'portal'>().notNull(),
    toAddress: text('to_address'),
    status: text('status').$type<'sent' | 'simulated' | 'failed' | 'opened'>().notNull().default('sent'),
    note: text('note'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('deliveries_order_idx').on(t.orderId),
    foreignKey({ name: 'deliveries_order_fk', columns: [t.labId, t.orderId], foreignColumns: [orders.labId, orders.id] }).onDelete('cascade'),
  ],
);

/* ================================================================== quality */

export const qcMaterials = pgTable(
  'qc_materials',
  {
    id: id(),
    labId: labId(),
    instrumentId: uuid('instrument_id'),
    analyteId: uuid('analyte_id').notNull(),
    name: text('name').notNull(),
    lot: text('lot').notNull(),
    level: text('level').notNull(),
    targetMean: doublePrecision('target_mean').notNull(),
    targetSd: doublePrecision('target_sd').notNull(),
    unit: text('unit'),
    expiresOn: date('expires_on', { mode: 'string' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('qc_materials_lab_id_uq').on(t.labId, t.id),
    foreignKey({ name: 'qc_materials_analyte_fk', columns: [t.labId, t.analyteId], foreignColumns: [analytes.labId, analytes.id] }).onDelete('cascade'),
  ],
);

export const qcRuns = pgTable(
  'qc_runs',
  {
    id: id(),
    labId: labId(),
    materialId: uuid('material_id').notNull(),
    value: doublePrecision('value').notNull(),
    runAt: ts('run_at').notNull().defaultNow(),
    userId: uuid('user_id'),
    source: text('source').$type<'manual' | 'instrument'>().notNull().default('manual'),
    status: text('status').$type<'accepted' | 'warning' | 'rejected'>().notNull().default('accepted'),
    violations: text('violations').array().notNull().default(emptyTextArray),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('qc_runs_material_idx').on(t.materialId, t.runAt),
    foreignKey({ name: 'qc_runs_material_fk', columns: [t.labId, t.materialId], foreignColumns: [qcMaterials.labId, qcMaterials.id] }).onDelete('cascade'),
  ],
);

export const maintenanceLogs = pgTable(
  'maintenance_logs',
  {
    id: id(),
    labId: labId(),
    instrumentId: uuid('instrument_id').notNull(),
    kind: text('kind').$type<'daily' | 'weekly' | 'monthly' | 'repair' | 'calibration' | 'service'>().notNull(),
    performedAt: ts('performed_at').notNull().defaultNow(),
    performedBy: uuid('performed_by'),
    performedByName: text('performed_by_name'),
    nextDueAt: ts('next_due_at'),
    description: text('description'),
    outcome: text('outcome').$type<'ok' | 'issue' | 'failed'>().notNull().default('ok'),
    createdAt: createdAt(),
  },
  (t) => [
    index('maintenance_logs_instrument_idx').on(t.instrumentId, t.performedAt),
    foreignKey({ name: 'maintenance_logs_instrument_fk', columns: [t.labId, t.instrumentId], foreignColumns: [instruments.labId, instruments.id] }).onDelete('cascade'),
  ],
);

/* ================================================================== finance */

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    labId: labId(),
    orderId: uuid('order_id').notNull(),
    number: varchar('number', { length: 30 }).notNull(),
    payerGroupId: uuid('payer_group_id').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('SYP'),
    subtotal: money('subtotal').notNull().default(0),
    discountTotal: money('discount_total').notNull().default(0),
    insurerTotal: money('insurer_total').notNull().default(0),
    patientTotal: money('patient_total').notNull().default(0),
    paidTotal: money('paid_total').notNull().default(0),
    status: text('status').$type<'open' | 'partial' | 'paid' | 'void'>().notNull().default('open'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    voidedAt: ts('voided_at'),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    unique('invoices_lab_id_uq').on(t.labId, t.id),
    uniqueIndex('invoices_number_uq').on(t.labId, t.number),
    uniqueIndex('invoices_order_uq').on(t.labId, t.orderId),
    index('invoices_created_idx').on(t.labId, t.createdAt),
    foreignKey({ name: 'invoices_order_fk', columns: [t.labId, t.orderId], foreignColumns: [orders.labId, orders.id] }).onDelete('cascade'),
    foreignKey({ name: 'invoices_payer_fk', columns: [t.labId, t.payerGroupId], foreignColumns: [payerGroups.labId, payerGroups.id] }),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: id(),
    labId: labId(),
    invoiceId: uuid('invoice_id').notNull(),
    orderItemId: uuid('order_item_id'),
    description: text('description').notNull(),
    units: dec('units').notNull().default(0),
    unitPrice: money('unit_price').notNull().default(0),
    price: money('price').notNull().default(0),
    discount: money('discount').notNull().default(0),
    insurerShare: money('insurer_share').notNull().default(0),
    patientShare: money('patient_share').notNull().default(0),
  },
  (t) => [
    index('invoice_lines_invoice_idx').on(t.invoiceId),
    foreignKey({ name: 'invoice_lines_invoice_fk', columns: [t.labId, t.invoiceId], foreignColumns: [invoices.labId, invoices.id] }).onDelete('cascade'),
  ],
);

export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: id(),
    labId: labId(),
    code: varchar('code', { length: 20 }).notNull(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    isCash: boolean('is_cash').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [unique('payment_methods_lab_id_uq').on(t.labId, t.id), uniqueIndex('payment_methods_code_uq').on(t.labId, t.code)],
);

export const cashSessions = pgTable(
  'cash_sessions',
  {
    id: id(),
    labId: labId(),
    branchId: uuid('branch_id'),
    openedBy: uuid('opened_by').notNull(),
    openedAt: ts('opened_at').notNull().defaultNow(),
    openingFloat: money('opening_float').notNull().default(0),
    closedBy: uuid('closed_by'),
    closedAt: ts('closed_at'),
    countedCash: money('counted_cash'),
    expectedCash: money('expected_cash'),
    difference: money('difference'),
    status: text('status').$type<'open' | 'closed'>().notNull().default('open'),
    note: text('note'),
  },
  (t) => [unique('cash_sessions_lab_id_uq').on(t.labId, t.id), index('cash_sessions_open_idx').on(t.labId, t.status)],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    labId: labId(),
    invoiceId: uuid('invoice_id').notNull(),
    cashSessionId: uuid('cash_session_id'),
    methodId: uuid('method_id').notNull(),
    kind: text('kind').$type<'payment' | 'refund'>().notNull().default('payment'),
    /** Always positive; refunds are subtracted by kind. */
    amount: money('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('SYP'),
    reference: text('reference'),
    note: text('note'),
    receivedBy: uuid('received_by'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    idempotencyKey: varchar('idempotency_key', { length: 80 }),
  },
  (t) => [
    index('payments_invoice_idx').on(t.invoiceId),
    index('payments_received_idx').on(t.labId, t.receivedAt),
    uniqueIndex('payments_idempotency_uq').on(t.labId, t.idempotencyKey),
    foreignKey({ name: 'payments_invoice_fk', columns: [t.labId, t.invoiceId], foreignColumns: [invoices.labId, invoices.id] }).onDelete('cascade'),
    foreignKey({ name: 'payments_method_fk', columns: [t.labId, t.methodId], foreignColumns: [paymentMethods.labId, paymentMethods.id] }),
    foreignKey({ name: 'payments_session_fk', columns: [t.labId, t.cashSessionId], foreignColumns: [cashSessions.labId, cashSessions.id] }),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    labId: labId(),
    kind: text('kind').$type<'discount' | 'free' | 'refund' | 'cancel'>().notNull(),
    orderId: uuid('order_id'),
    invoiceId: uuid('invoice_id'),
    amount: money('amount'),
    percent: dec('percent'),
    reason: text('reason').notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
    requestedBy: uuid('requested_by'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
  },
  (t) => [index('approvals_status_idx').on(t.labId, t.status)],
);

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: id(),
    labId: labId(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('expense_categories_lab_id_uq').on(t.labId, t.id)],
);

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    labId: labId(),
    categoryId: uuid('category_id').notNull(),
    amount: money('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('SYP'),
    paidAt: ts('paid_at').notNull().defaultNow(),
    note: text('note'),
    cashSessionId: uuid('cash_session_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('expenses_paid_idx').on(t.labId, t.paidAt),
    foreignKey({ name: 'expenses_category_fk', columns: [t.labId, t.categoryId], foreignColumns: [expenseCategories.labId, expenseCategories.id] }),
  ],
);

/* ================================================================== cross-cutting */

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    labId: labId(),
    userId: uuid('user_id').notNull(),
    kind: text('kind').$type<'critical' | 'rejection' | 'pending' | 'report_ready' | 'instrument' | 'approval' | 'system'>().notNull(),
    severity: text('severity').$type<'info' | 'warning' | 'critical'>().notNull().default('info'),
    titleAr: text('title_ar').notNull(),
    titleEn: text('title_en').notNull(),
    bodyAr: text('body_ar'),
    bodyEn: text('body_en'),
    link: text('link'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: id(),
    labId: labId(),
    channel: text('channel').$type<'sms' | 'email' | 'whatsapp'>().notNull(),
    toAddress: text('to_address').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    status: text('status').$type<'pending' | 'simulated' | 'sent' | 'failed'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    orderId: uuid('order_id'),
    provider: text('provider'),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('outbox_status_idx').on(t.status, t.createdAt)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    /** Insertion order; the hash chain follows it. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    labId: labId(),
    userId: uuid('user_id'),
    actorName: text('actor_name'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    summary: text('summary'),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    at: ts('at').notNull().defaultNow(),
    prevHash: varchar('prev_hash', { length: 64 }),
    hash: varchar('hash', { length: 64 }).notNull(),
  },
  (t) => [
    index('audit_log_at_idx').on(t.labId, t.at),
    index('audit_log_seq_idx').on(t.labId, t.seq),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
  ],
);

/** Per-lab counters for human-readable numbers (daily order number, MRN, invoice number). */
export const counters = pgTable(
  'counters',
  {
    labId: labId(),
    key: text('key').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ name: 'counters_pk', columns: [t.labId, t.key] })],
);

/* ================================================================== inferred types */

export type Lab = typeof labs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Department = typeof departments.$inferSelect;
export type Test = typeof tests.$inferSelect;
export type Analyte = typeof analytes.$inferSelect;
export type ReferenceRange = typeof referenceRanges.$inferSelect;
export type PayerGroup = typeof payerGroups.$inferSelect;
export type Patient = typeof patients.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type Sample = typeof samples.$inferSelect;
export type Result = typeof results.$inferSelect;
export type ResultAttempt = typeof resultAttempts.$inferSelect;
export type Instrument = typeof instruments.$inferSelect;
export type InstrumentMapping = typeof instrumentMappings.$inferSelect;
export type IntegrationMessage = typeof integrationMessages.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Report = typeof reports.$inferSelect;

/**
 * Reports: a frozen snapshot of everything printed, versioned per order. Releasing validated
 * results creates a new version (content hash + public verify code) and supersedes the
 * previous one. Patient links, delivery by print / WhatsApp / SMS / email / portal.
 */
import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, lt, max, min, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  criticalCalls,
  deliveries,
  departments,
  doctors,
  orderItems,
  orders,
  patients,
  reports,
  reportTokens,
  results,
  samples,
  sampleTypes,
  tests,
  type Lab,
} from '@natija/db';
import type {
  BenchDeliverResult,
  BenchDelivery,
  BenchDeliveryChannel,
  BenchDeliveryRow,
  BenchFlag,
  BenchItemStatus,
  BenchOrderReports,
  BenchReportDetail,
  BenchReportLink,
  BenchReportVersion,
  BenchUserRef,
  ReportLanguage,
  ReportSnapshot,
} from '@natija/contracts';
import { formatAge, normalizeText, verifyCode } from '@natija/domain';
import { config } from '../../config';
import { ctx, db } from '../../db';
import { audit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { dayRange } from '../../lib/http';
import { getLab } from '../../lib/lab';
import { queueMessage } from '../../services/outbox';
import { refreshOrderStatus } from '../../services/order-status';
import { compareResultRows, displayValue, inSequence, iso, loadUserRefs, orderCols, orderRef, patientCols, patientRef, previousValues, selectResultRows } from '../results/shared';

export type ReleaseOptions = { at?: Date };
const LINK_DAYS = 30;

/** JSON with object keys sorted at every level: the input of the report's content hash. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function reportContentHash(snapshot: unknown): string {
  return sha256(canonicalJson(snapshot));
}

/* ------------------------------------------------------------------ snapshot */

/**
 * Everything printed on the report for the order's released results: letterhead, patient,
 * order times, sections per department with previous values, validators, footers and code.
 */
export async function buildReportSnapshot(
  orderId: string,
  opts: { version?: number; replacesVersion?: number | null; amendReason?: string | null; verifyCode?: string; releasedAt?: Date } = {},
): Promise<ReportSnapshot> {
  const lab = await getLab(ctx().labId);
  const [head] = await db()
    .select({
      o: orders,
      p: { fullNameAr: patients.fullNameAr, fullNameEn: patients.fullNameEn, sex: patients.sex, birthDate: patients.birthDate, mrn: patients.mrn },
      d: { nameAr: doctors.nameAr, nameEn: doctors.nameEn },
    })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .leftJoin(doctors, eq(doctors.id, orders.doctorId))
    .where(eq(orders.id, orderId));
  if (!head) throw notFound('order_not_found');
  const { o, p } = head;

  const rows = await selectResultRows(and(eq(results.orderId, orderId), eq(results.status, 'released'), ne(orderItems.status, 'cancelled')));
  const deptIds = [...new Set(rows.map((r) => r.t.departmentId))];
  const typeIds = [...new Set(rows.map((r) => r.s?.sampleTypeId).filter((x): x is string => !!x))];
  const [deptRows, typeRows, itemRows, tubeTimes, prev] = await inSequence([
    () => deptIds.length ? db().select().from(departments).where(inArray(departments.id, deptIds)) : Promise.resolve([]),
    () => typeIds.length ? db().select().from(sampleTypes).where(inArray(sampleTypes.id, typeIds)) : Promise.resolve([]),
    () => db()
      .select({ status: orderItems.status, code: tests.code, nameAr: tests.nameAr, nameEn: tests.nameEn, sortOrder: tests.sortOrder })
      .from(orderItems)
      .innerJoin(tests, eq(tests.id, orderItems.testId))
      .where(and(eq(orderItems.orderId, orderId), ne(orderItems.status, 'cancelled'))),
    () => db()
      .select({ collectedAt: min(samples.collectedAt), receivedAt: min(samples.receivedAt) })
      .from(samples)
      .where(and(eq(samples.orderId, orderId), ne(samples.status, 'rejected'))),
    () => previousValues(
      rows.map((x) => ({ resultId: x.r.id, patientId: x.o.patientId, analyteId: x.a.id, orderId: x.o.id, orderCreatedAt: x.o.createdAt, decimals: x.a.decimals })),
      ['released'],
    ),
  ]);
  const deptMap = new Map(deptRows.map((d) => [d.id, d]));
  const typeMap = new Map(typeRows.map((t) => [t.id, t]));
  rows.sort((x, y) => (deptMap.get(x.t.departmentId)?.sortOrder ?? 99) - (deptMap.get(y.t.departmentId)?.sortOrder ?? 99) || compareResultRows(x, y));

  const sections: ReportSnapshot['sections'] = [];
  const validators = new Map<string, Date>();
  let validatedAt: Date | null = null;
  for (const row of rows) {
    const dept = deptMap.get(row.t.departmentId);
    let section = sections.find((s) => s.department.code === (dept?.code ?? '-'));
    if (!section) {
      section = { department: { code: dept?.code ?? '-', nameAr: dept?.nameAr ?? '', nameEn: dept?.nameEn ?? '' }, tests: [] };
      sections.push(section);
    }
    let test = section.tests.find((t) => t.code === row.t.code);
    if (!test) {
      const type = row.s ? typeMap.get(row.s.sampleTypeId) : undefined;
      test = {
        code: row.t.code,
        nameAr: row.t.reportNameAr || row.t.nameAr,
        nameEn: row.t.reportNameEn || row.t.nameEn,
        method: row.t.method,
        sampleTypeAr: type?.nameAr ?? null,
        sampleTypeEn: type?.nameEn ?? null,
        rows: [],
      };
      section.tests.push(test);
    }
    const pv = prev.get(row.r.id);
    test.rows.push({
      code: row.a.code,
      nameAr: row.a.nameAr,
      nameEn: row.a.nameEn,
      value: displayValue(row.r.valueNum, row.r.valueText, row.a.decimals),
      unit: row.r.unit ?? row.a.unit,
      flag: (row.r.flag as BenchFlag | null) ?? null,
      isCritical: row.r.isCritical,
      refText: row.r.refText,
      previous: pv ? { value: pv.value, at: pv.at.toISOString() } : null,
      comment: row.r.comment,
      amended: row.r.amended,
    });
    if (row.r.validatedBy && row.r.validatedAt) {
      const at = validators.get(row.r.validatedBy);
      if (!at || row.r.validatedAt > at) validators.set(row.r.validatedBy, row.r.validatedAt);
      if (!validatedAt || row.r.validatedAt > validatedAt) validatedAt = row.r.validatedAt;
    }
  }
  const userMap = await loadUserRefs([...validators.keys()]);
  const pendingTests = itemRows
    .filter((i) => i.status !== 'released')
    .sort((x, y) => x.sortOrder - y.sortOrder)
    .map((i) => ({ code: i.code, nameAr: i.nameAr, nameEn: i.nameEn, status: i.status as BenchItemStatus }));
  const releasedAt = opts.releasedAt ?? new Date();

  return {
    schema: 1,
    version: opts.version ?? 1,
    replacesVersion: opts.replacesVersion ?? null,
    amendReason: opts.amendReason ?? null,
    verifyCode: opts.verifyCode ?? '',
    language: (lab.settings.reportLanguage ?? 'bilingual') as ReportLanguage,
    demo: lab.settings.demo === true,
    lab: {
      code: lab.code,
      nameAr: lab.nameAr,
      nameEn: lab.nameEn,
      taglineAr: lab.taglineAr,
      taglineEn: lab.taglineEn,
      directorNameAr: lab.directorNameAr,
      directorNameEn: lab.directorNameEn,
      directorTitleAr: lab.directorTitleAr,
      directorTitleEn: lab.directorTitleEn,
      addressAr: lab.addressAr,
      addressEn: lab.addressEn,
      phone: lab.phone,
      email: lab.email,
      logoSvg: lab.logoSvg,
      brandColor: lab.brandColor,
      timezone: lab.timezone,
    },
    patient: {
      fullNameAr: p.fullNameAr,
      fullNameEn: p.fullNameEn,
      sex: p.sex,
      ageAr: formatAge(p.birthDate, 'ar', o.createdAt),
      ageEn: formatAge(p.birthDate, 'en', o.createdAt),
      mrn: p.mrn,
    },
    order: {
      accession: o.accession,
      dailyNo: o.dailyNo,
      priority: o.priority,
      createdAt: o.createdAt.toISOString(),
      collectedAt: iso(tubeTimes[0]?.collectedAt ?? null),
      receivedAt: iso(tubeTimes[0]?.receivedAt ?? null),
      validatedAt: iso(validatedAt),
      releasedAt: releasedAt.toISOString(),
      doctor: head.d ? { nameAr: head.d.nameAr, nameEn: head.d.nameEn } : null,
      referralClinic: o.referralClinic,
    },
    sections,
    validators: [...validators.entries()]
      .sort((x, y) => x[1].getTime() - y[1].getTime())
      .map(([id, at]) => {
        const u = userMap.get(id);
        return { nameAr: u?.fullNameAr ?? '', nameEn: u?.fullNameEn ?? '', title: u?.title ?? null, at: at.toISOString() };
      }),
    footerAr: lab.settings.reportFooterAr ?? null,
    footerEn: lab.settings.reportFooterEn ?? null,
    partial: pendingTests.length > 0,
    pendingTests,
  };
}

/* ------------------------------------------------------------------ versions */

type ReportRowDb = typeof reports.$inferSelect;

function toVersion(r: Omit<ReportRowDb, 'snapshot'>, users: Map<string, BenchUserRef>): BenchReportVersion {
  return {
    id: r.id,
    orderId: r.orderId,
    version: r.version,
    status: r.status,
    releasedAt: r.releasedAt.toISOString(),
    releasedBy: r.releasedBy ? (users.get(r.releasedBy) ?? null) : null,
    amendReason: r.amendReason,
    verifyCode: r.verifyCode,
    contentHash: r.contentHash,
  };
}

/**
 * Freeze a new report version from the order's released results: snapshot, content hash and a
 * unique public verify code. The previous version becomes "superseded".
 */
export async function createReportVersion(orderId: string, opts: { amendReason?: string | null; at?: Date } = {}): Promise<BenchReportVersion> {
  const { labId, userId } = ctx();
  const now = opts.at ?? new Date();
  await db().select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for('update');
  const [last] = await db().select({ version: max(reports.version) }).from(reports).where(eq(reports.orderId, orderId));
  const previous = Number(last?.version ?? 0);
  const version = previous + 1;
  const snapshot = await buildReportSnapshot(orderId, { version, replacesVersion: previous || null, amendReason: opts.amendReason ?? null, releasedAt: now });

  let row: ReportRowDb | null = null;
  for (let attempt = 0; !row; attempt++) {
    snapshot.verifyCode = verifyCode(randomBytes(16));
    const contentHash = reportContentHash(snapshot);
    try {
      row = await db().transaction(async (sp) => {
        const [inserted] = await sp
          .insert(reports)
          .values({ labId, orderId, version, status: 'released', snapshot, contentHash, verifyCode: snapshot.verifyCode, releasedBy: userId, releasedAt: now, amendReason: opts.amendReason ?? null })
          .returning();
        return inserted!;
      });
    } catch (err) {
      const pg = err as { code?: string; constraint?: string; cause?: { code?: string } };
      const code = pg.code ?? pg.cause?.code;
      if (code === '23505' && attempt < 4) continue;
      throw err;
    }
  }
  await db()
    .update(reports)
    .set({ status: 'superseded' })
    .where(and(eq(reports.orderId, orderId), ne(reports.id, row.id), eq(reports.status, 'released')));
  publish({ type: 'reports.changed', data: { orderId, reportId: row.id, version } });
  return toVersion(row, await loadUserRefs([row.releasedBy]));
}

/**
 * Release validated results (all of the order's, or the given ones) and issue a new report
 * version. Refused while a critical result has no recorded call.
 */
export async function releaseReport(orderId: string, input: { resultIds?: string[] } = {}, opts: ReleaseOptions = {}): Promise<BenchReportVersion> {
  const now = opts.at ?? new Date();
  const [order] = await db().select({ id: orders.id, status: orders.status, accession: orders.accession }).from(orders).where(eq(orders.id, orderId)).for('update');
  if (!order) throw notFound('order_not_found');
  if (order.status === 'cancelled') throw conflict('order_cancelled', 'The order is cancelled');

  const wanted = input.resultIds?.length ? [...new Set(input.resultIds)] : null;
  const rows = await selectResultRows(
    and(eq(results.orderId, orderId), ne(orderItems.status, 'cancelled'), wanted ? inArray(results.id, wanted) : eq(results.status, 'validated')),
    { forUpdate: true },
  );
  if (wanted) {
    if (rows.length !== wanted.length) throw notFound('result_not_found');
    const notValidated = rows.filter((r) => r.r.status !== 'validated').map((r) => r.r.id);
    if (notValidated.length) throw new AppError(409, 'not_validated', 'Only validated results can be released', { resultIds: notValidated });
  }
  if (!rows.length) throw conflict('nothing_to_release', 'No validated results to release');

  const criticalIds = rows.filter((r) => r.r.isCritical).map((r) => r.r.id);
  if (criticalIds.length) {
    const calls = await db().selectDistinct({ resultId: criticalCalls.resultId }).from(criticalCalls).where(inArray(criticalCalls.resultId, criticalIds));
    const called = new Set(calls.map((c) => c.resultId));
    const missing = criticalIds.filter((id) => !called.has(id));
    if (missing.length) throw new AppError(409, 'critical_call_required', 'Record the call for every critical result before release', { resultIds: missing });
  }

  const ids = rows.map((r) => r.r.id);
  await db().update(results).set({ status: 'released', releasedAt: now, updatedAt: now }).where(inArray(results.id, ids));
  await refreshOrderStatus(orderId);
  const report = await createReportVersion(orderId, { at: now });
  await audit({
    action: 'report.release',
    entityType: 'order',
    entityId: orderId,
    summary: `${order.accession} · report v${report.version} · ${ids.length} results`,
    after: { reportId: report.id, version: report.version, verifyCode: report.verifyCode, contentHash: report.contentHash, resultIds: ids },
  });
  publish({ type: 'results.changed', data: { orderId } });
  return report;
}

export async function getOrderReports(orderId: string, version?: number): Promise<BenchOrderReports> {
  const [o] = await db()
    .select({
      id: orders.id,
      accession: orders.accession,
      status: orders.status,
      deliveredAt: orders.deliveredAt,
      deliveryChannel: orders.deliveryChannel,
      phone: patients.phone,
      email: patients.email,
    })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .where(eq(orders.id, orderId));
  if (!o) throw notFound('order_not_found');
  const [rows, deliveryRows, validated] = await inSequence([
    () => db().select().from(reports).where(eq(reports.orderId, orderId)).orderBy(desc(reports.version)),
    () => db().select().from(deliveries).where(eq(deliveries.orderId, orderId)).orderBy(desc(deliveries.createdAt)),
    () => db()
      .select({ id: results.id, isCritical: results.isCritical })
      .from(results)
      .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
      .where(and(eq(results.orderId, orderId), eq(results.status, 'validated'), ne(orderItems.status, 'cancelled'))),
  ]);
  const chosen = version ? rows.find((r) => r.version === version) : rows[0];
  if (version && !chosen) throw notFound('report_not_found');
  const users = await loadUserRefs([...rows.map((r) => r.releasedBy), ...deliveryRows.map((d) => d.createdBy)]);
  const versionOf = new Map(rows.map((r) => [r.id, r.version]));
  const criticalIds = validated.filter((v) => v.isCritical).map((v) => v.id);
  const called = criticalIds.length
    ? new Set((await db().selectDistinct({ resultId: criticalCalls.resultId }).from(criticalCalls).where(inArray(criticalCalls.resultId, criticalIds))).map((c) => c.resultId))
    : new Set<string>();
  return {
    order: {
      id: o.id,
      accession: o.accession,
      status: o.status,
      deliveredAt: iso(o.deliveredAt),
      deliveryChannel: o.deliveryChannel,
      patientPhone: o.phone,
      patientEmail: o.email,
    },
    report: chosen ? { ...toVersion(chosen, users), snapshot: chosen.snapshot as ReportSnapshot } : null,
    versions: rows.map((r) => toVersion(r, users)),
    deliveries: deliveryRows.map((d) => toDelivery(d, users, versionOf)),
    releasable: { validated: validated.length, criticalUncalled: criticalIds.filter((id) => !called.has(id)).length },
  };
}

export async function getReport(reportId: string): Promise<BenchReportDetail> {
  const [row] = await db().select().from(reports).where(eq(reports.id, reportId));
  if (!row) throw notFound('report_not_found');
  return { ...toVersion(row, await loadUserRefs([row.releasedBy])), snapshot: row.snapshot as ReportSnapshot };
}

/* ------------------------------------------------------------------ links & delivery */

function toDelivery(d: typeof deliveries.$inferSelect, users: Map<string, BenchUserRef>, versionOf: Map<string, number>): BenchDelivery {
  return {
    id: d.id,
    channel: d.channel,
    toAddress: d.toAddress,
    status: d.status,
    note: d.note,
    createdAt: d.createdAt.toISOString(),
    createdBy: d.createdBy ? (users.get(d.createdBy) ?? null) : null,
    reportVersion: d.reportId ? (versionOf.get(d.reportId) ?? null) : null,
  };
}

async function latestReleased(orderId: string) {
  const [row] = await db()
    .select({ id: reports.id, version: reports.version })
    .from(reports)
    .where(and(eq(reports.orderId, orderId), eq(reports.status, 'released')))
    .orderBy(desc(reports.version))
    .limit(1);
  return row ?? null;
}

/** A patient link: 32 random bytes, only the SHA-256 is stored, valid 30 days, opened with the receipt code. */
export async function createReportLink(orderId: string, opts: { days?: number; at?: Date } = {}): Promise<BenchReportLink> {
  const { labId, userId } = ctx();
  const now = opts.at ?? new Date();
  const [o] = await db().select({ id: orders.id, accession: orders.accession }).from(orders).where(eq(orders.id, orderId));
  if (!o) throw notFound('order_not_found');
  if (!(await latestReleased(orderId))) throw conflict('no_report', 'No released report for this order yet');
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + (opts.days ?? LINK_DAYS) * 86_400_000);
  await db().insert(reportTokens).values({ labId, orderId, tokenHash: sha256(token), createdBy: userId, createdAt: now, expiresAt });
  await audit({ action: 'report.link', entityType: 'order', entityId: orderId, summary: `${o.accession} · link valid until ${expiresAt.toISOString().slice(0, 10)}` });
  return { url: `${config.publicUrl}/r/${token}`, expiresAt: expiresAt.toISOString() };
}

/** International digits for wa.me: Syrian local numbers (09…) become 9639…. */
export function whatsappDigits(phone: string): string | null {
  let d = phone.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `963${d.slice(1)}`;
  d = d.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function patientMessage(lab: Lab, firstNameAr: string, firstNameEn: string | null, link: string): { text: string; subject: string } {
  const en = lab.settings.defaultLanguage === 'en';
  if (en) {
    return {
      subject: `${lab.nameEn}: your results are ready`,
      text: `Hello ${firstNameEn || firstNameAr}, your test results from ${lab.nameEn} are ready.\nOpen the link and enter the 6-digit access code printed on your receipt:\n${link}`,
    };
  }
  return {
    subject: `${lab.nameAr}: نتائج تحاليلك جاهزة`,
    text: `مرحباً ${firstNameAr}، نتائج تحاليلك في ${lab.nameAr} جاهزة.\nافتح الرابط وأدخل رمز الدخول المؤلف من 6 أرقام والمطبوع على إيصالك:\n${link}`,
  };
}

/**
 * Hand the report over. WhatsApp returns a wa.me link the desk opens on its own WhatsApp
 * (the business API cannot reach Syrian numbers); SMS and email go through the outbox.
 * Once every test is released, any delivery marks the order as delivered.
 */
export async function deliverReport(orderId: string, input: { channel: BenchDeliveryChannel; to?: string | null }): Promise<BenchDeliverResult> {
  const { labId, userId } = ctx();
  const now = new Date();
  const [row] = await db()
    .select({
      id: orders.id,
      status: orders.status,
      accession: orders.accession,
      phone: patients.phone,
      email: patients.email,
      firstNameAr: patients.firstNameAr,
      firstNameEn: patients.firstNameEn,
    })
    .from(orders)
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .where(eq(orders.id, orderId))
    .for('update', { of: orders });
  if (!row) throw notFound('order_not_found');
  const report = await latestReleased(orderId);
  if (!report) throw conflict('no_report', 'No released report for this order yet');
  const lab = await getLab(labId);
  const to = input.to?.trim() || null;

  let url: string | null = null;
  let link: string | null = null;
  let toAddress: string | null = null;
  let status: BenchDelivery['status'] = 'sent';
  const channel = input.channel;
  if (channel === 'whatsapp' || channel === 'sms') {
    const phone = to ?? row.phone;
    if (!phone) throw badRequest('no_phone', 'The patient has no phone number');
    const digits = whatsappDigits(phone);
    if (!digits) throw badRequest('invalid_phone', 'The phone number is not valid');
    link = (await createReportLink(orderId, { at: now })).url;
    const message = patientMessage(lab, row.firstNameAr, row.firstNameEn, link);
    if (channel === 'whatsapp') {
      url = `https://wa.me/${digits}?text=${encodeURIComponent(message.text)}`;
      toAddress = `+${digits}`;
    } else {
      await queueMessage({ channel: 'sms', toAddress: `+${digits}`, body: message.text, orderId });
      toAddress = `+${digits}`;
      status = config.demoMode ? 'simulated' : 'sent';
    }
  } else if (channel === 'email') {
    const email = to ?? row.email;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('no_email', 'The patient has no valid email address');
    link = (await createReportLink(orderId, { at: now })).url;
    const message = patientMessage(lab, row.firstNameAr, row.firstNameEn, link);
    await queueMessage({ channel: 'email', toAddress: email, subject: message.subject, body: message.text, orderId });
    toAddress = email;
    status = config.demoMode ? 'simulated' : 'sent';
  } else if (channel === 'portal') {
    link = (await createReportLink(orderId, { at: now })).url;
    url = link;
  }

  const [delivery] = await db()
    .insert(deliveries)
    .values({ labId, orderId, reportId: report.id, channel, toAddress, status, createdBy: userId, createdAt: now })
    .returning();
  const orderDelivered = await markDeliveredIfComplete(orderId, now);
  await audit({
    action: 'report.deliver',
    entityType: 'order',
    entityId: orderId,
    summary: `${row.accession} · v${report.version} · ${channel}${toAddress ? ` → ${toAddress}` : ''}`,
    after: { channel, toAddress, status, reportId: report.id },
  });
  publish({ type: 'reports.changed', data: { orderId } });
  const users = await loadUserRefs([userId]);
  return { delivery: toDelivery(delivery!, users, new Map([[report.id, report.version]])), url, link, orderDelivered };
}

/** Completed orders become "delivered" with the first hand-over. */
export async function markDeliveredIfComplete(orderId: string, at = new Date()): Promise<boolean> {
  const updated = await db()
    .update(orders)
    .set({ status: 'delivered', deliveredAt: at, updatedAt: at, version: sql`${orders.version} + 1` })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'completed')))
    .returning({ id: orders.id });
  if (updated.length) publish({ type: 'orders.changed', data: { orderId, status: 'delivered' } });
  return updated.length > 0;
}

/** Orders with a released report, for the delivery desk. Dates apply to the latest release. */
export async function listDeliveries(q: { from?: string; to?: string; status?: 'pending' | 'delivered' | 'all'; q?: string; limit?: number; offset?: number }): Promise<{ items: BenchDeliveryRow[]; total: number }> {
  const { start, end } = await dayRange(q.from, q.to);
  const conds: Array<SQL | undefined> = [eq(reports.status, 'released'), gte(reports.releasedAt, start), lt(reports.releasedAt, end), ne(orders.status, 'cancelled')];
  if (q.status === 'pending') conds.push(ne(orders.status, 'delivered'));
  if (q.status === 'delivered') conds.push(eq(orders.status, 'delivered'));
  if (q.q?.trim()) {
    const raw = q.q.trim();
    const term = normalizeText(raw).replace(/[%_]/g, '');
    conds.push(or(ilike(orders.accession, `${raw.replace(/[%_]/g, '')}%`), ilike(patients.mrn, `${raw.replace(/[%_]/g, '')}%`), term ? ilike(patients.searchText, `%${term}%`) : undefined));
  }
  const where = and(...conds);
  const [rows, [total]] = await inSequence([
    () => db()
      .select({
        rep: { id: reports.id, version: reports.version, releasedAt: reports.releasedAt, verifyCode: reports.verifyCode, partial: sql<boolean>`coalesce((${reports.snapshot}->>'partial')::boolean, false)` },
        o: { ...orderCols, deliveredAt: orders.deliveredAt, deliveryChannel: orders.deliveryChannel },
        p: { ...patientCols, email: patients.email, contactPref: patients.contactPref },
      })
      .from(reports)
      .innerJoin(orders, eq(orders.id, reports.orderId))
      .innerJoin(patients, eq(patients.id, orders.patientId))
      .where(where)
      .orderBy(desc(reports.releasedAt))
      .limit(q.limit ?? 100)
      .offset(q.offset ?? 0),
    () => db().select({ n: count() }).from(reports).innerJoin(orders, eq(orders.id, reports.orderId)).innerJoin(patients, eq(patients.id, orders.patientId)).where(where),
  ]);
  const orderIds = rows.map((r) => r.o.id);
  const deliveryRows = orderIds.length
    ? await db().select().from(deliveries).where(and(inArray(deliveries.orderId, orderIds), isNotNull(deliveries.channel))).orderBy(desc(deliveries.createdAt))
    : [];
  const items: BenchDeliveryRow[] = rows.map((r) => {
    const mine = deliveryRows.filter((d) => d.orderId === r.o.id);
    const lastByChannel: BenchDeliveryRow['lastByChannel'] = {};
    let openedAt: string | null = null;
    for (const d of mine) {
      if (d.status === 'opened') {
        openedAt ??= d.createdAt.toISOString();
        continue;
      }
      lastByChannel[d.channel] ??= { at: d.createdAt.toISOString(), status: d.status };
    }
    return {
      order: { ...orderRef(r.o), deliveredAt: iso(r.o.deliveredAt), deliveryChannel: r.o.deliveryChannel },
      patient: { ...patientRef(r.p), email: r.p.email, contactPref: r.p.contactPref },
      report: { id: r.rep.id, version: r.rep.version, releasedAt: r.rep.releasedAt.toISOString(), verifyCode: r.rep.verifyCode, partial: !!r.rep.partial },
      lastByChannel,
      openedAt,
    };
  });
  return { items, total: Number(total?.n ?? 0) };
}

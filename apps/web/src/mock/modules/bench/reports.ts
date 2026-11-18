/**
 * Reports (port of apps/api/src/modules/reports): a frozen snapshot of everything printed,
 * versioned per order. Releasing validated results creates a new version (content hash +
 * public verify code) and supersedes the previous one. Patient links, delivery by print /
 * WhatsApp / SMS / email / portal, and the delivery desk's list.
 *
 * Mock mode: hashes and tokens use the stand-ins in ./shared (no synchronous sha256 in the
 * browser), links point at this page (publicUrl()), SMS and e-mail are "simulated" in the
 * outbox as on the demo server, and a phone number or e-mail address is never refused for its
 * format. A critical result still needs its call recorded before release.
 */
import { z } from 'zod';
import { benchDeliverInput, benchDeliveriesQuery, benchReleaseInput } from '@natija/contracts';
import type {
  BenchDeliverResult,
  BenchDelivery,
  BenchDeliveryChannel,
  BenchDeliveryRow,
  BenchOrderReports,
  BenchReportDetail,
  BenchReportLink,
  BenchReportVersion,
  ReportLanguage,
  ReportSnapshot,
} from '@natija/contracts';
import { formatAge, verifyCode } from '@natija/domain';
import { AppError, badRequest, conflict, ctx, forbidden, notFound, now, withContext } from '../../core/context';
import { by, find, get, insert, rows, update, type Row } from '../../core/db';
import { audit, dayRange, getLab, parse, publicUrl, publish } from '../../core/lib';
import { route } from '../../core/router';
import { refreshOrderStatus } from '../shared/order-status';
import { queueMessage } from '../shared/outbox';
import {
  anonymous,
  compareResultRows,
  displayValue,
  hash64,
  iso,
  newestFirst,
  orderRef,
  patientRef,
  previousValues,
  randomBytes,
  randomToken,
  resultRowsOf,
  searchFilter,
  tokenHash,
  userRef,
} from './shared';

export type ReleaseOptions = { at?: Date };
const LINK_DAYS = 30;
/** The server's config.demoMode: messages are simulated, not sent. Always on in mock mode. */
const DEMO_MODE = true;

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
  return hash64(canonicalJson(snapshot));
}

/* ------------------------------------------------------------------ snapshot */

/**
 * Everything printed on the report for the order's released results: letterhead, patient,
 * order times, sections per department with previous values, validators, footers and code.
 */
export function buildReportSnapshot(
  orderId: string,
  opts: { version?: number; replacesVersion?: number | null; amendReason?: string | null; verifyCode?: string; releasedAt?: Date } = {},
): ReportSnapshot {
  const lab = getLab();
  const o = find('orders', orderId);
  const p = o ? find('patients', o.patientId) : undefined;
  if (!o || !p) throw notFound('order_not_found');
  const doctor = o.doctorId ? find('doctors', o.doctorId) : undefined;

  const list = resultRowsOf(by('results', 'orderId', orderId)).filter((x) => x.r.status === 'released' && x.item.status !== 'cancelled');
  const deptMap = new Map<string, Row<'departments'>>();
  for (const id of new Set(list.map((x) => x.t.departmentId))) {
    const d = find('departments', id);
    if (d) deptMap.set(id, d);
  }
  const items = by('orderItems', 'orderId', orderId)
    .filter((i) => i.status !== 'cancelled')
    .map((i) => ({ i, t: find('tests', i.testId) }))
    .filter((x): x is { i: Row<'orderItems'>; t: Row<'tests'> } => !!x.t);
  let collectedAt: Date | null = null;
  let receivedAt: Date | null = null;
  for (const s of by('samples', 'orderId', orderId)) {
    if (s.status === 'rejected') continue;
    if (s.collectedAt && (!collectedAt || s.collectedAt < collectedAt)) collectedAt = s.collectedAt;
    if (s.receivedAt && (!receivedAt || s.receivedAt < receivedAt)) receivedAt = s.receivedAt;
  }
  const prev = previousValues(
    list.map((x) => ({ resultId: x.r.id, patientId: x.o.patientId, analyteId: x.a.id, orderId: x.o.id, orderCreatedAt: x.o.createdAt, decimals: x.a.decimals })),
    ['released'],
  );
  list.sort((x, y) => (deptMap.get(x.t.departmentId)?.sortOrder ?? 99) - (deptMap.get(y.t.departmentId)?.sortOrder ?? 99) || compareResultRows(x, y));

  const sections: ReportSnapshot['sections'] = [];
  const validators = new Map<string, Date>();
  let validatedAt: Date | null = null;
  for (const row of list) {
    const dept = deptMap.get(row.t.departmentId);
    let section = sections.find((s) => s.department.code === (dept?.code ?? '-'));
    if (!section) {
      section = { department: { code: dept?.code ?? '-', nameAr: dept?.nameAr ?? '', nameEn: dept?.nameEn ?? '' }, tests: [] };
      sections.push(section);
    }
    let test = section.tests.find((t) => t.code === row.t.code);
    if (!test) {
      const type = row.s ? find('sampleTypes', row.s.sampleTypeId) : undefined;
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
      flag: row.r.flag ?? null,
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
  const pendingTests = items
    .filter((x) => x.i.status !== 'released')
    .sort((x, y) => x.t.sortOrder - y.t.sortOrder)
    .map((x) => ({ code: x.t.code, nameAr: x.t.nameAr, nameEn: x.t.nameEn, status: x.i.status }));
  const releasedAt = opts.releasedAt ?? now();

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
      collectedAt: iso(collectedAt),
      receivedAt: iso(receivedAt),
      validatedAt: iso(validatedAt),
      releasedAt: releasedAt.toISOString(),
      doctor: doctor ? { nameAr: doctor.nameAr, nameEn: doctor.nameEn } : null,
      referralClinic: o.referralClinic,
    },
    sections,
    validators: [...validators.entries()]
      .sort((x, y) => x[1].getTime() - y[1].getTime())
      .map(([id, at]) => {
        const u = userRef(id);
        return { nameAr: u?.fullNameAr ?? '', nameEn: u?.fullNameEn ?? '', title: u?.title ?? null, at: at.toISOString() };
      }),
    footerAr: lab.settings.reportFooterAr ?? null,
    footerEn: lab.settings.reportFooterEn ?? null,
    partial: pendingTests.length > 0,
    pendingTests,
  };
}

/* ------------------------------------------------------------------ versions */

function toVersion(r: Row<'reports'>): BenchReportVersion {
  return {
    id: r.id,
    orderId: r.orderId,
    version: r.version,
    status: r.status,
    releasedAt: r.releasedAt.toISOString(),
    releasedBy: userRef(r.releasedBy),
    amendReason: r.amendReason,
    verifyCode: r.verifyCode,
    contentHash: r.contentHash,
  };
}

/** Verify codes are unique across every lab (the printed QR finds the report without a lab). */
function verifyCodeTaken(code: string): boolean {
  return rows('labs').some((lab) => withContext(anonymous(lab.id), () => by('reports', 'verifyCode', code).length > 0));
}

/**
 * Freeze a new report version from the order's released results: snapshot, content hash and a
 * unique public verify code. The previous version becomes "superseded".
 */
export function createReportVersion(orderId: string, opts: { amendReason?: string | null; at?: Date } = {}): BenchReportVersion {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const existing = by('reports', 'orderId', orderId);
  const previous = existing.reduce((m, r) => Math.max(m, r.version), 0);
  const version = previous + 1;
  const snapshot = buildReportSnapshot(orderId, { version, replacesVersion: previous || null, amendReason: opts.amendReason ?? null, releasedAt: at });
  let code = verifyCode(randomBytes(16));
  for (let attempt = 0; attempt < 4 && verifyCodeTaken(code); attempt++) code = verifyCode(randomBytes(16));
  snapshot.verifyCode = code;
  const row = insert('reports', {
    orderId,
    version,
    status: 'released',
    snapshot,
    contentHash: reportContentHash(snapshot),
    verifyCode: code,
    releasedBy: userId,
    releasedAt: at,
    amendReason: opts.amendReason ?? null,
  });
  for (const r of existing) if (r.status === 'released') update('reports', r, { status: 'superseded' });
  publish({ type: 'reports.changed', data: { orderId, reportId: row.id, version } });
  return toVersion(row);
}

/**
 * Release validated results (all of the order's, or the given ones) and issue a new report
 * version. Refused while a critical result has no recorded call.
 */
export function releaseReport(orderId: string, input: { resultIds?: string[] } = {}, opts: ReleaseOptions = {}): BenchReportVersion {
  const at = opts.at ?? now();
  const order = find('orders', orderId);
  if (!order) throw notFound('order_not_found');
  if (order.status === 'cancelled') throw conflict('order_cancelled', 'The order is cancelled');

  const wanted = input.resultIds?.length ? [...new Set(input.resultIds)] : null;
  const wantedSet = wanted ? new Set(wanted) : null;
  const list = resultRowsOf(by('results', 'orderId', orderId)).filter(
    (x) => x.item.status !== 'cancelled' && (wantedSet ? wantedSet.has(x.r.id) : x.r.status === 'validated'),
  );
  if (wanted) {
    if (list.length !== wanted.length) throw notFound('result_not_found');
    const notValidated = list.filter((x) => x.r.status !== 'validated').map((x) => x.r.id);
    if (notValidated.length) throw new AppError(409, 'not_validated', 'Only validated results can be released', { resultIds: notValidated });
  }
  if (!list.length) throw conflict('nothing_to_release', 'No validated results to release');

  const missing = list.filter((x) => x.r.isCritical && !by('criticalCalls', 'resultId', x.r.id).length).map((x) => x.r.id);
  if (missing.length) throw new AppError(409, 'critical_call_required', 'Record the call for every critical result before release', { resultIds: missing });

  const ids = list.map((x) => x.r.id);
  for (const x of list) update('results', x.r, { status: 'released', releasedAt: at, updatedAt: at });
  refreshOrderStatus(orderId);
  const report = createReportVersion(orderId, { at });
  audit({
    action: 'report.release',
    entityType: 'order',
    entityId: orderId,
    summary: `${order.accession} · report v${report.version} · ${ids.length} results`,
    after: { reportId: report.id, version: report.version, verifyCode: report.verifyCode, contentHash: report.contentHash, resultIds: ids },
  });
  publish({ type: 'results.changed', data: { orderId } });
  return report;
}

function toDelivery(d: Row<'deliveries'>, versionOf: Map<string, number>): BenchDelivery {
  return {
    id: d.id,
    channel: d.channel,
    toAddress: d.toAddress,
    status: d.status,
    note: d.note,
    createdAt: d.createdAt.toISOString(),
    createdBy: userRef(d.createdBy),
    reportVersion: d.reportId ? (versionOf.get(d.reportId) ?? null) : null,
  };
}

export function getOrderReports(orderId: string, version?: number): BenchOrderReports {
  const o = find('orders', orderId);
  const p = o ? find('patients', o.patientId) : undefined;
  if (!o || !p) throw notFound('order_not_found');
  const reportRows = by('reports', 'orderId', orderId).sort((x, y) => y.version - x.version);
  const deliveryRows = newestFirst(by('deliveries', 'orderId', orderId), (d) => d.createdAt);
  const validated = by('results', 'orderId', orderId).filter((r) => {
    if (r.status !== 'validated') return false;
    const item = find('orderItems', r.orderItemId);
    return !!item && item.status !== 'cancelled';
  });
  const chosen = version ? reportRows.find((r) => r.version === version) : reportRows[0];
  if (version && !chosen) throw notFound('report_not_found');
  const versionOf = new Map(reportRows.map((r) => [r.id, r.version]));
  const criticalUncalled = validated.filter((r) => r.isCritical && !by('criticalCalls', 'resultId', r.id).length).length;
  return {
    order: {
      id: o.id,
      accession: o.accession,
      status: o.status,
      deliveredAt: iso(o.deliveredAt),
      deliveryChannel: o.deliveryChannel,
      patientPhone: p.phone,
      patientEmail: p.email,
    },
    report: chosen ? { ...toVersion(chosen), snapshot: chosen.snapshot as ReportSnapshot } : null,
    versions: reportRows.map(toVersion),
    deliveries: deliveryRows.map((d) => toDelivery(d, versionOf)),
    releasable: { validated: validated.length, criticalUncalled },
  };
}

export function getReport(reportId: string): BenchReportDetail {
  const row = get('reports', reportId, 'report_not_found');
  return { ...toVersion(row), snapshot: row.snapshot as ReportSnapshot };
}

/* ------------------------------------------------------------------ links & delivery */

/** The order's newest released report version, if any. */
export function latestReleasedReport(orderId: string): Row<'reports'> | null {
  let best: Row<'reports'> | null = null;
  for (const r of by('reports', 'orderId', orderId)) if (r.status === 'released' && (!best || r.version > best.version)) best = r;
  return best;
}

/** A patient link: 32 random bytes, only the hash is stored, valid 30 days, opened with the receipt code. */
export function createReportLink(orderId: string, opts: { days?: number; at?: Date } = {}): BenchReportLink {
  const { userId } = ctx();
  const at = opts.at ?? now();
  const o = find('orders', orderId);
  if (!o) throw notFound('order_not_found');
  if (!latestReleasedReport(orderId)) throw conflict('no_report', 'No released report for this order yet');
  const token = randomToken(32);
  const expiresAt = new Date(at.getTime() + (opts.days ?? LINK_DAYS) * 86_400_000);
  insert('reportTokens', { orderId, tokenHash: tokenHash(token), createdBy: userId, createdAt: at, expiresAt });
  audit({ action: 'report.link', entityType: 'order', entityId: orderId, summary: `${o.accession} · link valid until ${expiresAt.toISOString().slice(0, 10)}` });
  return { url: `${publicUrl()}/r/${token}`, expiresAt: expiresAt.toISOString() };
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

function patientMessage(lab: Row<'labs'>, firstNameAr: string, firstNameEn: string | null, link: string): { text: string; subject: string } {
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
 * Hand the report over. WhatsApp returns a wa.me link the desk opens on its own WhatsApp;
 * SMS and email go through the outbox (simulated in mock mode). Once every test is released,
 * any delivery marks the order as delivered.
 */
export function deliverReport(orderId: string, input: { channel: BenchDeliveryChannel; to?: string | null }): BenchDeliverResult {
  const { userId } = ctx();
  const at = now();
  const o = find('orders', orderId);
  const p = o ? find('patients', o.patientId) : undefined;
  if (!o || !p) throw notFound('order_not_found');
  const report = latestReleasedReport(orderId);
  if (!report) throw conflict('no_report', 'No released report for this order yet');
  const lab = getLab();
  const to = input.to?.trim() || null;
  const channel: BenchDeliveryChannel = input.channel ?? 'print';

  let url: string | null = null;
  let link: string | null = null;
  let toAddress: string | null = null;
  let status: BenchDelivery['status'] = 'sent';
  if (channel === 'whatsapp' || channel === 'sms') {
    const phone = to ?? p.phone;
    if (!phone) throw badRequest('no_phone', 'The patient has no phone number');
    // Mock mode: a number in an unusual format is used as typed instead of being refused.
    const digits = whatsappDigits(phone) ?? (phone.replace(/\D/g, '') || phone.trim());
    link = createReportLink(orderId, { at }).url;
    const message = patientMessage(lab, p.firstNameAr, p.firstNameEn, link);
    toAddress = `+${digits}`;
    if (channel === 'whatsapp') url = `https://wa.me/${encodeURIComponent(digits)}?text=${encodeURIComponent(message.text)}`;
    else {
      queueMessage({ channel: 'sms', toAddress, body: message.text, orderId });
      status = DEMO_MODE ? 'simulated' : 'sent';
    }
  } else if (channel === 'email') {
    const email = to ?? p.email;
    if (!email) throw badRequest('no_email', 'The patient has no valid email address');
    link = createReportLink(orderId, { at }).url;
    const message = patientMessage(lab, p.firstNameAr, p.firstNameEn, link);
    queueMessage({ channel: 'email', toAddress: email, subject: message.subject, body: message.text, orderId });
    toAddress = email;
    status = DEMO_MODE ? 'simulated' : 'sent';
  } else if (channel === 'portal') {
    link = createReportLink(orderId, { at }).url;
    url = link;
  }

  const delivery = insert('deliveries', { orderId, reportId: report.id, channel, toAddress, status, createdBy: userId, createdAt: at });
  const orderDelivered = markDeliveredIfComplete(orderId, at);
  audit({
    action: 'report.deliver',
    entityType: 'order',
    entityId: orderId,
    summary: `${o.accession} · v${report.version} · ${channel}${toAddress ? ` → ${toAddress}` : ''}`,
    after: { channel, toAddress, status, reportId: report.id },
  });
  publish({ type: 'reports.changed', data: { orderId } });
  return { delivery: toDelivery(delivery, new Map([[report.id, report.version]])), url, link, orderDelivered };
}

/** Completed orders become "delivered" with the first hand-over. */
export function markDeliveredIfComplete(orderId: string, at: Date = now()): boolean {
  const o = find('orders', orderId);
  if (!o || o.status !== 'completed') return false;
  update('orders', o, { status: 'delivered', deliveredAt: at, updatedAt: at, version: o.version + 1 });
  publish({ type: 'orders.changed', data: { orderId, status: 'delivered' } });
  return true;
}

/** Orders with a released report, for the delivery desk. Dates apply to the latest release. */
export function listDeliveries(q: { from?: string; to?: string; status?: 'pending' | 'delivered' | 'all'; q?: string; limit?: number; offset?: number }): {
  items: BenchDeliveryRow[];
  total: number;
} {
  const { start, end } = dayRange(q.from, q.to);
  const match = searchFilter(q.q);
  const found: Array<{ rep: Row<'reports'>; o: Row<'orders'>; p: Row<'patients'> }> = [];
  for (const rep of by('reports', 'status', 'released')) {
    if (rep.releasedAt < start || rep.releasedAt >= end) continue;
    const o = find('orders', rep.orderId);
    const p = o ? find('patients', o.patientId) : undefined;
    if (!o || !p || o.status === 'cancelled') continue;
    if (q.status === 'pending' && o.status === 'delivered') continue;
    if (q.status === 'delivered' && o.status !== 'delivered') continue;
    if (match && !match({ accession: o.accession, mrn: p.mrn, searchText: p.searchText })) continue;
    found.push({ rep, o, p });
  }
  found.sort((x, y) => y.rep.releasedAt.getTime() - x.rep.releasedAt.getTime());
  const offset = q.offset ?? 0;
  const items: BenchDeliveryRow[] = found.slice(offset, offset + (q.limit ?? 100)).map(({ rep, o, p }) => {
    const lastByChannel: BenchDeliveryRow['lastByChannel'] = {};
    let openedAt: string | null = null;
    for (const d of newestFirst(by('deliveries', 'orderId', o.id), (x) => x.createdAt)) {
      if (d.status === 'opened') {
        openedAt ??= d.createdAt.toISOString();
        continue;
      }
      lastByChannel[d.channel] ??= { at: d.createdAt.toISOString(), status: d.status };
    }
    return {
      order: { ...orderRef(o), deliveredAt: iso(o.deliveredAt), deliveryChannel: o.deliveryChannel },
      patient: { ...patientRef(p), email: p.email, contactPref: p.contactPref },
      report: { id: rep.id, version: rep.version, releasedAt: rep.releasedAt.toISOString(), verifyCode: rep.verifyCode, partial: !!(rep.snapshot as Partial<ReportSnapshot> | null)?.partial },
      lastByChannel,
      openedAt,
    };
  });
  return { items, total: found.length };
}

/* ------------------------------------------------------------------ routes (/reports) */

const READ = ['reports.print', 'reports.deliver', 'results.read'];

export function registerReports(): void {
  route('GET', '/reports/deliveries', { perm: 'reports.deliver' }, (req) => listDeliveries(parse(benchDeliveriesQuery, req.query)));

  route('GET', '/reports/orders/:orderId', { perm: READ }, (req) => {
    const { version } = parse(z.object({ version: z.coerce.number().int().min(1).optional() }), req.query);
    return getOrderReports(req.params.orderId!, version);
  });

  /** Release validated results as a new report version (blocked while a critical call is missing). */
  route('POST', '/reports/orders/:orderId/release', { perm: 'results.validate' }, (req) =>
    releaseReport(req.params.orderId!, parse(benchReleaseInput, req.body)),
  );

  route('POST', '/reports/orders/:orderId/link', { perm: 'reports.deliver' }, (req) => createReportLink(req.params.orderId!));

  route('POST', '/reports/orders/:orderId/deliver', { perm: ['reports.deliver', 'reports.print'] }, (req) => {
    const body = parse(benchDeliverInput, req.body);
    const channel = body.channel ?? 'print';
    if (channel !== 'print' && !req.auth!.permissions.has('reports.deliver')) throw forbidden('permission', 'Needs reports.deliver');
    return deliverReport(req.params.orderId!, { channel, to: body.to });
  });

  route('GET', '/reports/:id', { perm: READ }, (req) => getReport(req.params.id!));
}

/**
 * Public pages (no staff session): the patient opens a report with a link + the 6-digit
 * code from the receipt, or from the receipt QR with lab + order number + code; anyone can
 * check a printed report's QR. These run before any lab is known, so lookups go through
 * SECURITY DEFINER functions, then the work continues inside withLab() for that lab.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { deliveries, labs, orders, reports, reportTokens, type Lab } from '@natija/db';
import type { PublicLabBranding, PublicReport, PublicReportInfo, PublicVerifyResult, ReportSnapshot } from '@natija/contracts';
import { appDb, ctx, db, withLab } from '../../db';
import { audit } from '../../lib/audit';
import { hmac, safeEqual, sha256 } from '../../lib/crypto';
import { AppError, notFound } from '../../lib/errors';
import { publish } from '../../lib/events';
import { getLab } from '../../lib/lab';
import { markDeliveredIfComplete } from '../reports/service';

export const MAX_CODE_ATTEMPTS = 5;
/** Receipt-QR lookups (no secret link) unlock again after this long. */
const LOOKUP_LOCK_MINUTES = 15;
const VERIFY_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/;

export type RequestMeta = { ip: string | null; userAgent: string | null };
type Outcome = { report: PublicReport } | { error: 'link_invalid' | 'link_locked' | 'wrong_code' | 'lookup_failed' | 'report_not_ready'; attemptsLeft?: number };

export function branding(lab: Lab): PublicLabBranding {
  return {
    code: lab.code,
    nameAr: lab.nameAr,
    nameEn: lab.nameEn,
    taglineAr: lab.taglineAr,
    taglineEn: lab.taglineEn,
    logoSvg: lab.logoSvg,
    brandColor: lab.brandColor,
    phone: lab.phone,
    addressAr: lab.addressAr,
    addressEn: lab.addressEn,
    demo: lab.settings.demo === true,
  };
}

function raise(outcome: Exclude<Outcome, { report: PublicReport }>): never {
  switch (outcome.error) {
    case 'link_invalid':
      throw notFound('link_invalid', 'This link is not valid');
    case 'link_locked':
      throw new AppError(423, 'link_locked', 'Too many wrong codes. Ask the lab for a new link.');
    case 'wrong_code':
      throw new AppError(403, 'wrong_code', 'The access code is not correct', { attemptsLeft: [String(outcome.attemptsLeft ?? 0)] });
    case 'report_not_ready':
      throw notFound('report_not_ready', 'The report is not ready yet');
    default:
      throw new AppError(403, 'lookup_failed', 'The order number or the access code is not correct');
  }
}

async function resolveToken(token: string) {
  const res = await appDb.execute(sql`select * from public_resolve_report_token(${sha256(token)})`);
  return (res.rows[0] as { lab_id: string; order_id: string; token_id: string; expired: boolean; revoked: boolean } | undefined) ?? null;
}

async function activeLab(labId: string): Promise<Lab | null> {
  const lab = await getLab(labId).catch(() => null);
  return lab && lab.status === 'active' ? lab : null;
}

/** Inside the lab context: the latest released version, logged as opened by the patient. */
async function openLatest(orderId: string, accession: string, via: 'link' | 'receipt'): Promise<PublicReport | null> {
  const { labId } = ctx();
  const [rep] = await db()
    .select()
    .from(reports)
    .where(and(eq(reports.orderId, orderId), eq(reports.status, 'released')))
    .orderBy(desc(reports.version))
    .limit(1);
  if (!rep) return null;
  await db().insert(deliveries).values({ labId, orderId, reportId: rep.id, channel: 'portal', status: 'opened', note: via });
  await markDeliveredIfComplete(orderId);
  await audit({ action: 'report.opened', entityType: 'order', entityId: orderId, summary: `${accession} · v${rep.version} opened by the patient (${via})` });
  publish({ type: 'reports.changed', data: { orderId } });
  const lab = await getLab(labId);
  return {
    lab: branding(lab),
    version: rep.version,
    releasedAt: rep.releasedAt.toISOString(),
    verifyCode: rep.verifyCode,
    contentHash: rep.contentHash,
    snapshot: rep.snapshot as ReportSnapshot,
  };
}

/** Lab branding behind a link, shown while the patient types the code. */
export async function reportInfo(token: string): Promise<PublicReportInfo> {
  const t = await resolveToken(token);
  if (!t) throw notFound('link_invalid', 'This link is not valid');
  if (t.expired || t.revoked) throw new AppError(410, 'link_expired', 'This link has expired');
  const lab = await activeLab(t.lab_id);
  if (!lab) throw notFound('link_invalid', 'This link is not valid');
  return { lab: branding(lab) };
}

export async function labBranding(code: string): Promise<PublicLabBranding> {
  const [lab] = await appDb.select().from(labs).where(eq(labs.code, code.trim().toLowerCase()));
  if (!lab || lab.status !== 'active') throw notFound('not_found');
  return branding(lab);
}

/** Link + 6-digit code. Five wrong codes lock the link for good (the lab can send a new one). */
export async function openReportByToken(token: string, code: string, meta: RequestMeta): Promise<PublicReport> {
  const t = await resolveToken(token);
  if (!t) throw notFound('link_invalid', 'This link is not valid');
  if (t.expired || t.revoked) throw new AppError(410, 'link_expired', 'This link has expired');
  if (!(await activeLab(t.lab_id))) throw notFound('link_invalid', 'This link is not valid');
  const outcome = await withLab<Outcome>(t.lab_id, { actorName: 'Patient portal', ip: meta.ip, userAgent: meta.userAgent }, async () => {
    const [row] = await db()
      .select({ failed: reportTokens.failedAttempts, orderId: orders.id, accession: orders.accession, portalCode: orders.portalCode, status: orders.status })
      .from(reportTokens)
      .innerJoin(orders, eq(orders.id, reportTokens.orderId))
      .where(eq(reportTokens.id, t.token_id))
      .for('update', { of: reportTokens });
    if (!row || row.status === 'cancelled') return { error: 'link_invalid' };
    if (row.failed >= MAX_CODE_ATTEMPTS) return { error: 'link_locked' };
    if (!safeEqual(code, row.portalCode)) {
      const failed = row.failed + 1;
      await db().update(reportTokens).set({ failedAttempts: failed }).where(eq(reportTokens.id, t.token_id));
      await audit({ action: 'portal.wrong_code', entityType: 'order', entityId: row.orderId, summary: `${row.accession} · link · attempt ${failed}/${MAX_CODE_ATTEMPTS}` });
      return failed >= MAX_CODE_ATTEMPTS ? { error: 'link_locked' } : { error: 'wrong_code', attemptsLeft: MAX_CODE_ATTEMPTS - failed };
    }
    await db()
      .update(reportTokens)
      .set({ uses: sql`${reportTokens.uses} + 1`, lastUsedAt: new Date() })
      .where(eq(reportTokens.id, t.token_id));
    const report = await openLatest(row.orderId, row.accession, 'link');
    return report ? { report } : { error: 'report_not_ready' };
  });
  if ('error' in outcome) raise(outcome);
  return outcome.report;
}

/**
 * Receipt QR: lab code + order number + code. Wrong attempts are counted per order (in a
 * report_tokens row keyed by an HMAC that no link token can hash to); five lock the lookup
 * for 15 minutes. Unknown orders and wrong codes get the same answer.
 */
export async function lookupReport(labCode: string, accession: string, code: string, meta: RequestMeta): Promise<PublicReport> {
  const [lab] = await appDb.select({ id: labs.id, status: labs.status }).from(labs).where(eq(labs.code, labCode.trim().toLowerCase()));
  if (!lab || lab.status !== 'active') {
    safeEqual(code, '000000');
    raise({ error: 'lookup_failed' });
  }
  const outcome = await withLab<Outcome>(lab.id, { actorName: 'Patient portal', ip: meta.ip, userAgent: meta.userAgent }, async () => {
    const { labId } = ctx();
    const [o] = await db()
      .select({ id: orders.id, accession: orders.accession, portalCode: orders.portalCode, status: orders.status })
      .from(orders)
      .where(eq(orders.accession, accession.trim()));
    if (!o || o.status === 'cancelled') {
      safeEqual(code, '000000');
      return { error: 'lookup_failed' };
    }
    const now = new Date();
    const tokenHash = hmac(`portal-lookup:${o.id}`);
    let [tok] = await db().select().from(reportTokens).where(eq(reportTokens.tokenHash, tokenHash)).for('update');
    if (!tok) {
      [tok] = await db()
        .insert(reportTokens)
        .values({ labId, orderId: o.id, tokenHash, expiresAt: new Date(now.getTime() + 3650 * 86_400_000) })
        .returning();
    }
    let failed = tok!.failedAttempts;
    const windowStart = now.getTime() - LOOKUP_LOCK_MINUTES * 60_000;
    if (failed > 0 && tok!.lastUsedAt && tok!.lastUsedAt.getTime() < windowStart) failed = 0;
    if (failed >= MAX_CODE_ATTEMPTS) return { error: 'link_locked' };
    if (!safeEqual(code, o.portalCode)) {
      failed += 1;
      await db().update(reportTokens).set({ failedAttempts: failed, lastUsedAt: now }).where(eq(reportTokens.id, tok!.id));
      await audit({ action: 'portal.wrong_code', entityType: 'order', entityId: o.id, summary: `${o.accession} · receipt · attempt ${failed}/${MAX_CODE_ATTEMPTS}` });
      return failed >= MAX_CODE_ATTEMPTS ? { error: 'link_locked' } : { error: 'lookup_failed' };
    }
    await db()
      .update(reportTokens)
      .set({ failedAttempts: 0, uses: sql`${reportTokens.uses} + 1`, lastUsedAt: now })
      .where(eq(reportTokens.id, tok!.id));
    const report = await openLatest(o.id, o.accession, 'receipt');
    return report ? { report } : { error: 'report_not_ready' };
  });
  if ('error' in outcome) raise(outcome);
  return outcome.report;
}

/** "Is this printed report genuine?" Never returns results or the patient's name. */
export async function verifyReport(code: string): Promise<PublicVerifyResult> {
  const normalized = code.trim().toUpperCase();
  if (!VERIFY_CODE.test(normalized)) return { status: 'not_found' };
  const res = await appDb.execute(sql`select * from public_verify_report(${normalized})`);
  const row = res.rows[0] as
    | {
        lab_name_ar: string;
        lab_name_en: string;
        lab_code: string;
        order_accession: string;
        report_version: number;
        released_at: string | Date;
        report_status: string;
        content_hash: string;
        patient_initials: string;
        test_count: number;
        latest_version: number;
      }
    | undefined;
  if (!row) return { status: 'not_found' };
  const [lab] = await appDb.select({ logoSvg: labs.logoSvg, brandColor: labs.brandColor }).from(labs).where(eq(labs.code, row.lab_code));
  return {
    status: row.report_status === 'released' ? 'genuine' : 'superseded',
    lab: { code: row.lab_code, nameAr: row.lab_name_ar, nameEn: row.lab_name_en, logoSvg: lab?.logoSvg ?? null, brandColor: lab?.brandColor ?? '#2347B0' },
    accession: row.order_accession,
    version: Number(row.report_version),
    latestVersion: Number(row.latest_version),
    releasedAt: new Date(row.released_at).toISOString(),
    patientInitials: row.patient_initials,
    testCount: Number(row.test_count),
    contentHash: row.content_hash,
  };
}

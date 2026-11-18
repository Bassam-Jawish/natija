/**
 * Public pages, no staff session (port of apps/api/src/modules/public): the patient opens a
 * report with a link + the code from the receipt, or from the receipt QR with lab + order
 * number + code; anyone can check a printed report's QR. These arrive before any lab is known,
 * so the lab is found across labs first, then the work runs inside that lab's context.
 *
 * Mock mode: any access code opens the report, so wrong codes are never counted and links never
 * lock. An unknown lab code on the receipt lookup still finds the order in any demo lab.
 */
import { publicReportInfoInput, publicReportLookupInput, publicReportOpenInput } from '@natija/contracts';
import type { PublicLabBranding, PublicReport, PublicReportInfo, PublicVerifyResult, ReportSnapshot } from '@natija/contracts';
import { AppError, notFound, now, withContext } from '../../core/context';
import { by, find, insert, rows, update, type Row } from '../../core/db';
import { audit, getLab, parse, publish } from '../../core/lib';
import { route } from '../../core/router';
import { latestReleasedReport, markDeliveredIfComplete } from './reports';
import { anonymous, hash64, inAnyLab, tokenHash } from './shared';

export const MAX_CODE_ATTEMPTS = 5;
const PORTAL = 'Patient portal';

export type RequestMeta = { ip: string | null; userAgent: string | null };
type Outcome = { report: PublicReport } | { error: 'link_invalid' | 'link_locked' | 'wrong_code' | 'lookup_failed' | 'report_not_ready'; attemptsLeft?: number };

export function branding(lab: Row<'labs'>): PublicLabBranding {
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

/** Run as the patient portal inside a lab (no user; the audit log names the portal). */
function asPortal<T>(labId: string, fn: () => T): T {
  return withContext(anonymous(labId, PORTAL), fn);
}

function resolveToken(token: string): { labId: string; orderId: string; tokenId: string; expired: boolean; revoked: boolean } | null {
  const hash = tokenHash(token);
  const t = inAnyLab(() => by('reportTokens', 'tokenHash', hash)[0]);
  if (!t) return null;
  return { labId: t.labId, orderId: t.orderId, tokenId: t.id, expired: t.expiresAt.getTime() < now().getTime(), revoked: t.revokedAt !== null };
}

function activeLab(labId: string): Row<'labs'> | null {
  const lab = rows('labs').find((l) => l.id === labId);
  return lab && lab.status === 'active' ? lab : null;
}

/** Inside the lab context: the latest released version, logged as opened by the patient. */
function openLatest(orderId: string, accession: string, via: 'link' | 'receipt'): PublicReport | null {
  const rep = latestReleasedReport(orderId);
  if (!rep) return null;
  insert('deliveries', { orderId, reportId: rep.id, channel: 'portal', status: 'opened', note: via });
  markDeliveredIfComplete(orderId);
  audit({ action: 'report.opened', entityType: 'order', entityId: orderId, summary: `${accession} · v${rep.version} opened by the patient (${via})` });
  publish({ type: 'reports.changed', data: { orderId } });
  return {
    lab: branding(getLab()),
    version: rep.version,
    releasedAt: rep.releasedAt.toISOString(),
    verifyCode: rep.verifyCode,
    contentHash: rep.contentHash,
    snapshot: rep.snapshot as ReportSnapshot,
  };
}

/** Lab branding behind a link, shown while the patient types the code. */
export function reportInfo(token: string): PublicReportInfo {
  const t = resolveToken(token ?? '');
  if (!t) throw notFound('link_invalid', 'This link is not valid');
  if (t.expired || t.revoked) throw new AppError(410, 'link_expired', 'This link has expired');
  const lab = activeLab(t.labId);
  if (!lab) throw notFound('link_invalid', 'This link is not valid');
  return { lab: branding(lab) };
}

export function labBranding(code: string): PublicLabBranding {
  const lab = rows('labs').find((l) => l.code === (code ?? '').trim().toLowerCase());
  if (!lab || lab.status !== 'active') throw notFound('not_found');
  return branding(lab);
}

/** Link + access code. Mock mode accepts any code, so the link's lockout never comes into play. */
export function openReportByToken(token: string, _code: string, _meta: RequestMeta = { ip: null, userAgent: null }): PublicReport {
  const t = resolveToken(token ?? '');
  if (!t) throw notFound('link_invalid', 'This link is not valid');
  if (t.expired || t.revoked) throw new AppError(410, 'link_expired', 'This link has expired');
  if (!activeLab(t.labId)) throw notFound('link_invalid', 'This link is not valid');
  const outcome = asPortal<Outcome>(t.labId, () => {
    const tok = find('reportTokens', t.tokenId);
    const o = tok ? find('orders', tok.orderId) : undefined;
    if (!tok || !o || o.status === 'cancelled') return { error: 'link_invalid' };
    update('reportTokens', tok, { uses: tok.uses + 1, lastUsedAt: now() });
    const report = openLatest(o.id, o.accession, 'link');
    return report ? { report } : { error: 'report_not_ready' };
  });
  if ('error' in outcome) raise(outcome);
  return outcome.report;
}

/**
 * Receipt QR: lab code + order number + code. The server counts wrong codes per order in a
 * report_tokens row; mock mode accepts any code, so that row only counts the openings.
 */
export function lookupReport(labCode: string, accession: string, _code: string, _meta: RequestMeta = { ip: null, userAgent: null }): PublicReport {
  const labs = rows('labs').filter((l) => l.status === 'active');
  const wantedLab = (labCode ?? '').trim().toLowerCase();
  const number = (accession ?? '').trim();
  const known = labs.find((l) => l.code === wantedLab);
  const target = (known ? [known] : labs)
    .map((lab) => withContext(anonymous(lab.id), () => by('orders', 'accession', number)[0]))
    .find((o): o is Row<'orders'> => !!o);
  if (!target) raise({ error: 'lookup_failed' });
  const outcome = asPortal<Outcome>(target.labId, () => {
    const o = find('orders', target.id);
    if (!o || o.status === 'cancelled') return { error: 'lookup_failed' };
    const hash = hash64(`portal-lookup:${o.id}`);
    const tok =
      by('reportTokens', 'tokenHash', hash)[0] ?? insert('reportTokens', { orderId: o.id, tokenHash: hash, expiresAt: new Date(now().getTime() + 3650 * 86_400_000) });
    update('reportTokens', tok, { failedAttempts: 0, uses: tok.uses + 1, lastUsedAt: now() });
    const report = openLatest(o.id, o.accession, 'receipt');
    return report ? { report } : { error: 'report_not_ready' };
  });
  if ('error' in outcome) raise(outcome);
  return outcome.report;
}

function firstLetter(text: string | null | undefined): string {
  return Array.from(text ?? '')[0] ?? '';
}

/** "Is this printed report genuine?" Never returns results or the patient's name. */
export function verifyReport(code: string): PublicVerifyResult {
  const normalized = (code ?? '').trim().toUpperCase();
  if (!normalized) return { status: 'not_found' };
  const rep = inAnyLab(() => by('reports', 'verifyCode', normalized)[0]);
  if (!rep) return { status: 'not_found' };
  const lab = rows('labs').find((l) => l.id === rep.labId);
  return withContext(anonymous(rep.labId), (): PublicVerifyResult => {
    const o = find('orders', rep.orderId);
    const p = o ? find('patients', o.patientId) : undefined;
    if (!o || !p || !lab) return { status: 'not_found' };
    return {
      status: rep.status === 'released' ? 'genuine' : 'superseded',
      lab: { code: lab.code, nameAr: lab.nameAr, nameEn: lab.nameEn, logoSvg: lab.logoSvg ?? null, brandColor: lab.brandColor ?? '#2347B0' },
      accession: o.accession,
      version: rep.version,
      latestVersion: by('reports', 'orderId', o.id).reduce((m, r) => Math.max(m, r.version), rep.version),
      releasedAt: rep.releasedAt.toISOString(),
      patientInitials: `${firstLetter(p.firstNameAr)}. ${firstLetter(p.lastNameAr)}.`,
      testCount: by('orderItems', 'orderId', o.id).filter((i) => i.status === 'released').length,
      contentHash: rep.contentHash,
    };
  });
}

/* ------------------------------------------------------------------ routes (/public) */

export function registerPublic(): void {
  route('POST', '/public/report/info', { public: true }, (req) => reportInfo(parse(publicReportInfoInput, req.body).token));

  route('POST', '/public/report/open', { public: true }, (req) => {
    const body = parse(publicReportOpenInput, req.body);
    return openReportByToken(body.token, body.code);
  });

  route('POST', '/public/report/lookup', { public: true }, (req) => {
    const body = parse(publicReportLookupInput, req.body);
    return lookupReport(body.labCode, body.accession, body.code);
  });

  route('GET', '/public/labs/:code', { public: true }, (req) => labBranding(req.params.code ?? ''));

  route('GET', '/public/verify/:code', { public: true }, (req) => verifyReport(req.params.code ?? ''));
}

import { and, ilike, type SQL } from 'drizzle-orm';
import { patients, type Patient } from '@natija/db';
import { buildSearchText, normalizeText } from '@natija/domain';
import type { PatientSummary } from '@natija/contracts';

/** Digits of a phone number, plus its last nine (so 0944…, +963 944… and 944… all match). */
function phoneTokens(phone: string | null | undefined): string[] {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return [];
  return digits.length > 9 ? [digits, digits.slice(-9)] : [digits];
}

/** Normalised Arabic + Latin names, phone, MRN and national ID: what search and duplicate checks look at. */
export function patientSearchText(p: {
  fullNameAr: string;
  fullNameEn?: string | null;
  phone?: string | null;
  mrn: string;
  nationalId?: string | null;
}): string {
  return buildSearchText([p.fullNameAr, p.fullNameEn, p.mrn, p.nationalId, ...phoneTokens(p.phone)]);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Search condition over patients.search_text. A number (phone, MRN digits) matches on its last
 * nine digits; words must all appear, after Arabic normalisation (hamza, taa marbuta, diacritics).
 */
export function patientSearchCondition(q: string): SQL | undefined {
  const raw = q.trim();
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, '');
  const compact = raw.replace(/[\s()+\-.]/g, '');
  if (digits.length >= 4 && digits.length === compact.length) {
    const tail = digits.length > 9 ? digits.slice(-9) : digits;
    return ilike(patients.searchText, `%${escapeLike(tail)}%`);
  }
  const tokens = normalizeText(raw).split(' ').filter(Boolean).slice(0, 6);
  if (!tokens.length) return undefined;
  return and(...tokens.map((t) => ilike(patients.searchText, `%${escapeLike(t)}%`)));
}

export function toSummary(p: Pick<Patient, 'id' | 'mrn' | 'fullNameAr' | 'fullNameEn' | 'sex' | 'birthDate' | 'birthDateEstimated' | 'phone'>): PatientSummary {
  return {
    id: p.id,
    mrn: p.mrn,
    fullNameAr: p.fullNameAr,
    fullNameEn: p.fullNameEn,
    sex: p.sex,
    birthDate: p.birthDate,
    birthDateEstimated: p.birthDateEstimated,
    phone: p.phone,
  };
}

export { escapeLike };

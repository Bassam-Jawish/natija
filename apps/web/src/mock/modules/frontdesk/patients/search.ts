/**
 * Patient search (port of apps/api/src/modules/patients/search.ts): the normalised search text
 * kept on each patient, the search condition (here a predicate instead of SQL) and the summary
 * shape every list shows.
 */
import { buildSearchText, normalizeText } from '@natija/domain';
import type { PatientSummary } from '@natija/contracts';
import type { Row } from '../../../core/db';

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

/** ILIKE '%term%': case-insensitive "contains". */
export function contains(text: string | null | undefined, term: string): boolean {
  return (text ?? '').toLowerCase().includes(term.toLowerCase());
}

/**
 * Search condition over patients.searchText. A number (phone, MRN digits) matches on its last
 * nine digits; words must all appear, after Arabic normalisation (hamza, taa marbuta, diacritics).
 * Undefined when the query has nothing to search for (like the server's SQL condition).
 */
export function patientSearchCondition(q: string): ((p: Pick<Row<'patients'>, 'searchText'>) => boolean) | undefined {
  const raw = q.trim();
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, '');
  const compact = raw.replace(/[\s()+\-.]/g, '');
  if (digits.length >= 4 && digits.length === compact.length) {
    const tail = digits.length > 9 ? digits.slice(-9) : digits;
    return (p) => contains(p.searchText, tail);
  }
  const tokens = normalizeText(raw).split(' ').filter(Boolean).slice(0, 6);
  if (!tokens.length) return undefined;
  return (p) => tokens.every((t) => contains(p.searchText, t));
}

export function toSummary(p: Pick<Row<'patients'>, 'id' | 'mrn' | 'fullNameAr' | 'fullNameEn' | 'sex' | 'birthDate' | 'birthDateEstimated' | 'phone'>): PatientSummary {
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

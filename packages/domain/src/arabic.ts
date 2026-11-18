/**
 * Arabic-aware normalisation for search and duplicate detection: strips diacritics and tatweel,
 * unifies alef/hamza forms, taa marbuta, alef maqsura, and Arabic-Indic digits.
 */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSearchText(parts: Array<string | null | undefined>): string {
  return normalizeText(parts.filter(Boolean).join(' '));
}

/** Full Arabic name in Syrian order: first, father, family. The mother's name is stored separately. */
export function joinName(...parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

function tokens(s: string): string[] {
  return normalizeText(s).split(' ').filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** 0..1 similarity between two names, tolerant of spelling variants and missing middle names. */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  let matched = 0;
  const used = new Set<number>();
  for (const x of ta) {
    let bestJ = -1;
    let best = 0;
    tb.forEach((y, j) => {
      if (used.has(j)) return;
      const sim = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
      if (sim > best) {
        best = sim;
        bestJ = j;
      }
    });
    if (bestJ >= 0 && best >= 0.75) {
      used.add(bestJ);
      matched += best;
    }
  }
  return matched / Math.max(ta.length, tb.length);
}

export type DuplicateCandidate = {
  fullNameAr: string;
  birthDate: string;
  sex: 'male' | 'female';
  phone?: string | null;
};

/** Score how likely two records are the same person, with human-readable reasons. */
export function duplicateScore(a: DuplicateCandidate, b: DuplicateCandidate): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const sim = nameSimilarity(a.fullNameAr, b.fullNameAr);
  if (sim >= 0.6) {
    score += sim * 60;
    reasons.push('name');
  }
  if (a.birthDate.slice(0, 4) === b.birthDate.slice(0, 4)) {
    score += a.birthDate === b.birthDate ? 25 : 15;
    reasons.push('birth');
  }
  if (a.sex === b.sex) score += 5;
  else score -= 30;
  const pa = (a.phone ?? '').replace(/\D/g, '').slice(-9);
  const pb = (b.phone ?? '').replace(/\D/g, '').slice(-9);
  if (pa && pa === pb) {
    score += 30;
    reasons.push('phone');
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

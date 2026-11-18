/**
 * Westgard rules on a QC series (oldest first). The newest value is the one being judged.
 * 1-2s is a warning; 1-3s, 2-2s, R-4s, 4-1s and 10x reject the run.
 */
export function westgard(values: number[], mean: number, sd: number): { status: 'accepted' | 'warning' | 'rejected'; violations: string[] } {
  if (!values.length || sd <= 0) return { status: 'accepted', violations: [] };
  const z = values.map((v) => (v - mean) / sd);
  const last = z[z.length - 1]!;
  const violations: string[] = [];

  if (Math.abs(last) > 3) violations.push('1-3s');

  const last2 = z.slice(-2);
  if (last2.length === 2 && ((last2[0]! > 2 && last2[1]! > 2) || (last2[0]! < -2 && last2[1]! < -2))) violations.push('2-2s');
  if (last2.length === 2 && ((last2[0]! > 2 && last2[1]! < -2) || (last2[0]! < -2 && last2[1]! > 2))) violations.push('R-4s');

  const last4 = z.slice(-4);
  if (last4.length === 4 && (last4.every((x) => x > 1) || last4.every((x) => x < -1))) violations.push('4-1s');

  const last10 = z.slice(-10);
  if (last10.length === 10 && (last10.every((x) => x > 0) || last10.every((x) => x < 0))) violations.push('10x');

  if (violations.length) return { status: 'rejected', violations };
  if (Math.abs(last) > 2) return { status: 'warning', violations: ['1-2s'] };
  return { status: 'accepted', violations: [] };
}

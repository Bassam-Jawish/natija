import { describe, expect, it } from 'vitest';
import {
  accessionFor,
  ageInDays,
  birthDateFromAge,
  dateKey,
  deltaExceeded,
  deriveItemStatus,
  deriveOrderStatus,
  distributePackagePrice,
  duplicateScore,
  evaluateFormula,
  flagNumeric,
  flagText,
  formatAge,
  formatRange,
  formulaVariables,
  groupIntoTubes,
  invoiceStatus,
  nameSimilarity,
  normalizeText,
  parseNumericValue,
  priceTest,
  ROLE_TEMPLATES,
  ALL_PERMISSIONS,
  selectRange,
  splitLine,
  tubeBarcode,
  validateFormula,
  westgard,
  type RangeRow,
} from './index';

const r = (p: Partial<RangeRow>): RangeRow => ({
  sex: 'any',
  ageMinDays: 0,
  ageMaxDays: null,
  low: null,
  high: null,
  criticalLow: null,
  criticalHigh: null,
  textRange: null,
  ...p,
});

describe('reference ranges and flags', () => {
  const hgb = [
    r({ ageMaxDays: 30, low: 14.5, high: 22.5 }),
    r({ sex: 'male', ageMinDays: 4381, low: 13.5, high: 17.5, criticalLow: 7, criticalHigh: 20 }),
    r({ sex: 'female', ageMinDays: 4381, low: 12, high: 15.5, criticalLow: 7, criticalHigh: 20 }),
  ];

  it('picks the range for sex and age', () => {
    expect(selectRange(hgb, { sex: 'female', ageDays: 30 * 365 })?.low).toBe(12);
    expect(selectRange(hgb, { sex: 'male', ageDays: 30 * 365 })?.low).toBe(13.5);
    expect(selectRange(hgb, { sex: 'male', ageDays: 10 })?.low).toBe(14.5);
    expect(selectRange(hgb, { sex: 'male', ageDays: 400 })).toBeNull();
  });

  it('prefers a specimen-specific range', () => {
    const ranges = [r({ low: 70, high: 100 }), r({ low: 40, high: 70, sampleTypeId: 'csf' })];
    expect(selectRange(ranges, { sex: 'male', ageDays: 9000, sampleTypeId: 'csf' })?.low).toBe(40);
    expect(selectRange(ranges, { sex: 'male', ageDays: 9000, sampleTypeId: 'serum' })?.low).toBe(70);
  });

  it('flags normal, low, high and critical values with inclusive normal limits', () => {
    const range = hgb[2]!;
    expect(flagNumeric(12, range)).toEqual({ flag: 'N', isCritical: false });
    expect(flagNumeric(15.5, range)).toEqual({ flag: 'N', isCritical: false });
    expect(flagNumeric(11.9, range)).toEqual({ flag: 'L', isCritical: false });
    expect(flagNumeric(16, range)).toEqual({ flag: 'H', isCritical: false });
    expect(flagNumeric(6.5, range)).toEqual({ flag: 'LL', isCritical: true });
    expect(flagNumeric(21, range)).toEqual({ flag: 'HH', isCritical: true });
    expect(flagNumeric(null, range).flag).toBeNull();
  });

  it('flags one-sided ranges (HDL only has a lower limit)', () => {
    expect(flagNumeric(35, r({ low: 40 })).flag).toBe('L');
    expect(flagNumeric(65, r({ low: 40 })).flag).toBe('N');
  });

  it('flags text results against the expected answers', () => {
    expect(flagText('Negative', r({ textRange: 'Negative' }))).toBe('N');
    expect(flagText('Positive', r({ textRange: 'Negative' }))).toBe('A');
    expect(flagText('Pale yellow', r({ textRange: 'Yellow/Pale yellow' }))).toBe('N');
    expect(flagText('Red', r({ textRange: 'Yellow/Pale yellow' }))).toBe('A');
  });

  it('parses values typed at the bench or sent by analyzers', () => {
    expect(parseNumericValue('5,4')).toEqual({ value: 5.4, qualifier: null });
    expect(parseNumericValue('< 0.5')).toEqual({ value: 0.5, qualifier: '<' });
    expect(parseNumericValue('٧٫٢')).toEqual({ value: 7.2, qualifier: null });
    expect(parseNumericValue('Hemolyzed')).toEqual({ value: null, qualifier: null });
  });

  it('formats ranges', () => {
    expect(formatRange(r({ low: 13.5, high: 17.5 }), 1)).toBe('13.5 – 17.5');
    expect(formatRange(r({ high: 200 }), 0)).toBe('< 200');
    expect(formatRange(r({ low: 40 }), 0)).toBe('> 40');
  });

  it('detects large changes from the previous result', () => {
    expect(deltaExceeded(9, 13, 20)).toBe(true);
    expect(deltaExceeded(12.5, 13, 20)).toBe(false);
    expect(deltaExceeded(12, null, 20)).toBe(false);
  });
});

describe('ages', () => {
  const at = new Date('2026-11-17T10:00:00Z');
  it('derives an estimated birth date from an age entered at the desk', () => {
    expect(birthDateFromAge(34, 'years', at)).toBe('1992-01-01');
    expect(birthDateFromAge(3, 'months', at)).toBe('2026-08-17');
    expect(birthDateFromAge(10, 'days', at)).toBe('2026-11-07');
  });
  it('formats ages for adults, infants and newborns', () => {
    expect(formatAge('1990-05-01', 'en', at)).toBe('36 y');
    expect(formatAge('2026-05-01', 'ar', at)).toBe('6 شهر');
    expect(formatAge('2026-11-10', 'en', at)).toBe('7 d');
    expect(ageInDays('2026-11-10', at)).toBe(7);
  });
});

describe('pricing', () => {
  const publicPayer = { unitPrice: 40, patientSharePct: 100, discountPct: 0 };
  const insurer = { unitPrice: 50, patientSharePct: 20, discountPct: 0 };
  it('prices tests in units, with fixed prices and payer overrides winning', () => {
    expect(priceTest({ units: 25 }, publicPayer).price).toBe(1000);
    expect(priceTest({ units: 25, fixedPrice: 900 }, publicPayer).price).toBe(900);
    expect(priceTest({ units: 25, fixedPrice: 900, overridePrice: 750 }, publicPayer).price).toBe(750);
  });
  it('splits insurer plans into patient and insurer shares', () => {
    const line = splitLine(1250, insurer);
    expect(line).toMatchObject({ net: 1250, patientShare: 250, insurerShare: 1000 });
  });
  it('applies contractual and manual discounts before the split', () => {
    const line = splitLine(1000, { unitPrice: 40, patientSharePct: 100, discountPct: 15 }, 50);
    expect(line).toMatchObject({ discount: 200, net: 800, patientShare: 800, insurerShare: 0 });
  });
  it('distributes a package price over its tests and keeps the total exact', () => {
    const parts = distributePackagePrice([1000, 320, 400], 1500);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1500);
    expect(parts[0]).toBeGreaterThan(parts[1]!);
  });
  it('derives invoice status from payments', () => {
    expect(invoiceStatus(1000, 0)).toBe('open');
    expect(invoiceStatus(1000, 400)).toBe('partial');
    expect(invoiceStatus(1000, 1000)).toBe('paid');
    expect(invoiceStatus(0, 0)).toBe('paid');
  });
});

describe('tubes and numbers', () => {
  it('groups tests into tubes by container and specimen, keeping separate-tube tests apart', () => {
    const tubes = groupIntoTubes([
      { key: 'cbc', containerId: 'edta', sampleTypeId: 'wb', departmentId: 'hem', separateTube: false },
      { key: 'glu', containerId: 'sst', sampleTypeId: 'ser', departmentId: 'chem', separateTube: false },
      { key: 'tsh', containerId: 'sst', sampleTypeId: 'ser', departmentId: 'imm', separateTube: false },
      { key: 'a1c', containerId: 'edta', sampleTypeId: 'wb', departmentId: 'chem', separateTube: false },
      { key: 'ucult', containerId: 'urc', sampleTypeId: 'urine', departmentId: 'mic', separateTube: true },
      { key: 'urine', containerId: 'urc', sampleTypeId: 'urine', departmentId: 'urn', separateTube: false },
    ]);
    expect(tubes.map((t) => t.itemKeys)).toEqual([['cbc', 'a1c'], ['glu', 'tsh'], ['ucult'], ['urine']]);
    expect(tubes[1]!.departmentId).toBeNull();
    expect(tubes[2]!.departmentId).toBe('mic');
  });
  it('builds order numbers and tube barcodes in the lab time zone', () => {
    const late = new Date('2026-11-16T22:30:00Z'); // 01:30 on 17 Nov in Damascus (UTC+3)
    expect(dateKey(late)).toBe('2026-11-17');
    expect(accessionFor(late, 42)).toBe('261117-0042');
    expect(tubeBarcode('261117-0042', 1)).toBe('261117-0042-01');
  });
});

describe('Arabic names', () => {
  it('normalises spelling variants', () => {
    expect(normalizeText('أحمد  الحلبيّ')).toBe(normalizeText('احمد الحلبي'));
    expect(normalizeText('فاطمة')).toBe(normalizeText('فاطمه'));
    expect(normalizeText('مصطفى')).toBe(normalizeText('مصطفي'));
  });
  it('scores likely duplicates', () => {
    expect(nameSimilarity('محمد أحمد الحلبي', 'محمد احمد حلبي')).toBeGreaterThan(0.6);
    const same = duplicateScore(
      { fullNameAr: 'محمد أحمد الحلبي', birthDate: '1985-03-02', sex: 'male', phone: '0944 123 456' },
      { fullNameAr: 'محمد احمد الحلبي', birthDate: '1985-01-01', sex: 'male', phone: '+963944123456' },
    );
    expect(same.score).toBeGreaterThanOrEqual(80);
    expect(same.reasons).toEqual(expect.arrayContaining(['name', 'birth', 'phone']));
    const different = duplicateScore(
      { fullNameAr: 'محمد أحمد الحلبي', birthDate: '2026-01-01', sex: 'male' },
      { fullNameAr: 'محمد أحمد الحلبي', birthDate: '1950-01-01', sex: 'female' },
    );
    expect(different.score).toBeLessThan(60);
  });
});

describe('calculated tests', () => {
  it('computes Friedewald LDL and reports missing inputs as null', () => {
    expect(evaluateFormula('CHOL - HDL - TG / 5', { CHOL: 200, HDL: 50, TG: 150 })).toBe(120);
    expect(evaluateFormula('CHOL - HDL - TG / 5', { CHOL: 200, HDL: 50 })).toBeNull();
    expect(formulaVariables('CHOL - HDL - TG / 5').sort()).toEqual(['CHOL', 'HDL', 'TG']);
  });
  it('computes eGFR (CKD-EPI 2021) for a 50-year-old woman with creatinine 0.9 mg/dL', () => {
    const f =
      '142 * pow(min(CREA / if(FEMALE, 0.7, 0.9), 1), if(FEMALE, -0.241, -0.302)) * pow(max(CREA / if(FEMALE, 0.7, 0.9), 1), -1.2) * pow(0.9938, AGE) * if(FEMALE, 1.012, 1)';
    // 142 × (0.9/0.7)^-1.2 × 0.9938^50 × 1.012 = 77.9
    const egfr = evaluateFormula(f, { CREA: 0.9, AGE: 50, FEMALE: 1 })!;
    expect(Math.round(egfr)).toBe(78);
  });
  it('rejects malformed formulas and divides safely', () => {
    expect(() => validateFormula('CHOL - (HDL')).toThrow();
    expect(evaluateFormula('ALB / (TP - ALB)', { ALB: 4, TP: 4 })).toBeNull();
  });
});

describe('statuses', () => {
  it('derives line status from results and tube', () => {
    expect(deriveItemStatus([{ status: 'pending', hasValue: false }], 'received', 'ordered')).toBe('received');
    expect(deriveItemStatus([{ status: 'resulted', hasValue: true }, { status: 'pending', hasValue: false }], 'in_analysis', 'received')).toBe('in_analysis');
    expect(deriveItemStatus([{ status: 'validated', hasValue: true }, { status: 'released', hasValue: true }], 'in_analysis', 'resulted')).toBe('validated');
    expect(deriveItemStatus([{ status: 'pending', hasValue: false }], 'rejected', 'received')).toBe('rejected');
  });
  it('derives order status from its lines', () => {
    expect(deriveOrderStatus([{ status: 'ordered' }, { status: 'collected' }], 'registered')).toBe('registered');
    expect(deriveOrderStatus([{ status: 'released' }, { status: 'validated' }], 'in_progress')).toBe('partial');
    expect(deriveOrderStatus([{ status: 'released' }, { status: 'cancelled' }], 'partial')).toBe('completed');
    expect(deriveOrderStatus([{ status: 'released' }], 'delivered')).toBe('delivered');
  });
});

describe('quality control', () => {
  it('applies Westgard rules', () => {
    expect(westgard([100, 101, 99], 100, 2).status).toBe('accepted');
    expect(westgard([100, 105], 100, 2)).toEqual({ status: 'warning', violations: ['1-2s'] });
    expect(westgard([100, 107], 100, 2).violations).toContain('1-3s');
    expect(westgard([105, 105], 100, 2).violations).toContain('2-2s');
    expect(westgard([95, 105], 100, 2).violations).toContain('R-4s');
    expect(westgard([103, 103, 103, 103], 100, 2).violations).toContain('4-1s');
  });
});

describe('roles', () => {
  it('gives the owner everything and keeps validation away from reception', () => {
    const owner = ROLE_TEMPLATES.find((r) => r.key === 'owner')!;
    const reception = ROLE_TEMPLATES.find((r) => r.key === 'receptionist')!;
    expect(owner.permissions).toHaveLength(ALL_PERMISSIONS.length);
    expect(reception.permissions).not.toContain('results.validate');
    expect(reception.permissions).not.toContain('results.enter');
  });
});

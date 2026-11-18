/**
 * Pricing as Syrian labs practise it: each test is worth a number of units and each payer group
 * (general public, insurer plan, client lab) has a price per unit. A fixed price on the test,
 * or an override for that payer, wins over units. Insurer plans split the net price into a
 * patient share and an insurer share.
 */

export type PayerTerms = {
  unitPrice: number;
  patientSharePct: number;
  discountPct: number;
};

export type TestPriceInput = {
  units: number;
  fixedPrice?: number | null;
  overridePrice?: number | null;
};

export function roundMoney(value: number, currency = 'SYP'): number {
  if (currency === 'SYP') return Math.round(value);
  return Math.round(value * 100) / 100;
}

export function priceTest(test: TestPriceInput, payer: PayerTerms, currency = 'SYP'): { units: number; unitPrice: number; price: number } {
  if (test.overridePrice !== null && test.overridePrice !== undefined) {
    return { units: test.units, unitPrice: payer.unitPrice, price: roundMoney(test.overridePrice, currency) };
  }
  if (test.fixedPrice !== null && test.fixedPrice !== undefined) {
    return { units: test.units, unitPrice: payer.unitPrice, price: roundMoney(test.fixedPrice, currency) };
  }
  return { units: test.units, unitPrice: payer.unitPrice, price: roundMoney(test.units * payer.unitPrice, currency) };
}

/**
 * Spread a package price over its tests in proportion to each test's own price,
 * putting the rounding remainder on the last line so the lines add up exactly.
 */
export function distributePackagePrice(lineBasePrices: number[], packagePrice: number, currency = 'SYP'): number[] {
  const total = lineBasePrices.reduce((a, b) => a + b, 0);
  if (lineBasePrices.length === 0) return [];
  if (total <= 0) {
    const even = roundMoney(packagePrice / lineBasePrices.length, currency);
    const out = lineBasePrices.map(() => even);
    out[out.length - 1] = roundMoney(packagePrice - even * (out.length - 1), currency);
    return out;
  }
  const out = lineBasePrices.map((p) => roundMoney((p / total) * packagePrice, currency));
  const diff = roundMoney(packagePrice - out.reduce((a, b) => a + b, 0), currency);
  out[out.length - 1] = roundMoney(out[out.length - 1]! + diff, currency);
  return out;
}

export type LineShares = { price: number; discount: number; net: number; patientShare: number; insurerShare: number };

/** Apply the payer's contractual discount, an optional manual discount, and the patient/insurer split. */
export function splitLine(price: number, payer: PayerTerms, manualDiscount = 0, currency = 'SYP'): LineShares {
  const contractual = roundMoney((price * payer.discountPct) / 100, currency);
  const discount = Math.min(price, roundMoney(contractual + manualDiscount, currency));
  const net = roundMoney(price - discount, currency);
  const patientShare = roundMoney((net * payer.patientSharePct) / 100, currency);
  const insurerShare = roundMoney(net - patientShare, currency);
  return { price, discount, net, patientShare, insurerShare };
}

export function sumShares(lines: LineShares[]): { subtotal: number; discountTotal: number; patientTotal: number; insurerTotal: number } {
  return lines.reduce(
    (acc, l) => ({
      subtotal: acc.subtotal + l.price,
      discountTotal: acc.discountTotal + l.discount,
      patientTotal: acc.patientTotal + l.patientShare,
      insurerTotal: acc.insurerTotal + l.insurerShare,
    }),
    { subtotal: 0, discountTotal: 0, patientTotal: 0, insurerTotal: 0 },
  );
}

/** Invoice status from what the patient owes and what has been paid. */
export function invoiceStatus(patientTotal: number, paidTotal: number, isVoid = false): 'open' | 'partial' | 'paid' | 'void' {
  if (isVoid) return 'void';
  if (patientTotal <= 0 || paidTotal >= patientTotal) return 'paid';
  if (paidTotal > 0) return 'partial';
  return 'open';
}

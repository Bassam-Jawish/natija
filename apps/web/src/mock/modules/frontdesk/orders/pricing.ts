/**
 * Pricing and tube planning for order lines (port of apps/api/src/modules/orders/pricing.ts).
 * The quote, order creation and "add tests" all go through priceItems(), so a phone quote always
 * matches the invoice the order gets.
 *
 * - Packages are expanded into their tests; a package's price (sum of its tests, units × the
 *   payer's unit price, or a fixed price) is spread over its lines.
 * - A test is done once per order: when it comes twice (alone and in a package, or in two
 *   packages) the package copy wins and the duplicate is dropped with a warning.
 * - Each line: payer override > fixed price > units × unit price; then the payer's contractual
 *   discount, an optional manual discount, and the patient/insurer split. Discounts and shares
 *   are exact on the order total (largest remainder over the lines), so 20 % of 9 000 is 1 800.
 */
import { distributePackagePrice, groupIntoTubes, priceTest, roundMoney, sumShares, type PayerTerms } from '@natija/domain';
import type { OrderItemInput, OrderQuote, QuoteLine, QuoteTotals, QuoteTube, QuoteWarning } from '@natija/contracts';
import { badRequest } from '../../../core/context';
import { by, find, type Row } from '../../../core/db';
import { allocate, discountAmount, splitShares } from '../../shared/billing';

export type TestInfo = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  departmentId: string;
  sampleTypeId: string;
  sampleTypeCode: string;
  sampleTypeNameAr: string;
  sampleTypeNameEn: string;
  containerId: string;
  containerCode: string;
  containerNameAr: string;
  containerNameEn: string;
  capColor: string;
  units: number;
  fixedPrice: number | null;
  separateTube: boolean;
  isExternal: boolean;
  isActive: boolean;
  sortOrder: number;
  tatHours: number;
  analytes: Array<{ id: string; code: string; unit: string | null }>;
};

export type PricedLine = QuoteLine & { test: TestInfo };

export type PackageInfo = { packageId: string; code: string; nameAr: string; nameEn: string; priceMode: string; price: number };

type PayerGroup = Row<'payerGroups'>;

/** Tests with their container, specimen type and active analytes (tests without both are left out, like the join). */
export function loadTests(ids: string[]): Map<string, TestInfo> {
  const out = new Map<string, TestInfo>();
  for (const id of new Set(ids)) {
    const t = find('tests', id);
    const c = t ? find('containers', t.containerId) : undefined;
    const st = t ? find('sampleTypes', t.sampleTypeId) : undefined;
    if (!t || !c || !st) continue;
    const analytes = by('testAnalytes', 'testId', t.id)
      .map((ta) => ({ ta, a: find('analytes', ta.analyteId) }))
      .filter((x): x is { ta: Row<'testAnalytes'>; a: Row<'analytes'> } => !!x.a && x.a.isActive)
      .sort((x, y) => x.ta.sortOrder - y.ta.sortOrder || x.a.sortOrder - y.a.sortOrder)
      .map(({ a }) => ({ id: a.id, code: a.code, unit: a.unit }));
    out.set(t.id, {
      id: t.id,
      code: t.code,
      nameAr: t.nameAr,
      nameEn: t.nameEn,
      departmentId: t.departmentId,
      sampleTypeId: t.sampleTypeId,
      sampleTypeCode: st.code,
      sampleTypeNameAr: st.nameAr,
      sampleTypeNameEn: st.nameEn,
      containerId: t.containerId,
      containerCode: c.code,
      containerNameAr: c.nameAr,
      containerNameEn: c.nameEn,
      capColor: c.capColor,
      units: t.units,
      fixedPrice: t.fixedPrice,
      separateTube: t.separateTube,
      isExternal: t.isExternal,
      isActive: t.isActive,
      sortOrder: t.sortOrder,
      tatHours: t.tatHours,
      analytes,
    });
  }
  return out;
}

export function loadPayer(id: string | null | undefined): PayerGroup {
  const payer = find('payerGroups', id);
  if (!payer || !payer.isActive) throw badRequest('payer_not_found', 'Unknown or inactive payer group.');
  return payer;
}

export function payerTerms(p: Pick<PayerGroup, 'unitPrice' | 'patientSharePct' | 'discountPct'>): PayerTerms {
  return { unitPrice: p.unitPrice, patientSharePct: p.patientSharePct, discountPct: p.discountPct };
}

export type PricedItems = { lines: PricedLine[]; packages: PackageInfo[]; warnings: QuoteWarning[]; requestedDiscount: number };

export function priceItems(params: {
  payer: PayerGroup;
  items: OrderItemInput[];
  currency: string;
  /** Tests already in the order (when adding tests later): never added twice. */
  existingTestIds?: Iterable<string>;
  /** Manual discount requested at the desk. */
  manualDiscount?: { amount?: number; percent?: number } | null;
  /** Apply the manual discount now (the user can approve discounts). */
  applyManualDiscount?: boolean;
}): PricedItems {
  const { payer, currency } = params;
  const items = params.items ?? [];
  const terms = payerTerms(payer);
  const testIds = items.flatMap((i) => ('testId' in i && i.testId ? [i.testId] : []));
  const packageIds = [...new Set(items.flatMap((i) => ('packageId' in i && i.packageId ? [i.packageId] : [])))];
  const warnings: QuoteWarning[] = [];

  const pkgById = new Map<string, Row<'packages'>>();
  for (const id of packageIds) {
    const p = find('packages', id);
    if (p?.isActive) pkgById.set(p.id, p);
  }
  if (pkgById.size !== packageIds.length) throw badRequest('package_not_found', 'Unknown or inactive package.');
  const pkgTestRows = packageIds.flatMap((id) => by('packageTests', 'packageId', id));

  const testMap = loadTests([...testIds, ...pkgTestRows.map((r) => r.testId)]);
  for (const id of testIds) {
    if (!testMap.get(id)?.isActive) throw badRequest('test_not_found', 'Unknown or inactive test.');
  }

  const seen = new Set<string>(params.existingTestIds ?? []);
  type Raw = { test: TestInfo; packageId: string | null };
  const raw: Raw[] = [];
  // Packages first, so a test that is also inside a package is billed through the package.
  for (const packageId of packageIds) {
    const pkg = pkgById.get(packageId)!;
    const inPkg = pkgTestRows
      .filter((r) => r.packageId === packageId)
      .map((r) => testMap.get(r.testId))
      .filter((t): t is TestInfo => !!t && t.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
    const fresh: TestInfo[] = [];
    for (const t of inPkg) {
      if (seen.has(t.id)) warnings.push({ kind: 'duplicate_test', testId: t.id, code: t.code });
      else {
        seen.add(t.id);
        fresh.push(t);
      }
    }
    if (!fresh.length) {
      warnings.push({ kind: 'package_covered', packageId: pkg.id, code: pkg.code });
      continue;
    }
    for (const t of fresh) raw.push({ test: t, packageId: pkg.id });
  }
  for (const id of testIds) {
    const t = testMap.get(id)!;
    if (seen.has(t.id)) {
      if (!warnings.some((w) => w.kind === 'duplicate_test' && w.testId === t.id)) warnings.push({ kind: 'duplicate_test', testId: t.id, code: t.code });
      continue;
    }
    seen.add(t.id);
    raw.push({ test: t, packageId: null });
  }

  const wanted = new Set(raw.map((r) => r.test.id));
  const overrides = new Map(
    by('priceOverrides', 'payerGroupId', payer.id)
      .filter((o) => wanted.has(o.testId))
      .map((o) => [o.testId, o.price] as const),
  );

  const base = raw.map((r) => priceTest({ units: r.test.units, fixedPrice: r.test.fixedPrice, overridePrice: overrides.get(r.test.id) ?? null }, terms, currency));
  const prices = base.map((b) => b.price);
  const packageInfos: PackageInfo[] = [];
  for (const packageId of packageIds) {
    const idx = raw.map((r, i) => (r.packageId === packageId ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const pkg = pkgById.get(packageId)!;
    const sum = roundMoney(idx.reduce((a, i) => a + base[i]!.price, 0), currency);
    const pkgPrice =
      pkg.priceMode === 'units' && pkg.units !== null
        ? roundMoney(pkg.units * payer.unitPrice, currency)
        : pkg.priceMode === 'fixed' && pkg.fixedPrice !== null
          ? roundMoney(pkg.fixedPrice, currency)
          : sum;
    const spread = distributePackagePrice(
      idx.map((i) => base[i]!.price),
      pkgPrice,
      currency,
    );
    idx.forEach((i, k) => (prices[i] = spread[k]!));
    packageInfos.push({ packageId, code: pkg.code, nameAr: pkg.nameAr, nameEn: pkg.nameEn, priceMode: pkg.priceMode, price: pkgPrice });
  }

  // The payer's contractual discount, exact on the total and spread over the lines.
  const subtotal = roundMoney(prices.reduce((a, b) => a + b, 0), currency);
  const contractual = allocate(roundMoney((subtotal * terms.discountPct) / 100, currency), prices, prices, currency);
  // A manual discount is spread over what is left after the payer's own discount.
  const room = prices.map((p, i) => roundMoney(p - contractual[i]!, currency));
  const roomTotal = roundMoney(room.reduce((a, b) => a + b, 0), currency);
  const requestedDiscount = params.manualDiscount ? discountAmount(roomTotal, params.manualDiscount, currency) : 0;
  const manual = params.applyManualDiscount && requestedDiscount > 0 ? allocate(requestedDiscount, room, room, currency) : prices.map(() => 0);
  const discounts = prices.map((_, i) => roundMoney(contractual[i]! + manual[i]!, currency));
  const split = splitShares(
    prices.map((price, i) => ({ price, discount: discounts[i]! })),
    terms.patientSharePct,
    currency,
  );

  const lines: PricedLine[] = raw.map((r, i) => {
    const shares = { price: prices[i]!, discount: discounts[i]!, ...split[i]! };
    const pkg = r.packageId ? pkgById.get(r.packageId)! : null;
    return {
      key: r.test.id,
      testId: r.test.id,
      code: r.test.code,
      nameAr: r.test.nameAr,
      nameEn: r.test.nameEn,
      packageId: r.packageId,
      packageCode: pkg?.code ?? null,
      units: r.test.units,
      unitPrice: base[i]!.unitPrice,
      price: shares.price,
      discount: shares.discount,
      net: shares.net,
      patientShare: shares.patientShare,
      insurerShare: shares.insurerShare,
      containerId: r.test.containerId,
      capColor: r.test.capColor,
      sampleTypeId: r.test.sampleTypeId,
      departmentId: r.test.departmentId,
      isExternal: r.test.isExternal,
      tubeSeq: 0,
      test: r.test,
    };
  });
  return { lines, packages: packageInfos, warnings, requestedDiscount };
}

/** Group new lines into tubes (one per container and specimen, unless a test needs its own). */
export function planTubes(lines: PricedLine[], firstSeq = 1): Array<QuoteTube & { lineKeys: string[]; departmentId: string | null }> {
  const plans = groupIntoTubes(
    lines.map((l) => ({ key: l.key, containerId: l.containerId, sampleTypeId: l.sampleTypeId, departmentId: l.departmentId, separateTube: l.test.separateTube })),
  );
  const byKey = new Map(lines.map((l) => [l.key, l]));
  return plans.map((plan, i) => {
    const first = byKey.get(plan.itemKeys[0]!)!.test;
    const seq = firstSeq + i;
    for (const k of plan.itemKeys) byKey.get(k)!.tubeSeq = seq;
    return {
      seq,
      containerId: plan.containerId,
      containerCode: first.containerCode,
      containerNameAr: first.containerNameAr,
      containerNameEn: first.containerNameEn,
      capColor: first.capColor,
      sampleTypeId: plan.sampleTypeId,
      sampleTypeNameAr: first.sampleTypeNameAr,
      sampleTypeNameEn: first.sampleTypeNameEn,
      testCodes: plan.itemKeys.map((k) => byKey.get(k)!.code),
      lineKeys: plan.itemKeys,
      departmentId: plan.departmentId,
    };
  });
}

/** Analytes measured by more than one test of the order. */
export function analyteOverlaps(list: Array<Pick<TestInfo, 'code' | 'analytes'>>): QuoteWarning[] {
  const byAnalyte = new Map<string, string[]>();
  for (const t of list) {
    for (const a of t.analytes) {
      const codes = byAnalyte.get(a.code) ?? [];
      if (!codes.includes(t.code)) codes.push(t.code);
      byAnalyte.set(a.code, codes);
    }
  }
  return [...byAnalyte.entries()].filter(([, codes]) => codes.length > 1).map(([analyteCode, testCodes]) => ({ kind: 'analyte_overlap' as const, analyteCode, testCodes }));
}

export function totalsOf(lines: Array<Pick<QuoteLine, 'price' | 'discount' | 'net' | 'patientShare' | 'insurerShare'>>, currency = 'SYP'): QuoteTotals {
  const s = sumShares(lines);
  return {
    subtotal: roundMoney(s.subtotal, currency),
    discountTotal: roundMoney(s.discountTotal, currency),
    net: roundMoney(s.subtotal - s.discountTotal, currency),
    insurerTotal: roundMoney(s.insurerTotal, currency),
    patientTotal: roundMoney(s.patientTotal, currency),
  };
}

/** Strip internal fields before sending lines to the browser. */
export function publicLine(l: PricedLine): QuoteLine {
  const { test, ...rest } = l;
  void test;
  return rest;
}

export function quoteResult(params: { payerGroupId: string; currency: string; priced: PricedItems; canApproveDiscount: boolean }): OrderQuote {
  const { priced, currency } = params;
  const tubes = planTubes(priced.lines).map(({ lineKeys, departmentId, ...t }) => {
    void lineKeys;
    void departmentId;
    return t;
  });
  return {
    payerGroupId: params.payerGroupId,
    currency,
    lines: priced.lines.map(publicLine),
    packages: priced.packages,
    tubes,
    totals: totalsOf(priced.lines, currency),
    discount: priced.requestedDiscount > 0 ? { requested: priced.requestedDiscount, applied: params.canApproveDiscount, needsApproval: !params.canApproveDiscount } : null,
    warnings: [...priced.warnings, ...analyteOverlaps(priced.lines.map((l) => l.test))],
  };
}

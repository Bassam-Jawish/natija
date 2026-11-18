/**
 * Demo history: about a month of work in each demo lab, produced by the API's own services on a
 * simulated clock — registration and payments at reception, sample collection and reception,
 * analyzer and manual results, verification, medical validation with critical-value calls,
 * report release and delivery, daily cash sessions, QC runs, maintenance and expenses. Work that
 * would happen after the real "now" is left undone, so today shows every stage at once.
 *
 * Run after the base seed: `pnpm seed:demo` (database reset + this script). Everything is fictional.
 */
import { clearSimTime, realNow, setSimTime } from './clock';
import { and, count, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  OWNER_URL,
  analytes,
  createDb,
  createPool,
  criticalCalls,
  expenseCategories,
  instrumentMappings,
  instruments,
  invoices,
  labs,
  maintenanceLogs,
  orderItems,
  orders,
  qcMaterials,
  referenceRanges,
  rejectionReasons,
  results,
  samples,
  tests,
  users,
  type Instrument,
} from '@natija/db';
import { LABS } from '@natija/db/seed';
import { orderCreateInput, patientCreateInput, simulateBody } from '@natija/contracts';
import { ageInDays, selectRange, type RangeRow } from '@natija/domain';
import { appPool, db, withLab } from '../db';
import { balanceOf, takePayment } from '../modules/billing/service';
import { closeSession, createExpense, currentSession, decideApproval, openSession } from '../modules/finance/service';
import { simulateOnInstrument } from '../modules/instruments/simulate';
import { cancelOrder, createOrder, formData, markLabelsPrinted } from '../modules/orders/service';
import { createPatient } from '../modules/patients/service';
import { recordQcRun, type QcMaterialRow } from '../modules/qc/runs';
import { deliverReport, releaseReport } from '../modules/reports/service';
import { amendResult, enterResults, recordCriticalCall, validateResults, verifyResults } from '../modules/results/service';
import { collectSamples, receiveSamples, rejectSample } from '../modules/samples/service';
import { applyResultValue } from '../services/results-engine';
import { refreshOrderStatus } from '../services/order-status';
import { PROFILES, createRng, hashSeed, labPicture, makePatient, pickProfile, type AnalyteMeta, type Rng, type SimPatient } from '@natija/db/seed/data';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAYS_BACK = 30;
/** Asia/Damascus has stayed on UTC+3 all year since 2022. */
const LAB_OFFSET = 3 * HOUR;
/** Immunoassays run once a day in a batch (the catalog promises them within 24 hours). */
const BATCH_TESTS = new Set(['VITD', 'B12', 'FERR', 'PSA', 'PRL', 'INS']);
const FASTING_TESTS = new Set(['GLU', 'LIPID', 'DIABETES', 'CHECKUP', 'INS']);
const NON_BLOOD = new Set(['URC', 'STC']);
/**
 * Panels whose values must agree with each other (CBC indices and differential, bilirubins,
 * proteins, lipids, PT/INR, blood gas). The analyzer simulator draws every value on its own,
 * so these always use the seed's coherent values.
 */
const COHERENT = new Set([
  'WBC', 'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW', 'PLT', 'MPV', 'NEUT%', 'LYMPH%', 'MONO%', 'EOS%', 'BASO%',
  'NEUT#', 'LYMPH#', 'MONO#', 'EOS#', 'BASO#', 'TBIL', 'DBIL', 'TP', 'ALB', 'CHOL', 'TG', 'HDL', 'PT', 'INR', 'PH', 'PCO2', 'PO2', 'HCO3',
]);
const DISCOUNT_REASONS = ['قريب أحد الموظفين', 'مريض مسن', 'حالة إنسانية', 'إعادة تحليل سابق'];
const VISIT_HOURS: Array<readonly [number, number]> = [[8, 13], [9, 16], [10, 15], [11, 12], [12, 10], [13, 8], [14, 6], [15, 5], [16, 5], [17, 4], [18, 3]];
const MONTHLY: Record<string, { rent: number; salaries: number; float: number }> = {
  yasmin: { rent: 60_000, salaries: 190_000, float: 2_000 },
  orontes: { rent: 40_000, salaries: 120_000, float: 1_500 },
  citadel: { rent: 45_000, salaries: 130_000, float: 1_500 },
};

type Actor = 'reception' | 'tech' | 'techHem' | 'doctor' | 'owner' | 'manager' | 'accountant' | 'agent';
type Person = { id: string | null; nameAr: string; nameEn: string };
type Later = (at: number, actor: Actor, kind: string, job: Job) => void;
type Job = (c: { at: number; later: Later }) => Promise<void>;
type Ev = { at: number; seq: number; actor: Actor; kind: string; job: Job };
type LabDef = (typeof LABS)[number];

type AnalyteInfo = { id: string; code: string; type: AnalyteMeta['type']; decimals: number; options: string[]; ranges: RangeRow[] };
type TestInfo = { id: string; code: string; departmentId: string | null; tatHours: number; analyteCodes: string[] };
type Doctor = { id: string; nameAr: string; specialtyEn: string | null; phone: string | null };

type World = {
  labId: string;
  code: string;
  rng: Rng;
  todayStart: number;
  stopAt: number;
  people: Record<Actor, Person>;
  hemDeptId: string | null;
  tests: Map<string, TestInfo>;
  testById: Map<string, TestInfo>;
  packages: Map<string, string[]>;
  packageIds: Map<string, string>;
  payers: Map<string, string>;
  doctors: Doctor[];
  methods: Record<string, string>;
  branches: { main: string | null; other: string | null };
  containerCode: Map<string, string>;
  analytes: Map<string, AnalyteInfo>;
  analyteById: Map<string, AnalyteInfo>;
  instruments: Map<string, Instrument>;
  instrumentsFor: Map<string, string[]>;
  qc: QcMaterialRow[];
  reasons: Array<{ id: string; code: string }>;
  categories: Map<string, string>;
  sessionOpen: boolean;
  payments: number;
  orderSeq: number;
  stats: { done: number; failed: number; skipped: number; errors: Map<string, number> };
};

type OrderSim = {
  key: number;
  p: SimPatient;
  visit: number;
  at: number;
  codes: string[];
  priority: 'routine' | 'urgent' | 'stat';
  channel: 'print' | 'whatsapp' | 'sms' | 'email';
  clientLab: boolean;
  doctor: Doctor | null;
  discount: { percent: number; reason: string } | null;
  /** 0 = the main analyzer, 1 = the backup one (when a lab has two that run the test). */
  rank: number;
  holdValidation?: boolean;
  holdApproval?: boolean;
  force?: Record<string, number>;
  picture?: Map<string, string | number>;
  id?: string;
  invoiceId?: string;
};

/* ================================================================== event queue */

class EventQueue {
  private heap: Ev[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(at: number, actor: Actor, kind: string, job: Job): void {
    this.heap.push({ at: Math.round(at), seq: this.seq++, actor, kind, job });
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(this.heap[i]!, this.heap[parent]!)) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent]!, this.heap[i]!];
      i = parent;
    }
  }

  pop(): Ev | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (!top || !last || !this.heap.length) return top;
    this.heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.heap.length && this.before(this.heap[l]!, this.heap[m]!)) m = l;
      if (r < this.heap.length && this.before(this.heap[r]!, this.heap[m]!)) m = r;
      if (m === i) break;
      [this.heap[i], this.heap[m]] = [this.heap[m]!, this.heap[i]!];
      i = m;
    }
    return top;
  }

  private before(a: Ev, b: Ev): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
}

/* ================================================================== time */

function local(t: number): { hour: number; dow: number; dayStart: number } {
  const d = new Date(t + LAB_OFFSET);
  return { hour: d.getUTCHours() + d.getUTCMinutes() / 60, dow: d.getUTCDay(), dayStart: Math.floor((t + LAB_OFFSET) / DAY) * DAY - LAB_OFFSET };
}

function dayKey(t: number): string {
  return new Date(t + LAB_OFFSET).toISOString().slice(0, 10);
}

/** Move a time into opening hours (08:00–19:30, Fridays 08:00–13:30). */
function workTime(t: number, rng: Rng): number {
  for (let i = 0; i < 4; i++) {
    const { hour, dow, dayStart } = local(t);
    const close = dow === 5 ? 13.5 : 19.5;
    if (hour < 8) return dayStart + 8 * HOUR + rng.between(10, 70) * MIN;
    if (hour <= close) return t;
    t = dayStart + DAY + 8 * HOUR + rng.between(10, 70) * MIN;
  }
  return t;
}

/* ================================================================== world */

async function loadWorld(labId: string, def: LabDef, todayStart: number, stopAt: number): Promise<World> {
  return withLab(labId, {}, async () => {
    const tx = db();
    const staff = await tx.select({ id: users.id, username: users.username, nameAr: users.fullNameAr, nameEn: users.fullNameEn }).from(users);
    const person = (username: string, fallback?: string): Person => {
      const u = staff.find((s) => s.username === username) ?? staff.find((s) => s.username === fallback);
      if (!u) throw new Error(`${def.code}: no user ${username}`);
      return { id: u.id, nameAr: u.nameAr, nameEn: u.nameEn };
    };
    const form = await formData();
    const analyteRows = await tx.select().from(analytes);
    const rangeRows = await tx.select().from(referenceRanges);
    const instRows = await tx.select().from(instruments).where(eq(instruments.isActive, true));
    const mapRows = await tx
      .select({ instrumentId: instrumentMappings.instrumentId, analyteId: instrumentMappings.analyteId })
      .from(instrumentMappings)
      .where(eq(instrumentMappings.isActive, true));
    const qc = await tx.select().from(qcMaterials).where(eq(qcMaterials.isActive, true));
    const reasons = await tx.select({ id: rejectionReasons.id, code: rejectionReasons.code }).from(rejectionReasons);
    const categories = await tx.select({ id: expenseCategories.id, nameEn: expenseCategories.nameEn }).from(expenseCategories);

    const analyteMap = new Map<string, AnalyteInfo>();
    for (const a of analyteRows) {
      analyteMap.set(a.code, { id: a.id, code: a.code, type: a.resultType, decimals: a.decimals, options: a.options, ranges: rangeRows.filter((r) => r.analyteId === a.id) });
    }
    const testMap = new Map<string, TestInfo>(
      form.tests.map((t) => [t.code, { id: t.id, code: t.code, departmentId: t.departmentId, tatHours: t.tatHours, analyteCodes: t.analyteCodes }]),
    );
    const size = new Map<string, number>();
    for (const m of mapRows) size.set(m.instrumentId, (size.get(m.instrumentId) ?? 0) + 1);
    const active = new Set(instRows.map((i) => i.id));
    const instrumentsFor = new Map<string, string[]>();
    for (const m of mapRows) {
      if (!active.has(m.instrumentId)) continue;
      instrumentsFor.set(m.analyteId, [...(instrumentsFor.get(m.analyteId) ?? []), m.instrumentId]);
    }
    for (const list of instrumentsFor.values()) list.sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0));

    const hasHem = staff.some((s) => s.username === 'tech.hem');
    return {
      labId,
      code: def.code,
      rng: createRng(hashSeed(`natija-demo:${def.code}`)),
      todayStart,
      stopAt,
      people: {
        reception: person('reception'),
        tech: person('tech'),
        techHem: person(hasHem ? 'tech.hem' : 'tech'),
        doctor: person('doctor'),
        owner: person('owner', 'doctor'),
        manager: person('manager', 'owner'),
        accountant: person('accountant', 'manager'),
        agent: { id: null, nameAr: 'وكيل المخبر', nameEn: 'agent:Virtual Lab Agent' },
      },
      hemDeptId: hasHem ? (form.departments.find((d) => d.code === 'HEM')?.id ?? null) : null,
      tests: testMap,
      testById: new Map([...testMap.values()].map((t) => [t.id, t])),
      packages: new Map(form.packages.map((p) => [p.code, p.testIds])),
      packageIds: new Map(form.packages.map((p) => [p.code, p.id])),
      payers: new Map(form.payerGroups.map((p) => [p.code, p.id])),
      doctors: form.doctors.map((d) => ({ id: d.id, nameAr: d.nameAr, specialtyEn: d.specialtyEn, phone: d.phone })),
      methods: Object.fromEntries(form.paymentMethods.map((m) => [m.code, m.id])),
      branches: { main: form.branches.find((b) => b.isMain)?.id ?? null, other: form.branches.find((b) => !b.isMain)?.id ?? null },
      containerCode: new Map(form.tests.map((t) => [t.containerId, t.containerCode])),
      analytes: analyteMap,
      analyteById: new Map([...analyteMap.values()].map((a) => [a.id, a])),
      instruments: new Map(instRows.map((i) => [i.id, i])),
      instrumentsFor,
      qc,
      reasons,
      categories: new Map(categories.map((c) => [c.nameEn, c.id])),
      sessionOpen: false,
      payments: 0,
      orderSeq: 0,
      stats: { done: 0, failed: 0, skipped: 0, errors: new Map() },
    };
  });
}

function metaFor(w: World, p: SimPatient, ageDays: number) {
  return (code: string): AnalyteMeta | undefined => {
    const a = w.analytes.get(code);
    if (!a) return undefined;
    const r = selectRange(a.ranges, { sex: p.sex, ageDays });
    return { type: a.type, decimals: a.decimals, options: a.options, low: r?.low ?? null, high: r?.high ?? null };
  };
}

function analyteCodesOf(w: World, codes: string[]): string[] {
  const out = new Set<string>();
  for (const code of codes) {
    const testIds = w.packages.get(code);
    const list = testIds ? testIds.map((id) => w.testById.get(id)).filter((t): t is TestInfo => !!t) : [w.tests.get(code)].filter((t): t is TestInfo => !!t);
    for (const t of list) for (const a of t.analyteCodes) out.add(a);
  }
  return [...out];
}

/* ================================================================== planning */

function makeOrder(w: World, p: SimPatient, visit: number, daysAgo: number, codes: string[]): OrderSim {
  const rng = w.rng;
  const spec = PROFILES[p.profile];
  let dayStart = w.todayStart - daysAgo * DAY;
  if (local(dayStart + HOUR).dow === 5 && !rng.chance(0.3)) dayStart += daysAgo > 0 ? DAY : -DAY;
  const friday = local(dayStart + HOUR).dow === 5;
  let at = dayStart + (friday ? rng.int(8, 12) : rng.weighted(VISIT_HOURS)) * HOUR + rng.int(0, 59) * MIN + rng.int(0, 59) * 1000;
  if (dayStart === w.todayStart && at > w.stopAt - 3 * MIN) {
    const open = dayStart + 8 * HOUR;
    at = w.stopAt - 3 * MIN > open + 10 * MIN ? rng.between(open, w.stopAt - 3 * MIN) : at - DAY;
  }
  const clientLab = p.payerCode === 'NOOR';
  const matching = spec.specialties.length && !clientLab && rng.chance(0.65) ? w.doctors.filter((d) => d.specialtyEn && spec.specialties.includes(d.specialtyEn)) : [];
  const doctor = matching.length ? rng.pick(matching) : !clientLab && rng.chance(0.12) ? rng.pick(w.doctors) : null;
  const priority = rng.chance(spec.stat ?? 0.01) ? 'stat' : rng.chance(spec.urgent ?? 0.05) ? 'urgent' : 'routine';
  const d = p.draft;
  const channel = clientLab
    ? 'print'
    : d.email && rng.chance(0.3)
      ? 'email'
      : d.phone && d.contactPref === 'whatsapp'
        ? 'whatsapp'
        : d.phone && d.contactPref === 'sms'
          ? 'sms'
          : 'print';
  const discount = !clientLab && p.payerCode === 'PUBLIC' && rng.chance(0.04) ? { percent: rng.pick([10, 15, 20]), reason: rng.pick(DISCOUNT_REASONS) } : null;
  return { key: w.orderSeq++, p, visit, at, codes, priority, channel, clientLab, doctor, discount, rank: rng.chance(0.85) ? 0 : 1 };
}

function planOrders(w: World, def: LabDef): OrderSim[] {
  const rng = w.rng;
  const list: OrderSim[] = [];
  const patients: SimPatient[] = [];
  const visits = new Map<SimPatient, number>();
  for (let i = 0; i < def.patients; i++) {
    const p = makePatient(rng, i, pickProfile(rng), def.city, new Date(w.todayStart));
    const spec = PROFILES[p.profile];
    patients.push(p);
    let daysAgo = rng.chance(0.03) ? 0 : rng.int(1, DAYS_BACK);
    list.push(makeOrder(w, p, 0, daysAgo, rng.pick(spec.menus)));
    let visit = 1;
    for (; spec.followUp; visit++) {
      daysAgo -= rng.int(spec.followUp.every[0], spec.followUp.every[1]);
      if (daysAgo < 0 || !rng.chance(spec.followUp.chance)) break;
      list.push(makeOrder(w, p, visit, daysAgo, rng.pick(spec.followUp.menus ?? spec.menus)));
    }
    visits.set(p, visit);
  }

  // A steady stream of patients in the last two and a half hours, so every stage is on screen.
  const recentFrom = Math.max(w.todayStart + 8 * HOUR, w.stopAt - 150 * MIN);
  const extra = Math.max(4, Math.round(def.patients / 30));
  for (let i = 0; i < extra && w.stopAt - 10 * MIN > recentFrom; i++) {
    const returning = rng.chance(0.4) ? rng.pick(patients) : null;
    const p = returning ?? makePatient(rng, def.patients + 2 + i, pickProfile(rng), def.city, new Date(w.todayStart));
    const spec = PROFILES[p.profile];
    const o = makeOrder(w, p, returning ? (visits.get(p) ?? 1) : 0, 0, rng.pick(returning ? (spec.followUp?.menus ?? spec.menus) : spec.menus));
    o.at = recentFrom + ((i + rng.between(0.1, 0.9)) / extra) * (w.stopAt - 4 * MIN - recentFrom);
    list.push(o);
  }

  // Today, for the demo: a STAT chest-pain patient whose critical troponin waits for the doctor's
  // call and validation, and a discount waiting for the manager.
  if (w.stopAt - 75 * MIN > w.todayStart + 8 * HOUR) {
    const cardiac = makePatient(rng, def.patients, 'cardiac', def.city, new Date(w.todayStart));
    cardiac.payerCode = 'PUBLIC';
    cardiac.traits.set('acs', true);
    const o = makeOrder(w, cardiac, 0, 0, ['TNI', 'CK', 'ELEC']);
    Object.assign(o, { at: w.stopAt - 70 * MIN, priority: 'stat', holdValidation: true, force: { TNI: 2.35 } });
    o.doctor = w.doctors.find((d) => d.specialtyEn === 'Cardiology') ?? o.doctor;
    list.push(o);

    const discounted = makePatient(rng, def.patients + 1, 'healthy', def.city, new Date(w.todayStart));
    discounted.payerCode = 'PUBLIC';
    const d = makeOrder(w, discounted, 0, 0, ['CHECKUP']);
    Object.assign(d, { at: w.stopAt - 30 * MIN, discount: { percent: 20, reason: DISCOUNT_REASONS[1]! }, holdApproval: true });
    list.push(d);
  }
  return list;
}

function planDays(w: World, q: EventQueue): void {
  const rng = w.rng;
  const money = MONTHLY[w.code] ?? MONTHLY.yasmin!;
  for (let back = DAYS_BACK; back >= 0; back--) {
    const start = w.todayStart - back * DAY;
    const { dow } = local(start + HOUR);
    const friday = dow === 5;
    const at = (h: number, m = 0) => start + h * HOUR + m * MIN;

    q.push(at(7, friday ? 50 : 30), 'reception', 'cash-open', async () => {
      try {
        await openSession({ openingFloat: money.float, branchId: w.branches.main });
      } catch (err) {
        if ((err as { code?: string }).code !== 'session_already_open') throw err;
      }
      w.sessionOpen = true;
    });
    q.push(at(7, 35), 'tech', 'maintenance', (c) => maintenanceJob(w, c.at, dow, back));
    q.push(at(7, 45), 'tech', 'qc', (c) => qcJob(w, c, back === 0));

    if (!friday && rng.chance(0.35)) {
      q.push(at(rng.int(11, 16), rng.int(0, 59)), 'reception', 'expense', (c) =>
        expense(w, c.at, 'Electricity & generator', rng.int(6, 14) * 100, 'مازوت للمولدة', true),
      );
    }
    if (!friday && rng.chance(0.1)) {
      q.push(at(rng.int(10, 17), rng.int(0, 59)), 'reception', 'expense', (c) => expense(w, c.at, 'Other', rng.int(3, 9) * 100, 'مواد تنظيف وقرطاسية', true));
    }
    if (dow === 0) {
      q.push(at(11, rng.int(0, 59)), 'accountant', 'expense', (c) =>
        expense(w, c.at, 'Reagents & kits', rng.int(36, 90) * 500, 'كواشف ومستلزمات - دفعة أسبوعية', false),
      );
    }
    if (new Date(start + LAB_OFFSET).getUTCDate() === 1) {
      q.push(at(12), 'accountant', 'expense', (c) => expense(w, c.at, 'Rent', money.rent, 'إيجار المخبر - شهري', false));
      q.push(at(12, 20), 'accountant', 'expense', (c) => expense(w, c.at, 'Salaries', money.salaries, 'رواتب الموظفين - شهري', false));
    }

    q.push(at(friday ? 14 : 20), 'reception', 'cash-close', async () => {
      const { session } = await currentSession();
      w.sessionOpen = false;
      if (!session) return;
      const expected = session.totals.expectedCash;
      const r = rng();
      const diff = r < 0.85 ? 0 : r < 0.95 ? -rng.int(1, 5) * 100 : rng.int(1, 3) * 100;
      const note = diff < 0 ? 'نقص في الصندوق' : diff > 0 ? 'زيادة في الصندوق' : null;
      await closeSession(session.id, { countedCash: Math.max(0, expected + diff), note }, { canSupervise: false });
    });
  }

  // Today, a few analyzer faults for the review queue and the event log.
  const linked = [...w.instruments.values()].filter((i) => i.protocol === 'astm' || i.protocol === 'hl7');
  const faults = ['unknown_sample', 'duplicate', 'bad_checksum', 'unknown_code'] as const;
  faults.forEach((fault, i) => {
    const inst = linked[i % Math.max(1, linked.length)];
    if (!inst) return;
    q.push(w.stopAt - (10 - 2 * i) * MIN, 'tech', 'fault-demo', async () => {
      await savepoint(() => simulateOnInstrument(inst, simulateBody.parse({ mode: 'normal', fault, seed: 1000 + i })));
    });
  });
}

/* ================================================================== jobs */

/** Run a step that may fail without spoiling the surrounding transaction. */
async function savepoint<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await db().transaction(async () => fn());
  } catch {
    return null;
  }
}

async function expense(w: World, at: number, category: string, amount: number, note: string, fromDrawer: boolean): Promise<void> {
  const categoryId = w.categories.get(category) ?? w.categories.get('Other');
  if (!categoryId || (fromDrawer && !w.sessionOpen)) return;
  await createExpense({ categoryId, amount, paidOn: dayKey(at), note, fromDrawer });
}

async function maintenanceJob(w: World, at: number, dow: number, back: number): Promise<void> {
  const rng = w.rng;
  const tech = w.people.tech;
  let i = 0;
  for (const inst of w.instruments.values()) {
    const performedAt = new Date(at + i++ * 3 * MIN);
    const weekly = dow === 6;
    const issue = rng.chance(0.01);
    await db()
      .insert(maintenanceLogs)
      .values({
        labId: w.labId,
        instrumentId: inst.id,
        kind: weekly ? 'weekly' : 'daily',
        performedAt,
        performedBy: tech.id,
        description: issue
          ? 'إنذار انسداد إبرة العينة: تم التنظيف وإعادة التشغيل بنجاح'
          : weekly
            ? 'صيانة أسبوعية: تنظيف خلايا القياس والأنابيب وفحص الكواشف'
            : 'صيانة يومية: تنظيف الإبر وفحص مستوى الكواشف والنفايات',
        outcome: issue ? 'issue' : 'ok',
        nextDueAt: new Date(performedAt.getTime() + (weekly ? 7 : 1) * DAY),
      });
    if (back % 14 === 3 && inst.model !== 'medica_easystat') {
      await db().insert(maintenanceLogs).values({
        labId: w.labId,
        instrumentId: inst.id,
        kind: 'calibration',
        performedAt: new Date(performedAt.getTime() + MIN),
        performedBy: tech.id,
        description: 'معايرة دورية بعد تغيير رقم التشغيلة',
        outcome: 'ok',
        nextDueAt: new Date(performedAt.getTime() + 14 * DAY),
      });
    }
  }
}

async function qcJob(w: World, c: { at: number; later: Later }, today: boolean): Promise<void> {
  const rng = w.rng;
  for (const [i, m] of w.qc.entries()) {
    const runAt = c.at + i * 2 * MIN;
    let z = rng.gauss() * 0.8;
    if (today && i === 0) z = 2.4;
    else if (rng.chance(0.015)) z = rng.pick([2.3, -2.4, 2.6]);
    else if (rng.chance(0.006)) z = 3.4;
    const value = Number((m.targetMean + z * m.targetSd).toFixed(m.targetMean < 10 ? 2 : 1));
    const run = await recordQcRun({ material: m, value, runAt: new Date(runAt), source: 'instrument', userId: w.people.tech.id });
    if (run.status === 'rejected') {
      c.later(runAt + 25 * MIN, 'tech', 'qc', async (r) => {
        const again = Number((m.targetMean + rng.gauss() * 0.5 * m.targetSd).toFixed(m.targetMean < 10 ? 2 : 1));
        await recordQcRun({ material: m, value: again, runAt: new Date(r.at), source: 'instrument', userId: w.people.tech.id, note: 'إعادة بعد المعايرة وتغيير الكاشف' });
      });
    }
  }
}

async function pay(w: World, invoiceId: string, amount: number): Promise<void> {
  const rng = w.rng;
  const cash = w.sessionOpen && rng.chance(0.82);
  const code = cash ? 'CASH' : rng.weighted([['CARD', 45], ['WALLET', 40], ['TRANSFER', 15]] as const);
  const methodId = w.methods[code] ?? w.methods.CARD;
  if (!methodId) return;
  await takePayment({ invoiceId, amount, methodId, idempotencyKey: `demo-${w.code}-${++w.payments}`, reference: cash ? null : `${code}-${rng.int(100_000, 999_999)}` });
}

async function createOrderJob(w: World, o: OrderSim, { at, later }: { at: number; later: Later }): Promise<void> {
  const rng = w.rng;
  const p = o.p;
  if (!p.id) p.id = (await createPatient(patientCreateInput.parse(p.draft))).id;
  const items = o.codes.map((code) => {
    const packageId = w.packageIds.get(code);
    if (packageId) return { packageId };
    const test = w.tests.get(code);
    if (!test) throw new Error(`Unknown test ${code}`);
    return { testId: test.id };
  });
  const spec = PROFILES[p.profile];
  const created = await createOrder(
    orderCreateInput.parse({
      patientId: p.id,
      payerGroupId: w.payers.get(p.payerCode) ?? w.payers.get('PUBLIC'),
      doctorId: o.doctor?.id ?? null,
      source: o.clientLab ? 'client_lab' : o.doctor ? 'referral' : rng.chance(0.03) ? 'home' : 'walk_in',
      externalRef: o.clientLab ? `NR-${rng.int(1000, 9999)}` : null,
      priority: o.priority,
      clinicalInfo: rng.chance(0.7) ? rng.pick(spec.clinicalAr) : null,
      fasting: o.codes.some((c) => FASTING_TESTS.has(c)) && rng.chance(0.7),
      pregnant: p.profile === 'pregnancy' && o.visit > 0,
      deliveryChannel: o.channel,
      branchId: w.branches.other && rng.chance(0.25) ? w.branches.other : w.branches.main,
      items,
      discount: o.discount,
    }),
    { canApproveDiscount: false },
  );
  o.id = created.id;
  o.invoiceId = created.invoice.id;
  await markLabelsPrinted(created.id);

  const ageDays = ageInDays(p.birthDate, new Date(at));
  o.picture = labPicture(analyteCodesOf(w, o.codes), p, o.visit, ageDays / 365.25, metaFor(w, p, ageDays), rng);
  for (const [code, value] of Object.entries(o.force ?? {})) o.picture.set(code, value);

  let paid = false;
  if (created.approvalId) {
    const approvalId = created.approvalId;
    if (!o.holdApproval) {
      later(workTime(at + rng.between(10, 60) * MIN, rng), 'manager', 'approval', () => decideApproval(approvalId, { approve: rng.chance(0.85), note: null }).then(() => undefined));
    }
  } else if (created.invoice.balance > 0) {
    const share = rng.weighted([[1, 62], [0.5, 18], [0, 20]] as const);
    const amount = share === 1 ? created.invoice.balance : Math.floor((created.invoice.balance * share) / 100) * 100;
    if (amount > 0) {
      await pay(w, created.invoice.id, amount);
      paid = true;
    }
  }
  if (!paid && !o.clientLab && !o.force && rng.chance(0.012)) {
    later(at + rng.between(4, 12) * MIN, 'reception', 'cancel', () => cancelOrder(o.id!, 'غادر المريض قبل سحب العينة').then(() => undefined));
    return;
  }
  later(at + rng.between(o.clientLab ? 1 : 3, o.clientLab ? 3 : 15) * MIN, 'tech', 'collect', (c) => collectJob(w, o, c));
}

async function collectJob(w: World, o: OrderSim, { at, later }: { at: number; later: Later }): Promise<void> {
  const tubes = await db().select({ id: samples.id }).from(samples).where(and(eq(samples.orderId, o.id!), eq(samples.status, 'pending')));
  if (!tubes.length) return;
  await collectSamples({ sampleIds: tubes.map((t) => t.id) }, { at: new Date(at) });
  const [lo, hi] = o.priority === 'stat' ? [2, 6] : o.clientLab ? [40, 150] : [5, 30];
  later(at + w.rng.between(lo, hi) * MIN, 'tech', 'receive', (c) => receiveJob(w, o, c));
}

async function receiveJob(w: World, o: OrderSim, { at, later }: { at: number; later: Later }): Promise<void> {
  const rng = w.rng;
  const tubes = await db()
    .select({ id: samples.id, barcode: samples.barcode, containerId: samples.containerId })
    .from(samples)
    .where(and(eq(samples.orderId, o.id!), eq(samples.status, 'collected')));
  if (!tubes.length) return;
  await receiveSamples(
    tubes.map((t) => t.barcode),
    { at: new Date(at) },
  );
  let received = tubes.map((t) => t.barcode);
  if (!o.force && rng.chance(0.025)) {
    const blood = tubes.filter((t) => !NON_BLOOD.has(w.containerCode.get(t.containerId) ?? ''));
    const reasons = w.reasons.filter((r) => ['HEMOLYZED', 'CLOTTED', 'QNS', 'LIPEMIC'].includes(r.code));
    if (blood.length && reasons.length) {
      const tube = rng.pick(blood);
      await rejectSample(tube.id, { reasonId: rng.pick(reasons).id, note: null, recollect: true }, { at: new Date(at + MIN) });
      received = received.filter((b) => b !== tube.barcode);
      later(at + rng.between(20, 60) * MIN, 'tech', 'collect', (c) => collectJob(w, o, c));
    }
  }
  await scheduleResults(w, o, received, at, later);
}

function actorFor(w: World, departmentId: string | null): Actor {
  return w.hemDeptId && departmentId === w.hemDeptId ? 'techHem' : 'tech';
}

function pickInstrument(w: World, o: OrderSim, analyteId: string): string | null {
  const list = w.instrumentsFor.get(analyteId);
  if (!list?.length) return null;
  if (o.priority !== 'routine') {
    const poc = list.find((id) => w.instruments.get(id)?.model === 'ichroma3');
    if (poc) return poc;
  }
  return list[Math.min(o.rank, list.length - 1)]!;
}

async function scheduleResults(w: World, o: OrderSim, barcodes: string[], receivedAt: number, later: Later): Promise<void> {
  if (!barcodes.length) return;
  const rng = w.rng;
  const rows = await db()
    .select({ id: results.id, analyteId: results.analyteId, testId: orderItems.testId })
    .from(results)
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .innerJoin(samples, eq(samples.id, orderItems.sampleId))
    .where(and(eq(results.orderId, o.id!), eq(results.status, 'pending'), inArray(samples.barcode, barcodes)));
  const groups = new Map<string, { at: number; instrumentId: string | null; actor: Actor; ids: string[] }>();
  for (const r of rows) {
    const a = w.analyteById.get(r.analyteId);
    if (!a || a.type === 'calculated') continue;
    const test = w.testById.get(r.testId);
    const cls = (test?.tatHours ?? 0) >= 48 ? 'long' : test && BATCH_TESTS.has(test.code) ? 'batch' : 'now';
    const instrumentId = cls === 'long' ? null : pickInstrument(w, o, r.analyteId);
    const key = `${instrumentId ?? `m:${test?.departmentId}`}|${cls}`;
    let g = groups.get(key);
    if (!g) {
      let at: number;
      if (cls === 'long') at = workTime(receivedAt + rng.between(44, 70) * HOUR, rng);
      else if (cls === 'batch') {
        const { hour, dayStart } = local(receivedAt);
        at = workTime(hour < 12 ? dayStart + rng.between(13, 16) * HOUR : dayStart + DAY + rng.between(10, 13) * HOUR, rng);
      } else {
        const [lo, hi] = o.priority === 'stat' ? [6, 15] : o.priority === 'urgent' ? [12, 35] : instrumentId ? [20, 90] : [30, 140];
        at = receivedAt + rng.between(lo, hi) * MIN;
      }
      g = { at, instrumentId, actor: instrumentId ? 'agent' : actorFor(w, test?.departmentId ?? null), ids: [] };
      groups.set(key, g);
    }
    g.ids.push(r.id);
  }
  for (const g of groups.values()) {
    const department = rows.find((r) => r.id === g.ids[0]);
    const verifier = actorFor(w, w.testById.get(department?.testId ?? '')?.departmentId ?? null);
    if (g.instrumentId) later(g.at, 'agent', 'analyzer', (c) => analyzerJob(w, o, g.instrumentId!, g.ids, verifier, c));
    else later(g.at, g.actor, 'manual', (c) => manualJob(w, o, g.ids, verifier, c));
  }
}

function valueFor(w: World, o: OrderSim, code: string): string | number | null {
  const known = o.picture?.get(code);
  if (known !== undefined) return known;
  const ageDays = ageInDays(o.p.birthDate, new Date(o.at));
  const extra = labPicture([code], o.p, o.visit, ageDays / 365.25, metaFor(w, o.p, ageDays), w.rng);
  return extra.get(code) ?? null;
}

async function pendingOf(ids: string[]) {
  return db()
    .select({ id: results.id, analyteId: results.analyteId, barcode: samples.barcode })
    .from(results)
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .innerJoin(samples, eq(samples.id, orderItems.sampleId))
    .where(and(inArray(results.id, ids), eq(results.status, 'pending')));
}

async function analyzerJob(w: World, o: OrderSim, instrumentId: string, ids: string[], verifier: Actor, { at, later }: { at: number; later: Later }): Promise<void> {
  const rng = w.rng;
  const inst = w.instruments.get(instrumentId)!;
  let pending = await pendingOf(ids);
  if (!pending.length) return;
  // Part of the last two days went through the simulated analyzer link (frames, messages,
  // mapping); everything else is applied the way the link applies it, without the wire traffic.
  const codes = pending.map((r) => w.analyteById.get(r.analyteId)?.code ?? '');
  if (at >= w.todayStart - DAY && !o.force && !codes.some((c) => COHERENT.has(c)) && rng.chance(0.5)) {
    const barcodes = [...new Set(pending.map((r) => r.barcode))].slice(0, 5);
    await savepoint(() => simulateOnInstrument(inst, simulateBody.parse({ mode: 'normal', barcodes, fault: 'none', seed: rng.int(1, 2_000_000_000) })));
    pending = await pendingOf(ids);
  }
  for (const r of pending) {
    const code = w.analyteById.get(r.analyteId)?.code ?? '';
    await applyResultValue({
      resultId: r.id,
      value: valueFor(w, o, code),
      source: 'instrument',
      instrumentId,
      measuredAt: new Date(at - rng.int(1, 4) * MIN),
      skipRefresh: true,
    });
  }
  await refreshOrderStatus(o.id!);
  later(at + rng.between(4, 25) * MIN, verifier, 'verify', (c) => verifyJob(w, o, ids, c));
}

async function manualJob(w: World, o: OrderSim, ids: string[], verifier: Actor, { at, later }: { at: number; later: Later }): Promise<void> {
  const pending = await pendingOf(ids);
  if (!pending.length) return;
  await enterResults(
    pending.map((r) => ({ resultId: r.id, value: valueFor(w, o, w.analyteById.get(r.analyteId)?.code ?? '') })),
  );
  later(at + w.rng.between(3, 20) * MIN, verifier, 'verify', (c) => verifyJob(w, o, ids, c));
}

async function verifyJob(w: World, o: OrderSim, ids: string[], { at, later }: { at: number; later: Later }): Promise<void> {
  const calculated = await db()
    .select({ id: results.id })
    .from(results)
    .innerJoin(analytes, eq(analytes.id, results.analyteId))
    .where(and(eq(results.orderId, o.id!), eq(results.status, 'resulted'), eq(analytes.resultType, 'calculated')));
  const mine = await db()
    .select({ id: results.id })
    .from(results)
    .where(and(inArray(results.id, ids), eq(results.status, 'resulted')));
  const toVerify = [...mine, ...calculated].map((r) => r.id);
  if (toVerify.length) await verifyResults(toVerify, {}, { at: new Date(at) });

  // Release waits for everything except cultures, which follow as a second report version.
  const [left] = await db()
    .select({ n: count() })
    .from(results)
    .innerJoin(orderItems, eq(orderItems.id, results.orderItemId))
    .innerJoin(tests, eq(tests.id, orderItems.testId))
    .where(and(eq(results.orderId, o.id!), inArray(results.status, ['pending', 'resulted']), ne(orderItems.status, 'cancelled'), lt(tests.tatHours, 48)));
  if (Number(left?.n ?? 0) > 0 || o.holdValidation || !toVerify.length) return;
  const [lo, hi] = o.priority === 'stat' ? [4, 12] : o.priority === 'urgent' ? [10, 30] : [15, 100];
  const validator: Actor = w.rng.chance(0.2) ? 'owner' : 'doctor';
  later(workTime(at + w.rng.between(lo, hi) * MIN, w.rng), validator, 'validate', (c) => validateJob(w, o, c));
}

async function validateJob(w: World, o: OrderSim, { at, later }: { at: number; later: Later }): Promise<void> {
  const rng = w.rng;
  const rows = await db()
    .select({ id: results.id, isCritical: results.isCritical })
    .from(results)
    .where(and(eq(results.orderId, o.id!), eq(results.status, 'verified')));
  if (!rows.length) return;
  const critical = rows.filter((r) => r.isCritical).map((r) => r.id);
  if (critical.length) {
    const called = new Set((await db().select({ id: criticalCalls.resultId }).from(criticalCalls).where(inArray(criticalCalls.resultId, critical))).map((c) => c.id));
    for (const id of critical.filter((c) => !called.has(c))) {
      const d = o.doctor;
      await recordCriticalCall(
        id,
        d
          ? { recipientName: d.nameAr, recipientRole: 'doctor', phone: d.phone, readBack: true, note: 'تمت قراءة القيمة وتأكيدها' }
          : { recipientName: `${o.p.draft.firstNameAr} ${o.p.draft.lastNameAr}`, recipientRole: 'patient', phone: o.p.draft.phone ?? null, readBack: true, note: 'نُصح بمراجعة الطبيب فوراً' },
        { at: new Date(at) },
      );
    }
  }
  await validateResults(
    rows.map((r) => r.id),
    {},
    { at: new Date(at) },
  );
  await releaseReport(o.id!, {}, { at: new Date(at + MIN) });

  const [order] = await db().select({ status: orders.status }).from(orders).where(eq(orders.id, o.id!));
  if (order?.status === 'completed') {
    const { hour, dow } = local(at);
    const r = rng();
    let when: number | null;
    if (o.clientLab) when = workTime(at + rng.between(30, 180) * MIN, rng);
    else if (r < 0.45 && hour < (dow === 5 ? 12 : 17.5)) when = at + rng.between(15, 120) * MIN;
    else if (r < 0.9) when = workTime(local(at).dayStart + DAY + rng.between(9, 19) * HOUR, rng);
    else if (r < 0.97) when = workTime(local(at).dayStart + rng.int(2, 4) * DAY + rng.between(9, 18) * HOUR, rng);
    else when = null;
    if (when !== null) later(when, 'reception', 'deliver', (c) => deliverJob(w, o, c));
  }
  if (rng.chance(0.006)) {
    later(workTime(local(at).dayStart + DAY + rng.between(10, 12) * HOUR, rng), 'doctor', 'amend', (c) => amendJob(w, o, c));
  }
}

async function deliverJob(w: World, o: OrderSim, { at }: { at: number; later: Later }): Promise<void> {
  void at;
  const [inv] = await db().select().from(invoices).where(eq(invoices.orderId, o.id!));
  if (inv && inv.status !== 'void') {
    const due = balanceOf(inv, inv.currency);
    if (due > 0) await pay(w, inv.id, due);
  }
  await deliverReport(o.id!, { channel: o.channel });
}

async function amendJob(w: World, o: OrderSim, { at }: { at: number; later: Later }): Promise<void> {
  const rng = w.rng;
  const rows = await db()
    .select({ id: results.id, value: results.valueNum, decimals: analytes.decimals })
    .from(results)
    .innerJoin(analytes, eq(analytes.id, results.analyteId))
    .where(and(eq(results.orderId, o.id!), eq(results.status, 'released'), eq(analytes.resultType, 'numeric')));
  const target = rows.filter((r) => r.value !== null && r.value > 0);
  if (!target.length) return;
  const r = rng.pick(target);
  const factor = 10 ** r.decimals;
  const value = Math.round(r.value! * (1 + rng.pick([-1, 1]) * rng.between(0.04, 0.09)) * factor) / factor;
  await amendResult(r.id, { value, reason: 'تصحيح خطأ إدخال بعد إعادة التحقق من العينة' }, { at: new Date(at) });
}

/* ================================================================== run */

async function runLab(labId: string, def: LabDef, todayStart: number, stopAt: number): Promise<void> {
  const started = realNow();
  const w = await loadWorld(labId, def, todayStart, stopAt);
  const q = new EventQueue();
  planDays(w, q);
  const planned = planOrders(w, def);
  for (const o of planned) q.push(o.at, 'reception', 'order', (c) => createOrderJob(w, o, c));
  console.log(`  ${def.code}: ${planned.length} visits planned over ${DAYS_BACK + 1} days`);

  let shown = 0;
  while (q.size) {
    const ev = q.pop()!;
    if (ev.at > w.stopAt) {
      w.stats.skipped++;
      continue;
    }
    const followUps: Array<[number, Actor, string, Job]> = [];
    setSimTime(ev.at);
    try {
      const who = w.people[ev.actor];
      await withLab(w.labId, { userId: who.id, actorName: who.nameEn }, async () => {
        await db().execute(sql`select set_config('app.sim_now', ${new Date(ev.at).toISOString()}, true)`);
        await ev.job({ at: ev.at, later: (at, actor, kind, job) => followUps.push([at, actor, kind, job]) });
      });
      for (const f of followUps) q.push(...f);
      w.stats.done++;
    } catch (err) {
      w.stats.failed++;
      const message = `${ev.kind}: ${(err as Error).message}`;
      w.stats.errors.set(message, (w.stats.errors.get(message) ?? 0) + 1);
      if (shown++ < 5) console.error(`    ✗ ${dayKey(ev.at)} ${message}`);
    }
  }
  clearSimTime();

  const summary = await withLab(labId, {}, async () => {
    const byStatus = await db().select({ status: orders.status, n: count() }).from(orders).groupBy(orders.status);
    const [res] = await db().select({ n: count() }).from(results);
    return { byStatus, results: Number(res?.n ?? 0) };
  });
  const statuses = summary.byStatus.map((s) => `${s.status} ${s.n}`).join(', ');
  const seconds = ((realNow() - started) / 1000).toFixed(0);
  console.log(`  ✓ ${def.code}: ${w.stats.done} steps, ${summary.results} results (${statuses}) in ${seconds}s`);
  if (w.stats.failed) {
    console.log(`    ${w.stats.failed} step(s) failed:`);
    for (const [message, n] of w.stats.errors) console.log(`      ${n}× ${message}`);
  }
  failures += w.stats.failed;
  steps += w.stats.done + w.stats.failed;
}

let failures = 0;
let steps = 0;

/** While the seed runs, database defaults like created_at use the simulated time too. */
async function simulatedDefaults(owner: ReturnType<typeof createDb>, on: boolean): Promise<void> {
  const cols = await owner.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and (column_default ilike 'now()%' or column_default ilike '%app.sim_now%')`);
  const expr = on ? sql.raw(`coalesce(nullif(current_setting('app.sim_now', true), '')::timestamptz, now())`) : sql.raw('now()');
  for (const c of cols.rows) {
    await owner.execute(sql`alter table ${sql.identifier(c.table_name)} alter column ${sql.identifier(c.column_name)} set default ${expr}`);
  }
}

async function main(): Promise<void> {
  // Outside opening hours the demo day stops shortly before closing (today after closing time,
  // yesterday before opening), so the work queues still show every stage.
  const real = realNow() - MIN;
  const now = local(real);
  const todayStart = now.hour < 8 ? now.dayStart - DAY : now.dayStart;
  const closing = local(todayStart + HOUR).dow === 5 ? 13 : 18.5;
  const stopAt = now.hour < 8 || now.hour > closing + 1 ? todayStart + closing * HOUR : real;
  const ownerPool = createPool(OWNER_URL, 2);
  const owner = createDb(ownerPool);
  try {
    const labRows = await owner.select({ id: labs.id, code: labs.code }).from(labs);
    if (!labRows.length) throw new Error('No labs found: run the base seed first (pnpm db:reset).');
    console.log('Writing demo history (simulated clock)…');
    await simulatedDefaults(owner, true);
    try {
      for (const def of LABS) {
        const lab = labRows.find((l) => l.code === def.code);
        if (lab) await runLab(lab.id, def, todayStart, stopAt);
      }
    } finally {
      clearSimTime();
      await simulatedDefaults(owner, false);
    }
    // Earlier alerts have been seen; messages "sent" a minute after they were queued.
    await owner.execute(sql`update notifications set read_at = created_at + interval '25 minutes' where read_at is null and created_at < ${new Date(todayStart)}`);
    await owner.execute(sql`update outbox_messages set status = 'simulated', attempts = greatest(attempts, 1), sent_at = created_at + interval '1 minute' where status in ('pending', 'simulated')`);
  } finally {
    await ownerPool.end();
    await appPool.end();
  }
  console.log(failures ? `Done with ${failures} failed step(s) out of ${steps}.` : `Done: ${steps} steps.`);
  if (failures > steps * 0.01) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

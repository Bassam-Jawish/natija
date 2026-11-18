/**
 * Fictional people and clinically plausible values for the demo history seed. Names are common
 * Syrian first and family names put together at random; phone numbers use the unassigned 0900
 * prefix and e-mail addresses the reserved example.com domain, so nothing points at a real person.
 */

/* ================================================================== random */

export type Rng = {
  (): number;
  int(min: number, max: number): number;
  between(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T;
  gauss(): number;
};

/** mulberry32: small, fast and repeatable for the same seed. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = next as Rng;
  rng.int = (min, max) => min + Math.floor(next() * (max - min + 1));
  rng.between = (min, max) => min + next() * (max - min);
  rng.chance = (p) => next() < p;
  rng.pick = (items) => items[Math.floor(next() * items.length)]!;
  rng.weighted = (items) => {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let r = next() * total;
    for (const [value, w] of items) {
      r -= w;
      if (r <= 0) return value;
    }
    return items[items.length - 1]![0];
  };
  rng.gauss = () => {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return rng;
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ================================================================== profiles */

export type Profile =
  | 'healthy'
  | 'diabetic'
  | 'ckd'
  | 'anemia'
  | 'thyroid'
  | 'infection'
  | 'liver'
  | 'pregnancy'
  | 'uti'
  | 'brucella'
  | 'cardiac'
  | 'anticoag'
  | 'premarital'
  | 'child'
  | 'icu';

export type ProfileSpec = {
  weight: number;
  femaleShare: number;
  age: [number, number];
  /** Test and package codes ordered at the first visit (one menu picked at random). */
  menus: string[][];
  /** Later visits: days between visits, the chance of coming back each time, and what is ordered. */
  followUp?: { every: [number, number]; chance: number; menus?: string[][] };
  /** Preferred referring doctors (doctor specialty in English). */
  specialties: string[];
  /** Medical history noted on the patient record. */
  historyAr?: string[];
  /** Clinical information typed at reception. */
  clinicalAr: string[];
  urgent?: number;
  stat?: number;
};

export const PROFILES: Record<Profile, ProfileSpec> = {
  healthy: {
    weight: 24,
    femaleShare: 0.55,
    age: [18, 72],
    menus: [['CHECKUP'], ['CBC', 'GLU', 'LIPID'], ['CBC', 'VITD', 'B12'], ['CBC', 'TSH', 'VITD', 'FERR'], ['GLU', 'CREA', 'UREA', 'ALT', 'AST'], ['CBC', 'ESR', 'CRP'], ['LIPID', 'GLU', 'HBA1C'], ['CBC', 'URINE']],
    followUp: { every: [10, 24], chance: 0.25, menus: [['VITD'], ['CBC'], ['LIPID', 'GLU']] },
    specialties: ['Family medicine', 'Internal medicine'],
    clinicalAr: ['فحص دوري', 'تعب عام', 'متابعة نقص فيتامين د', 'فحص قبل السفر'],
  },
  diabetic: {
    weight: 13,
    femaleShare: 0.5,
    age: [35, 78],
    menus: [['DIABETES'], ['GLU', 'HBA1C'], ['GLU', 'HBA1C', 'CREA', 'LIPID', 'URINE']],
    followUp: { every: [12, 26], chance: 0.85, menus: [['GLU', 'HBA1C'], ['DIABETES'], ['GLU']] },
    specialties: ['Endocrinology', 'Internal medicine'],
    historyAr: ['سكري نمط ثاني - ميتفورمين', 'سكري نمط ثاني - أنسولين قاعدي', 'سكري نمط ثاني وارتفاع ضغط'],
    clinicalAr: ['متابعة سكري', 'مراقبة السكر التراكمي', 'ارتفاع سكر صيامي'],
  },
  ckd: {
    weight: 5,
    femaleShare: 0.45,
    age: [45, 80],
    menus: [['KIDNEY', 'ELEC', 'CBC'], ['CREA', 'UREA', 'ELEC', 'CA', 'PHOS']],
    followUp: { every: [6, 12], chance: 0.9, menus: [['CREA', 'UREA', 'ELEC'], ['KIDNEY', 'ELEC']] },
    specialties: ['Nephrology'],
    historyAr: ['قصور كلوي مزمن - المرحلة الثالثة', 'قصور كلوي مزمن مع ارتفاع ضغط'],
    clinicalAr: ['متابعة وظائف الكلية', 'مراقبة البوتاسيوم'],
  },
  anemia: {
    weight: 7,
    femaleShare: 0.8,
    age: [16, 55],
    menus: [['CBC', 'FERR', 'IRON', 'RETIC'], ['CBC', 'FERR', 'B12'], ['CBC']],
    followUp: { every: [14, 24], chance: 0.7, menus: [['CBC', 'FERR'], ['CBC']] },
    specialties: ['Hematology', 'Internal medicine', 'Obstetrics & gynaecology'],
    clinicalAr: ['تعب وشحوب', 'متابعة فقر دم بعوز الحديد', 'دوخة وخفقان'],
  },
  thyroid: {
    weight: 7,
    femaleShare: 0.8,
    age: [22, 65],
    menus: [['THYROID'], ['TSH', 'FT4'], ['TSH']],
    followUp: { every: [21, 32], chance: 0.45, menus: [['TSH', 'FT4'], ['TSH']] },
    specialties: ['Endocrinology'],
    historyAr: ['قصور درق - ليفوثيروكسين', 'عقيدات درقية'],
    clinicalAr: ['متابعة قصور الدرق', 'خفقان ونقص وزن', 'تعب وزيادة وزن'],
  },
  infection: {
    weight: 11,
    femaleShare: 0.5,
    age: [14, 75],
    menus: [['CBC', 'CRP', 'ESR'], ['CBC', 'CRP'], ['CBC', 'CRP', 'PCT'], ['CBC', 'CRP', 'URINE']],
    followUp: { every: [3, 7], chance: 0.35, menus: [['CBC', 'CRP']] },
    specialties: ['Family medicine', 'Internal medicine'],
    clinicalAr: ['حرارة منذ ثلاثة أيام', 'سعال وحرارة', 'التهاب لوزات', 'ألم حلق وقشعريرة'],
    urgent: 0.15,
  },
  liver: {
    weight: 4,
    femaleShare: 0.4,
    age: [25, 70],
    menus: [['LFT', 'HBSAG', 'HCV'], ['LFT'], ['ALT', 'AST', 'PT']],
    followUp: { every: [10, 20], chance: 0.5, menus: [['LFT'], ['ALT', 'AST']] },
    specialties: ['Gastroenterology', 'Internal medicine'],
    clinicalAr: ['ارتفاع خمائر الكبد', 'اصفرار خفيف بالعينين', 'متابعة التهاب كبد'],
  },
  pregnancy: {
    weight: 6,
    femaleShare: 1,
    age: [19, 39],
    menus: [['BHCG'], ['CBC', 'ABO', 'GLU', 'URINE', 'TSH']],
    followUp: { every: [14, 28], chance: 0.7, menus: [['CBC', 'URINE'], ['GLU', 'CBC']] },
    specialties: ['Obstetrics & gynaecology'],
    clinicalAr: ['متابعة حمل', 'تأخر الطمث', 'حمل - الثلث الثاني'],
  },
  uti: {
    weight: 6,
    femaleShare: 0.75,
    age: [18, 75],
    menus: [['URINE', 'UCULT'], ['URINE'], ['URINE', 'CBC', 'CREA']],
    followUp: { every: [7, 14], chance: 0.3, menus: [['URINE', 'UCULT']] },
    specialties: ['Urology', 'Family medicine'],
    clinicalAr: ['حرقة بولية', 'ألم خاصرة', 'تكرار تبول'],
  },
  brucella: {
    weight: 3,
    femaleShare: 0.4,
    age: [15, 65],
    menus: [['CBC', 'ESR', 'BRUC', 'WIDAL', 'CRP'], ['BRUC', 'WIDAL']],
    followUp: { every: [14, 21], chance: 0.3, menus: [['BRUC']] },
    specialties: ['Internal medicine', 'Family medicine'],
    clinicalAr: ['حرارة متموجة وآلام مفاصل', 'تعرق ليلي وحرارة', 'تناول حليب غير مبستر'],
  },
  cardiac: {
    weight: 3,
    femaleShare: 0.3,
    age: [42, 80],
    menus: [['TNI', 'CK', 'LDH', 'ELEC', 'GLU'], ['TNI', 'DDIMER', 'PT', 'APTT'], ['LIPID', 'GLU', 'CREA', 'TNI']],
    followUp: { every: [3, 10], chance: 0.4, menus: [['TNI', 'CK'], ['LIPID', 'GLU']] },
    specialties: ['Cardiology'],
    historyAr: ['ارتفاع ضغط وشحوم', 'قصة إقفار قلبي'],
    clinicalAr: ['ألم صدري منذ الصباح', 'زلة تنفسية', 'ألم صدري عند الجهد'],
    urgent: 0.3,
    stat: 0.35,
  },
  anticoag: {
    weight: 4,
    femaleShare: 0.45,
    age: [45, 80],
    menus: [['PT', 'CBC'], ['PT']],
    followUp: { every: [6, 10], chance: 0.95, menus: [['PT']] },
    specialties: ['Cardiology', 'Hematology'],
    historyAr: ['يتناول الوارفارين - رجفان أذيني', 'صمام قلبي معدني - وارفارين'],
    clinicalAr: ['مراقبة INR', 'تعديل جرعة الوارفارين'],
  },
  premarital: {
    weight: 3,
    femaleShare: 0.5,
    age: [20, 34],
    menus: [['PREMARITAL']],
    specialties: [],
    clinicalAr: ['فحوص ما قبل الزواج'],
  },
  child: {
    weight: 5,
    femaleShare: 0.5,
    age: [1, 11],
    menus: [['CBC', 'STOOL'], ['STOOL'], ['URINE'], ['CBC', 'CRP']],
    followUp: { every: [5, 14], chance: 0.2, menus: [['STOOL'], ['CBC']] },
    specialties: ['Paediatrics'],
    clinicalAr: ['ألم بطن وإسهال', 'قلة شهية', 'حرارة وسعال'],
    urgent: 0.1,
  },
  icu: {
    weight: 1,
    femaleShare: 0.4,
    age: [50, 85],
    menus: [['ABG', 'ELEC'], ['ABG', 'ELEC', 'GLU', 'CREA', 'UREA']],
    followUp: { every: [1, 2], chance: 0.6, menus: [['ABG', 'ELEC']] },
    specialties: ['General surgery', 'Internal medicine'],
    clinicalAr: ['مريض عناية مشددة - قصور تنفسي', 'بعد عمل جراحي - مراقبة غازات'],
    stat: 0.8,
  },
};

/* ================================================================== people */

const MALE: Array<[string, string]> = [
  ['محمد', 'Mohammad'], ['أحمد', 'Ahmad'], ['علي', 'Ali'], ['عمر', 'Omar'], ['خالد', 'Khaled'], ['يوسف', 'Youssef'],
  ['حسن', 'Hassan'], ['حسين', 'Hussein'], ['سامر', 'Samer'], ['ماهر', 'Maher'], ['باسل', 'Basel'], ['فادي', 'Fadi'],
  ['رامي', 'Rami'], ['طارق', 'Tarek'], ['زياد', 'Ziad'], ['مازن', 'Mazen'], ['وائل', 'Wael'], ['هاني', 'Hani'],
  ['جورج', 'George'], ['إلياس', 'Elias'], ['كريم', 'Karim'], ['سليم', 'Salim'], ['أيمن', 'Ayman'], ['فراس', 'Firas'],
  ['غيث', 'Ghaith'], ['مهند', 'Muhannad'], ['عبد الله', 'Abdullah'], ['نبيل', 'Nabil'], ['جميل', 'Jamil'], ['ربيع', 'Rabih'],
];
const FEMALE: Array<[string, string]> = [
  ['فاطمة', 'Fatima'], ['مريم', 'Maryam'], ['سارة', 'Sara'], ['رنا', 'Rana'], ['لمى', 'Lama'], ['هبة', 'Hiba'],
  ['ريم', 'Reem'], ['نور', 'Nour'], ['دانة', 'Dana'], ['لينا', 'Lina'], ['سلمى', 'Salma'], ['رهف', 'Rahaf'],
  ['جود', 'Joud'], ['ميس', 'Mais'], ['ديما', 'Dima'], ['رولا', 'Rula'], ['سوزان', 'Suzan'], ['هالة', 'Hala'],
  ['منى', 'Mona'], ['عبير', 'Abeer'], ['نسرين', 'Nisreen'], ['ياسمين', 'Yasmin'], ['غادة', 'Ghada'], ['ربا', 'Ruba'],
  ['سمر', 'Samar'], ['كندة', 'Kinda'], ['تالا', 'Tala'], ['ليال', 'Layal'], ['رشا', 'Rasha'], ['وعد', 'Waad'],
];
const FAMILY: Array<[string, string]> = [
  ['الأحمد', 'Al-Ahmad'], ['الخطيب', 'Al-Khatib'], ['حداد', 'Haddad'], ['الشامي', 'Al-Shami'], ['العلي', 'Al-Ali'],
  ['السيد', 'Al-Sayed'], ['قاسم', 'Qassem'], ['مراد', 'Murad'], ['سليمان', 'Suleiman'], ['درويش', 'Darwish'],
  ['عيسى', 'Issa'], ['حمدان', 'Hamdan'], ['الحلبي', 'Al-Halabi'], ['الحموي', 'Al-Hamawi'], ['شحادة', 'Shehadeh'],
  ['كرم', 'Karam'], ['الزعبي', 'Al-Zoubi'], ['عطية', 'Atieh'], ['بكور', 'Bakkour'], ['النجار', 'Al-Najjar'],
  ['العمر', 'Al-Omar'], ['الحسن', 'Al-Hassan'], ['الصباغ', 'Al-Sabbagh'], ['الدباغ', 'Al-Dabbagh'], ['القباني', 'Al-Qabbani'],
  ['الجابي', 'Al-Jabi'], ['المصري', 'Al-Masri'], ['الرفاعي', 'Al-Rifai'], ['الحكيم', 'Al-Hakim'], ['البيطار', 'Al-Bitar'],
  ['خوري', 'Khoury'], ['نصر', 'Nasr'], ['سعادة', 'Saadeh'], ['عثمان', 'Othman'], ['الطويل', 'Al-Taweel'],
  ['الفارس', 'Al-Fares'], ['الكردي', 'Al-Kurdi'], ['الإدلبي', 'Al-Idlibi'], ['العطار', 'Al-Attar'], ['الحمصي', 'Al-Homsi'],
];
const AREAS: Record<string, { cityAr: string; areas: string[] }> = {
  Damascus: { cityAr: 'دمشق', areas: ['المزة', 'كفرسوسة', 'المالكي', 'باب توما', 'الميدان', 'ركن الدين', 'المهاجرين', 'جرمانا', 'دمر', 'برزة', 'الشعلان'] },
  Hama: { cityAr: 'حماة', areas: ['ساحة العاصي', 'الحاضر', 'طريق حلب', 'باب قبلي', 'الأربعين', 'جنوب الملعب', 'البارودية'] },
  Aleppo: { cityAr: 'حلب', areas: ['العزيزية', 'الجميلية', 'السليمانية', 'حلب الجديدة', 'الشهباء', 'الفرقان', 'الموكامبو', 'المحافظة'] },
};

export type PatientDraft = {
  firstNameAr: string;
  fatherNameAr: string;
  motherNameAr: string;
  lastNameAr: string;
  firstNameEn?: string;
  lastNameEn?: string;
  sex: 'male' | 'female';
  birthDate?: string;
  age?: { value: number; unit: 'years' };
  phone?: string;
  contactPref: 'whatsapp' | 'sms' | 'call' | 'none';
  email?: string;
  nationalId?: string;
  address?: string;
  notes?: string;
};

export type SimPatient = {
  key: number;
  profile: Profile;
  sex: 'male' | 'female';
  /** Approximate birth date, used to pick reference values. */
  birthDate: Date;
  draft: PatientDraft;
  payerCode: string;
  /** Lasting facts about the person (blood group, which variant of the condition...). */
  traits: Map<string, string | number | boolean>;
  /** Lasting deviation from the mean for each analyte, so repeat visits look like the same person. */
  z: Map<string, number>;
  visits: number;
  id?: string;
};

const PAYER_WEIGHTS: Array<readonly [string, number]> = [
  ['PUBLIC', 68],
  ['WAHA_GOLD', 5],
  ['WAHA_STD', 5],
  ['NAJM', 4],
  ['UNION', 6],
  ['STAFF', 3],
  ['NOOR', 9],
];

export function pickProfile(rng: Rng): Profile {
  return rng.weighted(Object.entries(PROFILES).map(([k, v]) => [k as Profile, v.weight] as const));
}

const pad = (n: number, len: number) => String(n).padStart(len, '0');

export function makePatient(rng: Rng, key: number, profile: Profile, city: string, asOf: Date): SimPatient {
  const spec = PROFILES[profile];
  const sex = rng.chance(spec.femaleShare) ? 'female' : 'male';
  const ageYears = rng.int(spec.age[0], spec.age[1]);
  const birthDate = new Date(asOf.getTime() - (ageYears * 365.25 + rng.int(0, 360)) * 86_400_000);
  const [firstAr, firstEn] = rng.pick(sex === 'male' ? MALE : FEMALE);
  const [lastAr, lastEn] = rng.pick(FAMILY);
  const area = AREAS[city] ?? AREAS.Damascus!;
  const contactPref = rng.weighted([['whatsapp', 62], ['sms', 8], ['call', 18], ['none', 12]] as const);
  const draft: PatientDraft = {
    firstNameAr: firstAr,
    fatherNameAr: rng.pick(MALE)[0],
    motherNameAr: rng.pick(FEMALE)[0],
    lastNameAr: lastAr,
    sex,
    contactPref,
  };
  if (rng.chance(0.7)) {
    draft.firstNameEn = firstEn;
    draft.lastNameEn = lastEn;
  }
  if (rng.chance(0.65)) draft.birthDate = birthDate.toISOString().slice(0, 10);
  else draft.age = { value: ageYears, unit: 'years' };
  if (contactPref !== 'none' || rng.chance(0.5)) draft.phone = `0900${pad(rng.int(0, 999_999), 6)}`;
  if (ageYears >= 18 && rng.chance(0.12)) draft.email = `${firstEn}.${lastEn}${rng.int(1, 99)}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + '@example.com';
  if (ageYears >= 18 && rng.chance(0.25)) draft.nationalId = `0${pad(rng.int(0, 9_999_999_999), 10)}`;
  if (rng.chance(0.6)) draft.address = `${area.cityAr} - ${rng.pick(area.areas)}`;
  if (spec.historyAr && rng.chance(0.75)) draft.notes = rng.pick(spec.historyAr);

  const payerCode = profile === 'premarital' || profile === 'icu' ? 'PUBLIC' : rng.weighted(PAYER_WEIGHTS);
  const traits = new Map<string, string | number | boolean>();
  traits.set('ABO', rng.weighted([['O', 38], ['A', 33], ['B', 20], ['AB', 9]] as const));
  traits.set('RH', rng.chance(0.9) ? 'Positive' : 'Negative');
  return { key, profile, sex, birthDate, draft, payerCode, traits, z: new Map(), visits: 0 };
}

/* ================================================================== values */

export type AnalyteMeta = {
  type: 'numeric' | 'text' | 'option' | 'calculated';
  decimals: number;
  options: string[] | null;
  low: number | null;
  high: number | null;
};

type Stat = [mean: number, sd: number];

/** Typical values in a healthy adult population (before a profile changes them). */
function population(code: string, p: SimPatient, ageYears: number): Stat | null {
  const male = p.sex === 'male';
  const child = ageYears < 12;
  switch (code) {
    case 'GLU': return [92, 9];
    case 'HBA1C': return [5.3, 0.3];
    case 'UREA': return child ? [24, 5] : [30, 7];
    case 'CREA': return child ? [0.45, 0.08] : male ? [0.95, 0.13] : [0.75, 0.11];
    case 'UA': return male ? [5.6, 1.0] : [4.4, 0.9];
    case 'CHOL': return [192, 33];
    case 'TG': return [132, 50];
    case 'HDL': return male ? [45, 8] : [55, 10];
    case 'ALT': return male ? [24, 9] : [18, 7];
    case 'AST': return male ? [24, 7] : [20, 6];
    case 'ALP': return child ? [220, 50] : [78, 20];
    case 'GGT': return male ? [28, 12] : [18, 8];
    case 'TBIL': return [0.65, 0.22];
    case 'DBIL': return [0.15, 0.06];
    case 'TP': return [7.2, 0.35];
    case 'ALB': return [4.4, 0.3];
    case 'NA': return [140, 2];
    case 'K': return [4.3, 0.3];
    case 'CL': return [102, 2.2];
    case 'CA': return [9.4, 0.35];
    case 'MG': return [2.1, 0.18];
    case 'PHOS': return child ? [5.2, 0.5] : [3.5, 0.45];
    case 'CRP': return [2.2, 1.5];
    case 'IRON': return male ? [105, 28] : [88, 26];
    case 'AMY': return [58, 18];
    case 'CK': return male ? [135, 55] : [92, 38];
    case 'LDH': return [182, 24];
    case 'TSH': return [1.8, 0.75];
    case 'FT4': return [1.25, 0.14];
    case 'FT3': return [3.1, 0.38];
    case 'VITD': return [19, 8.5];
    case 'B12': return [335, 120];
    case 'FERR': return male ? [125, 60] : [42, 25];
    case 'PSA': return [1.1, 0.7];
    case 'BHCG': return male ? [0.6, 0.3] : [1.0, 0.6];
    case 'PRL': return male ? [9, 3] : [13, 4.5];
    case 'INS': return [9, 4];
    case 'PCT': return [0.05, 0.02];
    case 'TNI': return [0.008, 0.005];
    case 'DDIMER': return [260, 110];
    case 'RF': return [6, 3.5];
    case 'ASO': return [95, 55];
    case 'PT': return [12.3, 0.55];
    case 'APTT': return [30, 2.4];
    case 'ESR': return male ? [8, 4.5] : [12, 5.5];
    case 'RETIC': return [1.2, 0.35];
    case 'U_SG': return [1.018, 0.0055];
    case 'U_PH': return [6.0, 0.55];
    case 'U_WBC': return [2, 1.4];
    case 'U_RBC': return [0.8, 0.8];
    case 'S_WBC': return [0.5, 0.6];
    default: return null;
  }
}

function fromRange(m: AnalyteMeta | undefined): Stat {
  if (!m) return [1, 0.2];
  if (m.low !== null && m.high !== null) return [(m.low + m.high) / 2, (m.high - m.low) / 4.4];
  if (m.high !== null) return [m.high * 0.5, m.high * 0.2];
  if (m.low !== null) return [m.low * 1.35, m.low * 0.2];
  return [1, 0.2];
}

/** How the patient's condition shifts the values at this visit (0 = first visit). */
function conditionShifts(p: SimPatient, visit: number, rng: Rng): Record<string, Stat> {
  const o: Record<string, Stat> = {};
  const trait = (key: string, chance: number) => {
    if (!p.traits.has(key)) p.traits.set(key, rng.chance(chance));
    return p.traits.get(key) === true;
  };
  const t = Math.min(visit, 4);
  switch (p.profile) {
    case 'diabetic':
      o.GLU = [178 - 12 * t, 42];
      o.HBA1C = [8.5 - 0.3 * t, 0.8];
      o.CHOL = [214, 34];
      o.TG = [196, 58];
      o.HDL = [40, 7];
      o.CREA = [1.1, 0.22];
      o.INS = [19, 6];
      if (rng.chance(0.03)) o.GLU = [532, 22];
      break;
    case 'ckd':
      o.CREA = [2.5 + 0.06 * t, 0.45];
      o.UREA = [88, 20];
      o.K = [5.3, 0.3];
      o.CA = [8.3, 0.35];
      o.PHOS = [5.2, 0.55];
      o.UA = [7.9, 1.0];
      o.HGB = [10.4, 0.8];
      if (rng.chance(0.08)) o.K = [6.8, 0.12];
      break;
    case 'anemia': {
      const severe = trait('severe', 0.08) && visit === 0;
      o.HGB = severe ? [6.5, 0.15] : [(p.sex === 'female' ? 9.3 : 10.4) + 0.75 * t, 0.7];
      o.MCV = [70 + 3 * t, 3];
      o.MCHC = [31, 0.7];
      o.RDW = [17.5 - 0.6 * t, 1.1];
      o.FERR = [6 + 9 * t, 2.5];
      o.IRON = [32 + 12 * t, 8];
      o.PLT = [410, 65];
      o.RETIC = [1.0 + 0.5 * t, 0.3];
      break;
    }
    case 'thyroid':
      if (trait('hyper', 0.3)) {
        o.TSH = [0.04 * (1 + t), 0.015];
        o.FT4 = [2.4 - 0.3 * t, 0.25];
        o.FT3 = [6.0 - 0.6 * t, 0.6];
      } else {
        o.TSH = [11 * 0.55 ** t, 2.5 * 0.6 ** t];
        o.FT4 = [0.78 + 0.08 * t, 0.07];
      }
      break;
    case 'infection':
    case 'child': {
      const bacterial = trait('bacterial', p.profile === 'child' ? 0.5 : 0.7);
      const f = visit ? 0.3 : 1;
      if (bacterial) {
        o.WBC = [8 + 7 * f, 2.2];
        o['NEUT%'] = [62 + 20 * f, 5];
        o.CRP = [8 + 70 * f, 20 * f + 3];
        o.ESR = [15 + 35 * f, 9];
        o.PCT = [0.1 + 1.5 * f, 0.6 * f + 0.05];
        if (rng.chance(0.02)) o.PCT = [12.5, 1.2];
      } else {
        o.WBC = [4.7, 1.0];
        o['NEUT%'] = [42, 6];
        o['LYMPH%'] = [47, 6];
        o.CRP = [11 * f + 2, 4];
        o.ESR = [18, 6];
      }
      break;
    }
    case 'liver': {
      const f = visit ? 0.7 : 1;
      o.ALT = [170 * f, 55];
      o.AST = [120 * f, 40];
      o.GGT = [115 * f, 38];
      o.ALP = [155, 32];
      o.TBIL = [2.0 * f, 0.6];
      o.DBIL = [0.9 * f, 0.3];
      o.ALB = [3.4, 0.3];
      o.PT = [14.6, 0.9];
      break;
    }
    case 'pregnancy':
      o.BHCG = visit === 0 ? [3200, 2200] : [42000, 16000];
      o.HGB = [11.1, 0.7];
      o.GLU = [86, 8];
      o.TSH = [1.7, 0.55];
      break;
    case 'uti':
      o.WBC = [10.5, 2.0];
      o['NEUT%'] = [74, 5];
      o.CRP = [18, 9];
      o.U_WBC = [38, 14];
      o.U_RBC = [9, 4];
      o.CREA = [0.9, 0.18];
      break;
    case 'brucella':
      o.ESR = [42, 11];
      o.CRP = [24, 9];
      o.WBC = [5.4, 1.2];
      o['NEUT%'] = [46, 6];
      o['LYMPH%'] = [44, 6];
      break;
    case 'cardiac':
      if (trait('acs', 0.4)) {
        o.TNI = visit === 0 ? [1.9, 0.9] : [0.42, 0.15];
        o.CK = [520, 170];
        o.LDH = [340, 65];
      }
      o.CHOL = [240, 33];
      o.TG = [215, 58];
      o.HDL = [37, 6];
      o.GLU = [122, 24];
      o.DDIMER = trait('pe', 0.15) ? [1900, 550] : [300, 110];
      break;
    case 'anticoag':
      o.INR = rng.chance(0.08) ? [5.7, 0.3] : [2.6, 0.42];
      break;
    case 'icu':
      o.PCO2 = rng.chance(0.15) ? [78, 4] : [56, 6];
      o.HCO3 = [27, 2.8];
      o.PO2 = [62, 9];
      o.K = rng.chance(0.08) ? [6.8, 0.12] : [4.9, 0.55];
      o.GLU = [165, 38];
      o.CREA = [1.6, 0.45];
      o.UREA = [70, 18];
      break;
    case 'premarital':
      if (trait('thal', 0.1)) {
        o.MCV = [66, 2.2];
        o.HGB = p.sex === 'male' ? [12.6, 0.5] : [11.2, 0.45];
        o.MCHC = [32, 0.6];
      }
      break;
    case 'healthy':
      if (trait('prediabetes', 0.1)) {
        o.HBA1C = [5.95, 0.2];
        o.GLU = [108, 6];
      }
      break;
  }
  return o;
}

const OPTION_DEFAULTS: Record<string, Array<readonly [string, number]>> = {
  U_COLOR: [['Yellow', 60], ['Pale yellow', 30], ['Dark yellow', 10]],
  U_APPEAR: [['Clear', 88], ['Slightly turbid', 12]],
  U_PRO: [['Negative', 94], ['Trace', 6]],
  U_GLU: [['Negative', 99], ['Trace', 1]],
  U_KET: [['Negative', 97], ['Trace', 3]],
  U_BLD: [['Negative', 94], ['Trace', 6]],
  U_NIT: [['Negative', 99], ['Positive', 1]],
  U_LEU: [['Negative', 92], ['Trace', 8]],
  U_EPI: [['Few', 70], ['None', 20], ['Moderate', 10]],
  U_BACT: [['None', 55], ['Few', 40], ['Moderate', 5]],
  S_COLOR: [['Brown', 85], ['Yellow', 15]],
  S_CONS: [['Formed', 60], ['Soft', 30], ['Loose', 10]],
  S_OVA: [['Not seen', 94], ['Giardia lamblia cysts', 4], ['Entamoeba histolytica cysts', 2]],
  S_OCC: [['Negative', 97], ['Positive', 3]],
  WIDAL_O: [['< 1/80', 88], ['1/80', 10], ['1/160', 2]],
  WIDAL_H: [['< 1/80', 90], ['1/80', 9], ['1/160', 1]],
  BRUC: [['< 1/80', 92], ['1/80', 8]],
  HBSAG: [['Negative', 99], ['Positive', 1]],
  HCV: [['Negative', 99], ['Positive', 1]],
  HIV: [['Negative', 1]],
};

const ORGANISMS: Array<readonly [{ org: string; sens: string }, number]> = [
  [{ org: 'Escherichia coli', sens: 'Sensitive: nitrofurantoin, fosfomycin, ceftriaxone · Resistant: ampicillin, co-trimoxazole' }, 70],
  [{ org: 'Klebsiella pneumoniae', sens: 'Sensitive: ceftriaxone, gentamicin, meropenem · Resistant: ampicillin' }, 15],
  [{ org: 'Proteus mirabilis', sens: 'Sensitive: ampicillin, ceftriaxone, ciprofloxacin · Resistant: nitrofurantoin' }, 10],
  [{ org: 'Enterococcus faecalis', sens: 'Sensitive: ampicillin, nitrofurantoin, vancomycin · Resistant: ceftriaxone' }, 5],
];

const CBC_CODES = new Set(['WBC', 'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW', 'PLT', 'MPV', 'NEUT%', 'LYMPH%', 'MONO%', 'EOS%', 'BASO%', 'NEUT#', 'LYMPH#', 'MONO#', 'EOS#', 'BASO#']);

/**
 * Every value of one visit, coherent with each other: the CBC indices agree (MCV, MCH and MCHC
 * follow from HGB, HCT and RBC; the differential adds up to 100 %), LDL stays positive, direct
 * bilirubin stays below total, INR follows the PT and pH follows pCO₂ and bicarbonate.
 */
export function labPicture(
  codes: string[],
  p: SimPatient,
  visit: number,
  ageYears: number,
  meta: (code: string) => AnalyteMeta | undefined,
  rng: Rng,
): Map<string, string | number> {
  const want = new Set(codes);
  const out = new Map<string, string | number>();
  const shifts = conditionShifts(p, visit, rng);
  const stat = (code: string): Stat => shifts[code] ?? population(code, p, ageYears) ?? fromRange(meta(code));
  const draw = (code: string, s: Stat = stat(code), min = 0): number => {
    let z = p.z.get(code);
    if (z === undefined) {
      z = rng.gauss();
      p.z.set(code, z);
    }
    return Math.max(min, s[0] + s[1] * (0.7 * z + 0.5 * rng.gauss()));
  };
  const put = (code: string, value: number | string) => {
    if (want.has(code)) out.set(code, value);
  };

  if ([...want].some((c) => CBC_CODES.has(c))) {
    const child = ageYears < 12;
    const wbc = draw('WBC', shifts.WBC ?? (child ? [8.5, 1.8] : [7, 1.5]), 1.2);
    const pct: Record<string, number> = {
      'NEUT%': draw('NEUT%', shifts['NEUT%'] ?? (child ? [45, 7] : [57, 7]), 20),
      'MONO%': Math.min(14, draw('MONO%', [6, 1.4], 1.5)),
      'EOS%': Math.min(10, draw('EOS%', [2.5, 1.1], 0.2)),
      'BASO%': Math.min(2, draw('BASO%', [0.5, 0.25], 0.1)),
    };
    pct['LYMPH%'] = shifts['LYMPH%'] ? draw('LYMPH%') : Math.max(6, 100 - pct['NEUT%']! - pct['MONO%']! - pct['EOS%']! - pct['BASO%']!);
    const sum = Object.values(pct).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(pct)) {
      pct[k] = (pct[k]! * 100) / sum;
      put(k, pct[k]!);
      put(k.replace('%', '#'), (wbc * pct[k]!) / 100);
    }
    const hgb = draw('HGB', shifts.HGB ?? (child ? [12.6, 0.7] : p.sex === 'male' ? [15.1, 0.8] : [13.3, 0.75]), 3.5);
    const mcv = draw('MCV', shifts.MCV ?? (child ? [82, 3] : [89, 3.2]), 55);
    const mchc = draw('MCHC', shifts.MCHC ?? [33.6, 0.6], 28);
    const hct = (hgb / mchc) * 100;
    const rbc = (hct / mcv) * 10;
    put('WBC', wbc);
    put('HGB', hgb);
    put('MCV', mcv);
    put('MCHC', mchc);
    put('HCT', hct);
    put('RBC', rbc);
    put('MCH', (hgb / rbc) * 10);
    put('RDW', draw('RDW', shifts.RDW ?? [13, 0.6], 10));
    put('PLT', draw('PLT', shifts.PLT ?? [265, 52], 20));
    put('MPV', draw('MPV', [9.6, 0.8], 6));
  }

  if (want.has('CHOL') || want.has('TG') || want.has('HDL')) {
    const tg = draw('TG', stat('TG'), 35);
    const hdl = draw('HDL', stat('HDL'), 22);
    let chol = draw('CHOL', stat('CHOL'), 100);
    if (chol - hdl - tg / 5 < 45) chol = hdl + tg / 5 + 45 + Math.abs(rng.gauss()) * 12;
    put('CHOL', chol);
    put('TG', tg);
    put('HDL', hdl);
  }

  if (want.has('TBIL') || want.has('DBIL')) {
    const tbil = draw('TBIL', stat('TBIL'), 0.2);
    put('TBIL', tbil);
    put('DBIL', Math.min(tbil * 0.8, draw('DBIL', stat('DBIL'), 0.02)));
  }
  if (want.has('TP') || want.has('ALB')) {
    const tp = draw('TP', stat('TP'), 5);
    put('TP', tp);
    put('ALB', Math.min(tp - 1.8, draw('ALB', stat('ALB'), 2)));
  }

  if (want.has('PT') || want.has('INR')) {
    const inr = shifts.INR ? draw('INR', shifts.INR, 0.8) : draw('PT', stat('PT'), 9.5) / 12.2;
    put('INR', inr);
    put('PT', inr * 12.2 + rng.gauss() * 0.2);
  }

  if (want.has('PH') || want.has('PCO2') || want.has('HCO3') || want.has('PO2')) {
    const pco2 = draw('PCO2', shifts.PCO2 ?? [40, 2.5], 15);
    const hco3 = draw('HCO3', shifts.HCO3 ?? [24, 1.3], 8);
    put('PCO2', pco2);
    put('HCO3', hco3);
    put('PH', 6.1 + Math.log10(hco3 / (0.03 * pco2)));
    put('PO2', draw('PO2', shifts.PO2 ?? [92, 5], 30));
  }

  const uti = p.profile === 'uti';
  if (uti && !p.traits.has('growth')) p.traits.set('growth', rng.chance(0.75));
  const growth = uti && p.traits.get('growth') === true;
  for (const code of want) {
    if (out.has(code)) continue;
    const m = meta(code);
    if (!m || m.type === 'calculated') continue;
    if (m.type === 'numeric') {
      out.set(code, draw(code));
      continue;
    }
    let value: string;
    switch (code) {
      case 'ABO':
      case 'RH':
        value = String(p.traits.get(code));
        break;
      case 'U_APPEAR':
        value = uti ? rng.pick(['Turbid', 'Slightly turbid']) : rng.weighted(OPTION_DEFAULTS.U_APPEAR!);
        break;
      case 'U_COLOR':
        value = uti ? rng.pick(['Dark yellow', 'Amber', 'Yellow']) : rng.weighted(OPTION_DEFAULTS.U_COLOR!);
        break;
      case 'U_LEU':
        value = uti ? rng.pick(['++', '+++', '+']) : rng.weighted(OPTION_DEFAULTS.U_LEU!);
        break;
      case 'U_NIT':
        value = uti && rng.chance(0.6) ? 'Positive' : 'Negative';
        break;
      case 'U_BLD':
        value = uti ? rng.pick(['Trace', '+', 'Negative']) : rng.weighted(OPTION_DEFAULTS.U_BLD!);
        break;
      case 'U_BACT':
        value = uti ? rng.pick(['Many', 'Moderate']) : rng.weighted(OPTION_DEFAULTS.U_BACT!);
        break;
      case 'U_PRO':
        value = p.profile === 'ckd' ? rng.pick(['+', '++']) : rng.weighted(OPTION_DEFAULTS.U_PRO!);
        break;
      case 'U_GLU':
        value = p.profile === 'diabetic' && Number(out.get('GLU') ?? stat('GLU')[0]) > 180 ? rng.pick(['+', '++', '+++']) : 'Negative';
        break;
      case 'U_CRYS':
        value = rng.weighted([['None', 85], ['Calcium oxalate (few)', 10], ['Uric acid (few)', 5]] as const);
        break;
      case 'S_OVA':
        value = p.profile === 'child' && rng.chance(0.2) ? 'Giardia lamblia cysts' : rng.weighted(OPTION_DEFAULTS.S_OVA!);
        break;
      case 'BRUC':
        value = p.profile === 'brucella' && p.traits.get('typhoid') !== true ? rng.pick(['1/320', '1/640', '1/160']) : rng.weighted(OPTION_DEFAULTS.BRUC!);
        break;
      case 'WIDAL_O':
      case 'WIDAL_H':
        if (p.profile === 'brucella' && !p.traits.has('typhoid')) p.traits.set('typhoid', rng.chance(0.3));
        value = p.traits.get('typhoid') === true ? rng.pick(['1/160', '1/320']) : rng.weighted(OPTION_DEFAULTS[code]!);
        break;
      case 'HBSAG':
      case 'HCV':
        if (p.profile === 'liver' && !p.traits.has(code)) p.traits.set(code, rng.chance(code === 'HBSAG' ? 0.45 : 0.2));
        value = p.traits.get(code) === true ? 'Positive' : 'Negative';
        break;
      case 'UC_RESULT':
        value = growth ? 'Growth' : 'No growth';
        break;
      case 'UC_ORG':
      case 'UC_COUNT':
      case 'UC_SENS': {
        if (growth && !p.traits.has('organism')) {
          const chosen = rng.weighted(ORGANISMS);
          p.traits.set('organism', ORGANISMS.findIndex(([o]) => o === chosen));
        }
        const org = growth ? ORGANISMS[Number(p.traits.get('organism'))]![0] : null;
        value =
          code === 'UC_ORG' ? (org ? org.org : 'None isolated') : code === 'UC_COUNT' ? (org ? '> 10⁵ CFU/mL' : '< 10³ CFU/mL') : org ? org.sens : 'Not applicable';
        break;
      }
      default: {
        const choices = OPTION_DEFAULTS[code];
        value = choices ? rng.weighted(choices) : m.options?.length ? m.options[0]! : 'Normal';
      }
    }
    out.set(code, value);
  }

  for (const [code, value] of out) {
    if (typeof value !== 'number') continue;
    const decimals = meta(code)?.decimals ?? 1;
    const factor = 10 ** decimals;
    out.set(code, Math.round(value * factor) / factor);
  }
  return out;
}

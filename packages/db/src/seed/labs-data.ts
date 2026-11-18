/**
 * Three fictional demo labs. Names, people, doctors and insurers are invented;
 * any resemblance to real organisations or people is unintended.
 */
import type { InstrumentModel } from '@natija/protocols';

export type UserDef = {
  username: string;
  nameAr: string;
  nameEn: string;
  title?: string;
  roles: string[];
  departments?: string[];
};

export type PayerDef = {
  code: string;
  en: string;
  ar: string;
  kind: 'public' | 'insurer' | 'client_lab' | 'other';
  unitPrice: number;
  patientSharePct?: number;
  discountPct?: number;
  onAccount?: boolean;
  organization?: string;
};

export type LabDef = {
  code: string;
  nameAr: string;
  nameEn: string;
  taglineAr: string;
  taglineEn: string;
  city: string;
  addressAr: string;
  addressEn: string;
  phone: string;
  email: string;
  directorNameAr: string;
  directorNameEn: string;
  directorTitleAr: string;
  directorTitleEn: string;
  brandColor: string;
  logoSvg: string;
  branches: Array<{ code: string; ar: string; en: string; main?: boolean }>;
  users: UserDef[];
  payers: PayerDef[];
  instruments: InstrumentModel[];
  /** How many fictional patients the history seed creates. */
  patients: number;
};

const logoJasmine = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0E7C66"/><g fill="#FFFFFF" transform="translate(32 32)"><ellipse cy="-12" rx="6.5" ry="11"/><ellipse cy="-12" rx="6.5" ry="11" transform="rotate(72)"/><ellipse cy="-12" rx="6.5" ry="11" transform="rotate(144)"/><ellipse cy="-12" rx="6.5" ry="11" transform="rotate(216)"/><ellipse cy="-12" rx="6.5" ry="11" transform="rotate(288)"/></g><circle cx="32" cy="32" r="5" fill="#F5C542"/></svg>`;
const logoNoria = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2347B0"/><g fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"><circle cx="32" cy="29" r="17"/><circle cx="32" cy="29" r="3.5"/><path d="M32 12v34M15 29h34M20 17l24 24M44 17L20 41"/></g><path d="M8 53c6-4 10-4 16 0s10 4 16 0 10-4 16 0" stroke="#9FD3FF" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
const logoCitadel = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#9A3412"/><path fill="#FFFFFF" d="M12 49V29h4v-4h4v4h4v-8h4v4h8v-4h4v8h4v-4h4v4h4v20z"/><path fill="#9A3412" d="M29 49v-8a3 3 0 0 1 6 0v8z"/><path d="M9 53h46" stroke="#FCD9BD" stroke-width="3" stroke-linecap="round"/></svg>`;

const standardPayers = (unit: number): PayerDef[] => [
  { code: 'PUBLIC', en: 'General public', ar: 'عموم', kind: 'public', unitPrice: unit },
  { code: 'WAHA_GOLD', en: 'Waha Health · Gold plan', ar: 'واحة الصحة · الخطة الذهبية', kind: 'insurer', unitPrice: unit + 5, patientSharePct: 20, onAccount: true, organization: 'Waha Health (TPA)' },
  { code: 'WAHA_STD', en: 'Waha Health · Standard plan', ar: 'واحة الصحة · الخطة العادية', kind: 'insurer', unitPrice: unit + 5, patientSharePct: 30, onAccount: true, organization: 'Waha Health (TPA)' },
  { code: 'NAJM', en: 'Najm Insurance', ar: 'تأمين نجم', kind: 'insurer', unitPrice: unit + 3, patientSharePct: 25, onAccount: true, organization: 'Najm Insurance' },
  { code: 'UNION', en: 'Professional union fund', ar: 'صندوق النقابة المهنية', kind: 'other', unitPrice: unit, discountPct: 15 },
  { code: 'NOOR', en: 'Al-Noor collection centre', ar: 'مركز النور لسحب العينات', kind: 'client_lab', unitPrice: Math.round(unit * 0.75), patientSharePct: 0, onAccount: true, organization: 'Al-Noor collection centre' },
  { code: 'STAFF', en: 'Staff & family', ar: 'الموظفون وعائلاتهم', kind: 'other', unitPrice: unit, discountPct: 50 },
];

export const LABS: LabDef[] = [
  {
    code: 'yasmin',
    nameAr: 'مخابر الياسمين الطبية',
    nameEn: 'Yasmin Medical Laboratories',
    taglineAr: 'تحاليل دموية · كيميائية · هرمونية · مناعية · جرثومية',
    taglineEn: 'Hematology · Chemistry · Hormones · Immunology · Microbiology',
    city: 'Damascus',
    addressAr: 'دمشق - المزة - شارع الجلاء',
    addressEn: 'Damascus · Mezzeh · Al-Jalaa St.',
    phone: '+963 11 000 0101',
    email: 'info@yasmin-lab.example',
    directorNameAr: 'د. هبة الناصر',
    directorNameEn: 'Dr. Hiba Al-Nasser',
    directorTitleAr: 'اختصاصية في التشخيص المخبري',
    directorTitleEn: 'Clinical pathologist',
    brandColor: '#0E7C66',
    logoSvg: logoJasmine,
    branches: [
      { code: 'MAIN', ar: 'المركز الرئيسي - المزة', en: 'Main lab · Mezzeh', main: true },
      { code: 'KAFR', ar: 'فرع كفرسوسة', en: 'Kafr Sousa branch' },
    ],
    users: [
      { username: 'owner', nameAr: 'هبة الناصر', nameEn: 'Hiba Al-Nasser', title: 'Dr.', roles: ['owner', 'specialist'] },
      { username: 'manager', nameAr: 'كنان السيد', nameEn: 'Kinan Al-Sayed', roles: ['manager'] },
      { username: 'reception', nameAr: 'رنا الشامي', nameEn: 'Rana Al-Shami', roles: ['receptionist'] },
      { username: 'tech', nameAr: 'مازن حداد', nameEn: 'Mazen Haddad', roles: ['technician'] },
      { username: 'tech.hem', nameAr: 'سلمى عيسى', nameEn: 'Salma Issa', roles: ['technician'], departments: ['HEM'] },
      { username: 'doctor', nameAr: 'عماد قاسم', nameEn: 'Imad Qassem', title: 'Dr.', roles: ['specialist'] },
      { username: 'accountant', nameAr: 'ليلى مراد', nameEn: 'Laila Murad', roles: ['accountant'] },
    ],
    payers: standardPayers(45),
    instruments: ['sysmex_xn', 'mindray_bs430', 'cobas_pure', 'cobas_e411', 'ichroma3', 'medica_easystat'],
    patients: 160,
  },
  {
    code: 'orontes',
    nameAr: 'مخبر العاصي للتشخيص',
    nameEn: 'Orontes Diagnostics',
    taglineAr: 'مخبر تحاليل طبية · حماة',
    taglineEn: 'Medical laboratory · Hama',
    city: 'Hama',
    addressAr: 'حماة - ساحة العاصي',
    addressEn: 'Hama · Al-Assi square',
    phone: '+963 33 000 0202',
    email: 'lab@orontes.example',
    directorNameAr: 'د. وسيم حمدان',
    directorNameEn: 'Dr. Wassim Hamdan',
    directorTitleAr: 'ماجستير في التشخيص المخبري',
    directorTitleEn: 'MSc, laboratory diagnosis',
    brandColor: '#2347B0',
    logoSvg: logoNoria,
    branches: [{ code: 'MAIN', ar: 'المخبر الرئيسي', en: 'Main lab', main: true }],
    users: [
      { username: 'owner', nameAr: 'وسيم حمدان', nameEn: 'Wassim Hamdan', title: 'Dr.', roles: ['owner', 'specialist'] },
      { username: 'manager', nameAr: 'ديما العلي', nameEn: 'Dima Al-Ali', roles: ['manager'] },
      { username: 'reception', nameAr: 'يوسف الحموي', nameEn: 'Youssef Al-Hamawi', roles: ['receptionist'] },
      { username: 'tech', nameAr: 'علا سليمان', nameEn: 'Ola Suleiman', roles: ['technician'] },
      { username: 'doctor', nameAr: 'نزار الخطيب', nameEn: 'Nizar Al-Khatib', title: 'Dr.', roles: ['specialist'] },
      { username: 'accountant', nameAr: 'سامي درويش', nameEn: 'Sami Darwish', roles: ['accountant'] },
    ],
    payers: standardPayers(38),
    instruments: ['sysmex_xn', 'mindray_bs430', 'cobas_e411', 'medica_easystat'],
    patients: 120,
  },
  {
    code: 'citadel',
    nameAr: 'مخبر القلعة الطبي',
    nameEn: 'Citadel Medical Lab',
    taglineAr: 'تحاليل طبية شاملة · حلب',
    taglineEn: 'Full-service medical laboratory · Aleppo',
    city: 'Aleppo',
    addressAr: 'حلب - العزيزية',
    addressEn: 'Aleppo · Al-Aziziyeh',
    phone: '+963 21 000 0303',
    email: 'contact@citadel-lab.example',
    directorNameAr: 'د. ريتا كرم',
    directorNameEn: 'Dr. Rita Karam',
    directorTitleAr: 'اختصاصية في علم الأمراض السريري',
    directorTitleEn: 'Clinical pathologist',
    brandColor: '#9A3412',
    logoSvg: logoCitadel,
    branches: [{ code: 'MAIN', ar: 'المخبر الرئيسي', en: 'Main lab', main: true }],
    users: [
      { username: 'owner', nameAr: 'ريتا كرم', nameEn: 'Rita Karam', title: 'Dr.', roles: ['owner', 'specialist'] },
      { username: 'manager', nameAr: 'أحمد الحلبي', nameEn: 'Ahmad Al-Halabi', roles: ['manager'] },
      { username: 'reception', nameAr: 'نور عبد الله', nameEn: 'Nour Abdullah', roles: ['receptionist'] },
      { username: 'tech', nameAr: 'جورج سعادة', nameEn: 'George Saadeh', roles: ['technician'] },
      { username: 'doctor', nameAr: 'منى الزعبي', nameEn: 'Mona Al-Zoubi', title: 'Dr.', roles: ['specialist'] },
      { username: 'accountant', nameAr: 'خالد شحادة', nameEn: 'Khaled Shehadeh', roles: ['accountant'] },
    ],
    payers: standardPayers(40),
    instruments: ['cobas_pure', 'sysmex_xn', 'ichroma3'],
    patients: 110,
  },
];

export const DOCTORS = [
  { ar: 'د. ريم العلي', en: 'Dr. Reem Al-Ali', specAr: 'أمراض داخلية', specEn: 'Internal medicine', clinic: 'Al-Shifa clinic' },
  { ar: 'د. سامر الخطيب', en: 'Dr. Samer Al-Khatib', specAr: 'أمراض القلب', specEn: 'Cardiology', clinic: 'Heart care centre' },
  { ar: 'د. لينا حداد', en: 'Dr. Lina Haddad', specAr: 'نسائية وتوليد', specEn: 'Obstetrics & gynaecology', clinic: 'Mother & child clinic' },
  { ar: 'د. عمر الشامي', en: 'Dr. Omar Al-Shami', specAr: 'طب الأطفال', specEn: 'Paediatrics', clinic: 'Little steps clinic' },
  { ar: 'د. نور الهدى قاسم', en: 'Dr. Nour Al-Huda Qassem', specAr: 'غدد صم وسكري', specEn: 'Endocrinology', clinic: 'Diabetes centre' },
  { ar: 'د. باسل مراد', en: 'Dr. Basel Murad', specAr: 'جراحة بولية', specEn: 'Urology', clinic: 'Urology clinic' },
  { ar: 'د. هالة سليمان', en: 'Dr. Hala Suleiman', specAr: 'أمراض جلدية', specEn: 'Dermatology', clinic: 'Skin clinic' },
  { ar: 'د. فراس عيسى', en: 'Dr. Firas Issa', specAr: 'جراحة عامة', specEn: 'General surgery', clinic: 'City hospital' },
  { ar: 'د. مها درويش', en: 'Dr. Maha Darwish', specAr: 'طب الأسرة', specEn: 'Family medicine', clinic: 'Family health centre' },
  { ar: 'د. يزن الأحمد', en: 'Dr. Yazan Al-Ahmad', specAr: 'أمراض الكلية', specEn: 'Nephrology', clinic: 'Kidney clinic' },
  { ar: 'د. رامي عطية', en: 'Dr. Rami Atieh', specAr: 'أمراض الدم', specEn: 'Hematology', clinic: 'Blood disorders clinic' },
  { ar: 'د. سوزان بكور', en: 'Dr. Suzan Bakkour', specAr: 'أمراض هضمية', specEn: 'Gastroenterology', clinic: 'Digestive health clinic' },
];

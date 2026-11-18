/**
 * Demo test catalog. Reference ranges are typical adult/paediatric textbook values for a
 * demonstration only; each lab must set its own validated ranges before real use.
 */

const D = 1;
const MO = 30;
const Y = 365;

export type RangeDef = {
  sex?: 'any' | 'male' | 'female';
  ageMin?: number;
  ageMax?: number | null;
  low?: number | null;
  high?: number | null;
  critLow?: number | null;
  critHigh?: number | null;
  text?: string | null;
};

export type AnalyteDef = {
  code: string;
  en: string;
  ar: string;
  unit?: string;
  type?: 'numeric' | 'text' | 'option' | 'calculated';
  decimals?: number;
  options?: string[];
  formula?: string;
  deltaPct?: number;
  loinc?: string;
  ranges?: RangeDef[];
};

export type TestDef = {
  code: string;
  en: string;
  ar: string;
  dept: string;
  sampleType: string;
  container: string;
  units: number;
  tat?: number;
  analytes: string[];
  favorite?: boolean;
  separateTube?: boolean;
  method?: string;
};

export const DEPARTMENTS = [
  { code: 'HEM', en: 'Hematology', ar: 'أمراض الدم' },
  { code: 'CHEM', en: 'Clinical chemistry', ar: 'الكيمياء الحيوية' },
  { code: 'IMM', en: 'Immunology & hormones', ar: 'المناعة والهرمونات' },
  { code: 'SER', en: 'Serology', ar: 'المصليات' },
  { code: 'COAG', en: 'Coagulation', ar: 'التخثر' },
  { code: 'URN', en: 'Urine & stool', ar: 'البول والبراز' },
  { code: 'MIC', en: 'Microbiology', ar: 'الأحياء الدقيقة' },
  { code: 'BG', en: 'Blood gas', ar: 'غازات الدم' },
];

export const SAMPLE_TYPES = [
  { code: 'WB', en: 'Whole blood', ar: 'دم كامل' },
  { code: 'SER', en: 'Serum', ar: 'مصل' },
  { code: 'PLC', en: 'Citrated plasma', ar: 'بلازما سيتراتية' },
  { code: 'URINE', en: 'Urine', ar: 'بول' },
  { code: 'STOOL', en: 'Stool', ar: 'براز' },
  { code: 'ABG', en: 'Arterial blood', ar: 'دم شرياني' },
];

export const CONTAINERS = [
  { code: 'EDTA', en: 'EDTA tube', ar: 'أنبوب EDTA', cap: 'lavender', ml: 3 },
  { code: 'SST', en: 'Serum gel tube', ar: 'أنبوب مصل بجل', cap: 'gold', ml: 5 },
  { code: 'CIT', en: 'Citrate tube', ar: 'أنبوب سيترات', cap: 'lightblue', ml: 2.7 },
  { code: 'ESR', en: 'ESR citrate tube', ar: 'أنبوب سرعة التثفل', cap: 'black', ml: 1.6 },
  { code: 'HEPS', en: 'Heparinised syringe', ar: 'محقنة مهبرنة', cap: 'green', ml: 1 },
  { code: 'URC', en: 'Urine cup', ar: 'وعاء بول', cap: 'yellow', ml: 60 },
  { code: 'STC', en: 'Stool container', ar: 'وعاء براز', cap: 'brown', ml: 30 },
];

export const REJECTION_REASONS = [
  { code: 'HEMOLYZED', en: 'Hemolyzed sample', ar: 'عينة منحلّة' },
  { code: 'CLOTTED', en: 'Clotted sample', ar: 'عينة متخثرة' },
  { code: 'QNS', en: 'Insufficient volume', ar: 'كمية غير كافية' },
  { code: 'WRONG_TUBE', en: 'Wrong container', ar: 'أنبوب غير مناسب' },
  { code: 'LABEL', en: 'Unlabelled or mislabelled', ar: 'بلا ملصق أو ملصق خاطئ' },
  { code: 'LIPEMIC', en: 'Lipemic sample', ar: 'عينة شحمية' },
  { code: 'DELAYED', en: 'Delayed transport', ar: 'تأخر وصول العينة' },
];

const negPos = ['Negative', 'Positive'];
const dipstick = ['Negative', 'Trace', '+', '++', '+++'];
const titers = ['< 1/80', '1/80', '1/160', '1/320', '1/640'];

export const ANALYTES: AnalyteDef[] = [
  // Hematology
  { code: 'WBC', en: 'White blood cells', ar: 'الكريات البيض', unit: '10³/µL', decimals: 2, deltaPct: 60, loinc: '6690-2', ranges: [
    { ageMax: 30 * D, low: 9.0, high: 30.0 },
    { ageMin: 31 * D, ageMax: 1 * Y, low: 6.0, high: 17.5 },
    { ageMin: 1 * Y + 1, ageMax: 12 * Y, low: 5.0, high: 14.5, critLow: 2.0, critHigh: 35 },
    { ageMin: 12 * Y + 1, low: 4.0, high: 11.0, critLow: 2.0, critHigh: 30 },
  ] },
  { code: 'RBC', en: 'Red blood cells', ar: 'الكريات الحمر', unit: '10⁶/µL', decimals: 2, ranges: [
    { ageMax: 12 * Y, low: 4.0, high: 5.2 },
    { sex: 'male', ageMin: 12 * Y + 1, low: 4.5, high: 5.9 },
    { sex: 'female', ageMin: 12 * Y + 1, low: 4.1, high: 5.1 },
  ] },
  { code: 'HGB', en: 'Hemoglobin', ar: 'الخضاب', unit: 'g/dL', decimals: 1, deltaPct: 20, loinc: '718-7', ranges: [
    { ageMax: 30 * D, low: 14.5, high: 22.5, critLow: 10.0, critHigh: 25.0 },
    { ageMin: 31 * D, ageMax: 1 * Y, low: 9.5, high: 13.5, critLow: 7.0, critHigh: 20.0 },
    { ageMin: 1 * Y + 1, ageMax: 12 * Y, low: 11.0, high: 14.5, critLow: 7.0, critHigh: 20.0 },
    { sex: 'male', ageMin: 12 * Y + 1, low: 13.5, high: 17.5, critLow: 7.0, critHigh: 20.0 },
    { sex: 'female', ageMin: 12 * Y + 1, low: 12.0, high: 15.5, critLow: 7.0, critHigh: 20.0 },
  ] },
  { code: 'HCT', en: 'Hematocrit', ar: 'الرسابة', unit: '%', decimals: 1, ranges: [
    { ageMax: 12 * Y, low: 33, high: 43 },
    { sex: 'male', ageMin: 12 * Y + 1, low: 41, high: 53 },
    { sex: 'female', ageMin: 12 * Y + 1, low: 36, high: 46 },
  ] },
  { code: 'MCV', en: 'MCV', ar: 'حجم الكرية الوسطي', unit: 'fL', decimals: 1, ranges: [{ ageMax: 12 * Y, low: 75, high: 90 }, { ageMin: 12 * Y + 1, low: 80, high: 100 }] },
  { code: 'MCH', en: 'MCH', ar: 'خضاب الكرية الوسطي', unit: 'pg', decimals: 1, ranges: [{ low: 27, high: 33 }] },
  { code: 'MCHC', en: 'MCHC', ar: 'تركيز خضاب الكرية', unit: 'g/dL', decimals: 1, ranges: [{ low: 32, high: 36 }] },
  { code: 'RDW', en: 'RDW-CV', ar: 'توزع حجم الكريات', unit: '%', decimals: 1, ranges: [{ low: 11.5, high: 14.5 }] },
  { code: 'PLT', en: 'Platelets', ar: 'الصفيحات', unit: '10³/µL', decimals: 0, deltaPct: 50, loinc: '777-3', ranges: [{ low: 150, high: 400, critLow: 50, critHigh: 1000 }] },
  { code: 'MPV', en: 'MPV', ar: 'حجم الصفيحة الوسطي', unit: 'fL', decimals: 1, ranges: [{ low: 7.5, high: 11.5 }] },
  { code: 'NEUT%', en: 'Neutrophils %', ar: 'العدلات %', unit: '%', decimals: 1, ranges: [{ low: 40, high: 75 }] },
  { code: 'LYMPH%', en: 'Lymphocytes %', ar: 'اللمفاويات %', unit: '%', decimals: 1, ranges: [{ low: 20, high: 45 }] },
  { code: 'MONO%', en: 'Monocytes %', ar: 'الوحيدات %', unit: '%', decimals: 1, ranges: [{ low: 2, high: 10 }] },
  { code: 'EOS%', en: 'Eosinophils %', ar: 'الحمضات %', unit: '%', decimals: 1, ranges: [{ low: 1, high: 6 }] },
  { code: 'BASO%', en: 'Basophils %', ar: 'الأسسات %', unit: '%', decimals: 1, ranges: [{ low: 0, high: 2 }] },
  { code: 'NEUT#', en: 'Neutrophils #', ar: 'العدلات #', unit: '10³/µL', decimals: 2, ranges: [{ low: 2.0, high: 7.5, critLow: 0.5 }] },
  { code: 'LYMPH#', en: 'Lymphocytes #', ar: 'اللمفاويات #', unit: '10³/µL', decimals: 2, ranges: [{ low: 1.0, high: 4.0 }] },
  { code: 'MONO#', en: 'Monocytes #', ar: 'الوحيدات #', unit: '10³/µL', decimals: 2, ranges: [{ low: 0.2, high: 1.0 }] },
  { code: 'EOS#', en: 'Eosinophils #', ar: 'الحمضات #', unit: '10³/µL', decimals: 2, ranges: [{ low: 0.0, high: 0.5 }] },
  { code: 'BASO#', en: 'Basophils #', ar: 'الأسسات #', unit: '10³/µL', decimals: 2, ranges: [{ low: 0.0, high: 0.2 }] },
  { code: 'ESR', en: 'ESR (1st hour)', ar: 'سرعة التثفل (الساعة الأولى)', unit: 'mm/h', decimals: 0, ranges: [{ sex: 'male', low: 0, high: 15 }, { sex: 'female', low: 0, high: 20 }] },
  { code: 'RETIC', en: 'Reticulocytes', ar: 'الشبكيات', unit: '%', decimals: 1, ranges: [{ low: 0.5, high: 2.5 }] },
  { code: 'ABO', en: 'ABO group', ar: 'الزمرة', type: 'option', options: ['A', 'B', 'AB', 'O'] },
  { code: 'RH', en: 'Rh (D)', ar: 'العامل الريزوسي', type: 'option', options: ['Positive', 'Negative'] },
  // Chemistry
  { code: 'GLU', en: 'Glucose', ar: 'سكر الدم', unit: 'mg/dL', decimals: 0, loinc: '2345-7', ranges: [{ low: 70, high: 100, critLow: 40, critHigh: 500 }] },
  { code: 'UREA', en: 'Urea', ar: 'البولة', unit: 'mg/dL', decimals: 0, deltaPct: 50, ranges: [{ ageMax: 12 * Y, low: 10, high: 36 }, { ageMin: 12 * Y + 1, low: 15, high: 45 }] },
  { code: 'CREA', en: 'Creatinine', ar: 'الكرياتينين', unit: 'mg/dL', decimals: 2, deltaPct: 50, loinc: '2160-0', ranges: [
    { ageMax: 12 * Y, low: 0.3, high: 0.7 },
    { sex: 'male', ageMin: 12 * Y + 1, low: 0.7, high: 1.3 },
    { sex: 'female', ageMin: 12 * Y + 1, low: 0.5, high: 1.1 },
  ] },
  { code: 'EGFR', en: 'eGFR (CKD-EPI 2021)', ar: 'معدل الرشح الكبي المقدّر', unit: 'mL/min/1.73m²', type: 'calculated', decimals: 0,
    formula: '142 * pow(min(CREA / if(FEMALE, 0.7, 0.9), 1), if(FEMALE, -0.241, -0.302)) * pow(max(CREA / if(FEMALE, 0.7, 0.9), 1), -1.2) * pow(0.9938, AGE) * if(FEMALE, 1.012, 1)',
    ranges: [{ ageMin: 18 * Y, low: 90, high: null, text: '≥ 90' }] },
  { code: 'UA', en: 'Uric acid', ar: 'حمض البول', unit: 'mg/dL', decimals: 1, ranges: [{ sex: 'male', low: 3.5, high: 7.2 }, { sex: 'female', low: 2.6, high: 6.0 }] },
  { code: 'CHOL', en: 'Total cholesterol', ar: 'الكولسترول الكلي', unit: 'mg/dL', decimals: 0, ranges: [{ low: null, high: 200, text: '< 200 desirable' }] },
  { code: 'TG', en: 'Triglycerides', ar: 'الشحوم الثلاثية', unit: 'mg/dL', decimals: 0, ranges: [{ low: null, high: 150 }] },
  { code: 'HDL', en: 'HDL cholesterol', ar: 'الكولسترول عالي الكثافة', unit: 'mg/dL', decimals: 0, ranges: [{ sex: 'male', low: 40, high: null }, { sex: 'female', low: 50, high: null }] },
  { code: 'LDL', en: 'LDL cholesterol (calculated)', ar: 'الكولسترول منخفض الكثافة (محسوب)', unit: 'mg/dL', type: 'calculated', decimals: 0, formula: 'CHOL - HDL - TG / 5', ranges: [{ low: null, high: 130 }] },
  { code: 'VLDL', en: 'VLDL (calculated)', ar: 'VLDL (محسوب)', unit: 'mg/dL', type: 'calculated', decimals: 0, formula: 'TG / 5', ranges: [{ low: 5, high: 40 }] },
  { code: 'ALT', en: 'ALT (SGPT)', ar: 'خميرة ALT', unit: 'U/L', decimals: 0, deltaPct: 100, ranges: [{ sex: 'male', low: 0, high: 41 }, { sex: 'female', low: 0, high: 33 }] },
  { code: 'AST', en: 'AST (SGOT)', ar: 'خميرة AST', unit: 'U/L', decimals: 0, ranges: [{ sex: 'male', low: 0, high: 40 }, { sex: 'female', low: 0, high: 32 }] },
  { code: 'ALP', en: 'Alkaline phosphatase', ar: 'الفوسفاتاز القلوية', unit: 'U/L', decimals: 0, ranges: [{ ageMax: 15 * Y, low: 100, high: 390 }, { ageMin: 15 * Y + 1, low: 40, high: 129 }] },
  { code: 'GGT', en: 'Gamma-GT', ar: 'غاما جي تي', unit: 'U/L', decimals: 0, ranges: [{ sex: 'male', low: 8, high: 61 }, { sex: 'female', low: 5, high: 36 }] },
  { code: 'TBIL', en: 'Total bilirubin', ar: 'البيليروبين الكلي', unit: 'mg/dL', decimals: 2, ranges: [{ ageMax: 7 * D, low: 1.0, high: 12.0, critHigh: 15 }, { ageMin: 8 * D, low: 0.2, high: 1.2 }] },
  { code: 'DBIL', en: 'Direct bilirubin', ar: 'البيليروبين المباشر', unit: 'mg/dL', decimals: 2, ranges: [{ low: 0.0, high: 0.3 }] },
  { code: 'IBIL', en: 'Indirect bilirubin (calculated)', ar: 'البيليروبين غير المباشر (محسوب)', unit: 'mg/dL', type: 'calculated', decimals: 2, formula: 'TBIL - DBIL', ranges: [{ low: 0.1, high: 1.0 }] },
  { code: 'TP', en: 'Total protein', ar: 'البروتين الكلي', unit: 'g/dL', decimals: 1, ranges: [{ low: 6.4, high: 8.3 }] },
  { code: 'ALB', en: 'Albumin', ar: 'الألبومين', unit: 'g/dL', decimals: 1, ranges: [{ low: 3.5, high: 5.2 }] },
  { code: 'GLOB', en: 'Globulin (calculated)', ar: 'الغلوبولين (محسوب)', unit: 'g/dL', type: 'calculated', decimals: 1, formula: 'TP - ALB', ranges: [{ low: 2.0, high: 3.5 }] },
  { code: 'AGR', en: 'A/G ratio (calculated)', ar: 'نسبة الألبومين/الغلوبولين', unit: '', type: 'calculated', decimals: 2, formula: 'ALB / (TP - ALB)', ranges: [{ low: 1.1, high: 2.5 }] },
  { code: 'NA', en: 'Sodium', ar: 'الصوديوم', unit: 'mmol/L', decimals: 0, ranges: [{ low: 136, high: 145, critLow: 120, critHigh: 160 }] },
  { code: 'K', en: 'Potassium', ar: 'البوتاسيوم', unit: 'mmol/L', decimals: 1, ranges: [{ low: 3.5, high: 5.1, critLow: 2.5, critHigh: 6.5 }] },
  { code: 'CL', en: 'Chloride', ar: 'الكلور', unit: 'mmol/L', decimals: 0, ranges: [{ low: 98, high: 107 }] },
  { code: 'CA', en: 'Calcium', ar: 'الكالسيوم', unit: 'mg/dL', decimals: 1, ranges: [{ low: 8.6, high: 10.2, critLow: 6.0, critHigh: 13.0 }] },
  { code: 'MG', en: 'Magnesium', ar: 'المغنيزيوم', unit: 'mg/dL', decimals: 1, ranges: [{ low: 1.6, high: 2.6 }] },
  { code: 'PHOS', en: 'Phosphorus', ar: 'الفوسفور', unit: 'mg/dL', decimals: 1, ranges: [{ ageMax: 12 * Y, low: 4.0, high: 7.0 }, { ageMin: 12 * Y + 1, low: 2.5, high: 4.5 }] },
  { code: 'CRP', en: 'C-reactive protein', ar: 'البروتين الارتكاسي C', unit: 'mg/L', decimals: 1, ranges: [{ low: null, high: 5 }] },
  { code: 'IRON', en: 'Serum iron', ar: 'الحديد', unit: 'µg/dL', decimals: 0, ranges: [{ sex: 'male', low: 65, high: 175 }, { sex: 'female', low: 50, high: 170 }] },
  { code: 'AMY', en: 'Amylase', ar: 'الأميلاز', unit: 'U/L', decimals: 0, ranges: [{ low: 28, high: 100 }] },
  { code: 'CK', en: 'Creatine kinase', ar: 'الكرياتين كيناز', unit: 'U/L', decimals: 0, ranges: [{ sex: 'male', low: 39, high: 308 }, { sex: 'female', low: 26, high: 192 }] },
  { code: 'LDH', en: 'LDH', ar: 'نازعة هيدروجين اللاكتات', unit: 'U/L', decimals: 0, ranges: [{ low: 135, high: 225 }] },
  { code: 'HBA1C', en: 'HbA1c', ar: 'الخضاب السكري', unit: '%', decimals: 1, deltaPct: 25, ranges: [{ low: 4.0, high: 5.6, text: '< 5.7 normal · 5.7–6.4 prediabetes · ≥ 6.5 diabetes' }] },
  // Immunology & hormones
  { code: 'TSH', en: 'TSH', ar: 'الهرمون المنبه للدرق', unit: 'µIU/mL', decimals: 3, ranges: [{ low: 0.27, high: 4.2 }] },
  { code: 'FT4', en: 'Free T4', ar: 'الثيروكسين الحر', unit: 'ng/dL', decimals: 2, ranges: [{ low: 0.93, high: 1.7 }] },
  { code: 'FT3', en: 'Free T3', ar: 'ثلاثي يود الثيرونين الحر', unit: 'pg/mL', decimals: 2, ranges: [{ low: 2.0, high: 4.4 }] },
  { code: 'VITD', en: '25-OH vitamin D', ar: 'فيتامين د', unit: 'ng/mL', decimals: 1, ranges: [{ low: 30, high: 100, text: '< 20 deficient · 20–29 insufficient · 30–100 sufficient' }] },
  { code: 'B12', en: 'Vitamin B12', ar: 'فيتامين ب12', unit: 'pg/mL', decimals: 0, ranges: [{ low: 197, high: 771 }] },
  { code: 'FERR', en: 'Ferritin', ar: 'الفيريتين', unit: 'ng/mL', decimals: 1, ranges: [{ sex: 'male', low: 30, high: 400 }, { sex: 'female', low: 13, high: 150 }] },
  { code: 'PSA', en: 'Total PSA', ar: 'المستضد البروستاتي النوعي', unit: 'ng/mL', decimals: 2, ranges: [{ sex: 'male', low: null, high: 4.0 }] },
  { code: 'BHCG', en: 'β-hCG', ar: 'هرمون الحمل', unit: 'mIU/mL', decimals: 1, ranges: [{ sex: 'female', low: null, high: 5, text: '< 5 not pregnant' }, { sex: 'male', low: null, high: 2 }] },
  { code: 'PRL', en: 'Prolactin', ar: 'البرولاكتين', unit: 'ng/mL', decimals: 1, ranges: [{ sex: 'male', low: 4.0, high: 15.2 }, { sex: 'female', low: 4.8, high: 23.3 }] },
  { code: 'INS', en: 'Insulin (fasting)', ar: 'الأنسولين', unit: 'µIU/mL', decimals: 1, ranges: [{ low: 2.6, high: 24.9 }] },
  { code: 'PCT', en: 'Procalcitonin', ar: 'البروكالسيتونين', unit: 'ng/mL', decimals: 2, ranges: [{ low: null, high: 0.5, critHigh: 10 }] },
  { code: 'TNI', en: 'Troponin I', ar: 'التروبونين I', unit: 'ng/mL', decimals: 3, ranges: [{ low: null, high: 0.04, critHigh: 0.5 }] },
  { code: 'DDIMER', en: 'D-dimer', ar: 'دي-دايمر', unit: 'ng/mL FEU', decimals: 0, ranges: [{ low: null, high: 500 }] },
  // Serology
  { code: 'RF', en: 'Rheumatoid factor', ar: 'العامل الرثواني', unit: 'IU/mL', decimals: 1, ranges: [{ low: null, high: 14 }] },
  { code: 'ASO', en: 'ASO titre', ar: 'أضداد الستربتوليزين O', unit: 'IU/mL', decimals: 0, ranges: [{ low: null, high: 200 }] },
  { code: 'WIDAL_O', en: 'Widal O (S. typhi)', ar: 'فيدال O', type: 'option', options: titers, ranges: [{ text: '< 1/80' }] },
  { code: 'WIDAL_H', en: 'Widal H (S. typhi)', ar: 'فيدال H', type: 'option', options: titers, ranges: [{ text: '< 1/80' }] },
  { code: 'BRUC', en: 'Brucella (Wright)', ar: 'رايت (البروسيلا)', type: 'option', options: titers, ranges: [{ text: '< 1/80' }] },
  { code: 'HBSAG', en: 'HBs antigen', ar: 'مستضد التهاب الكبد B', type: 'option', options: negPos, ranges: [{ text: 'Negative' }] },
  { code: 'HCV', en: 'HCV antibodies', ar: 'أضداد التهاب الكبد C', type: 'option', options: negPos, ranges: [{ text: 'Negative' }] },
  { code: 'HIV', en: 'HIV 1/2 antibodies', ar: 'أضداد فيروس العوز المناعي', type: 'option', options: negPos, ranges: [{ text: 'Negative' }] },
  // Coagulation
  { code: 'PT', en: 'Prothrombin time', ar: 'زمن البروثرومبين', unit: 'sec', decimals: 1, ranges: [{ low: 11.0, high: 13.5 }] },
  { code: 'INR', en: 'INR', ar: 'النسبة الدولية المعيارية', unit: '', decimals: 2, ranges: [{ low: 0.8, high: 1.2, critHigh: 5.0 }] },
  { code: 'APTT', en: 'APTT', ar: 'زمن الثرومبوبلاستين الجزئي', unit: 'sec', decimals: 1, ranges: [{ low: 25, high: 35, critHigh: 100 }] },
  // Urine
  { code: 'U_COLOR', en: 'Colour', ar: 'اللون', type: 'option', options: ['Yellow', 'Pale yellow', 'Dark yellow', 'Amber', 'Red'], ranges: [{ text: 'Yellow/Pale yellow' }] },
  { code: 'U_APPEAR', en: 'Appearance', ar: 'المظهر', type: 'option', options: ['Clear', 'Slightly turbid', 'Turbid'], ranges: [{ text: 'Clear' }] },
  { code: 'U_SG', en: 'Specific gravity', ar: 'الكثافة النوعية', unit: '', decimals: 3, ranges: [{ low: 1.005, high: 1.03 }] },
  { code: 'U_PH', en: 'pH', ar: 'درجة الحموضة', unit: '', decimals: 1, ranges: [{ low: 5.0, high: 8.0 }] },
  { code: 'U_PRO', en: 'Protein', ar: 'البروتين', type: 'option', options: dipstick, ranges: [{ text: 'Negative' }] },
  { code: 'U_GLU', en: 'Glucose', ar: 'السكر', type: 'option', options: dipstick, ranges: [{ text: 'Negative' }] },
  { code: 'U_KET', en: 'Ketones', ar: 'الكيتونات', type: 'option', options: dipstick, ranges: [{ text: 'Negative' }] },
  { code: 'U_BLD', en: 'Blood', ar: 'الدم', type: 'option', options: dipstick, ranges: [{ text: 'Negative' }] },
  { code: 'U_NIT', en: 'Nitrite', ar: 'النتريت', type: 'option', options: negPos, ranges: [{ text: 'Negative' }] },
  { code: 'U_LEU', en: 'Leukocyte esterase', ar: 'إستراز الكريات البيض', type: 'option', options: dipstick, ranges: [{ text: 'Negative' }] },
  { code: 'U_WBC', en: 'Pus cells', ar: 'الكريات البيض', unit: '/HPF', decimals: 0, ranges: [{ low: 0, high: 5 }] },
  { code: 'U_RBC', en: 'Red cells', ar: 'الكريات الحمر', unit: '/HPF', decimals: 0, ranges: [{ low: 0, high: 2 }] },
  { code: 'U_EPI', en: 'Epithelial cells', ar: 'الخلايا الظهارية', type: 'option', options: ['None', 'Few', 'Moderate', 'Many'] },
  { code: 'U_CRYS', en: 'Crystals', ar: 'البلورات', type: 'text', ranges: [{ text: 'None' }] },
  { code: 'U_BACT', en: 'Bacteria', ar: 'الجراثيم', type: 'option', options: ['None', 'Few', 'Moderate', 'Many'], ranges: [{ text: 'None/Few' }] },
  // Stool
  { code: 'S_COLOR', en: 'Colour', ar: 'اللون', type: 'option', options: ['Brown', 'Yellow', 'Green', 'Black', 'Red'], ranges: [{ text: 'Brown/Yellow' }] },
  { code: 'S_CONS', en: 'Consistency', ar: 'القوام', type: 'option', options: ['Formed', 'Soft', 'Loose', 'Watery'], ranges: [{ text: 'Formed/Soft' }] },
  { code: 'S_OVA', en: 'Ova & parasites', ar: 'البيوض والطفيليات', type: 'option', options: ['Not seen', 'Giardia lamblia cysts', 'Entamoeba histolytica cysts', 'Ascaris eggs'], ranges: [{ text: 'Not seen' }] },
  { code: 'S_WBC', en: 'Pus cells', ar: 'الكريات البيض', unit: '/HPF', decimals: 0, ranges: [{ low: 0, high: 2 }] },
  { code: 'S_OCC', en: 'Occult blood', ar: 'الدم الخفي', type: 'option', options: negPos, ranges: [{ text: 'Negative' }] },
  // Microbiology
  { code: 'UC_RESULT', en: 'Culture result', ar: 'نتيجة الزرع', type: 'option', options: ['No growth', 'Growth'], ranges: [{ text: 'No growth' }] },
  { code: 'UC_ORG', en: 'Organism', ar: 'العامل الممرض', type: 'text' },
  { code: 'UC_COUNT', en: 'Colony count', ar: 'تعداد المستعمرات', type: 'text' },
  { code: 'UC_SENS', en: 'Sensitivity', ar: 'التحسس', type: 'text' },
  // Blood gas
  { code: 'PH', en: 'pH', ar: 'درجة الحموضة', unit: '', decimals: 3, ranges: [{ low: 7.35, high: 7.45, critLow: 7.2, critHigh: 7.6 }] },
  { code: 'PCO2', en: 'pCO₂', ar: 'الضغط الجزئي لثاني أكسيد الكربون', unit: 'mmHg', decimals: 1, ranges: [{ low: 35, high: 45, critLow: 20, critHigh: 70 }] },
  { code: 'PO2', en: 'pO₂', ar: 'الضغط الجزئي للأكسجين', unit: 'mmHg', decimals: 1, ranges: [{ low: 80, high: 100, critLow: 40 }] },
  { code: 'HCO3', en: 'Bicarbonate', ar: 'البيكربونات', unit: 'mmol/L', decimals: 1, ranges: [{ low: 22, high: 26 }] },
];

const CBC = ['WBC', 'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW', 'PLT', 'MPV', 'NEUT%', 'LYMPH%', 'MONO%', 'EOS%', 'BASO%', 'NEUT#', 'LYMPH#', 'MONO#', 'EOS#', 'BASO#'];

export const TESTS: TestDef[] = [
  { code: 'CBC', en: 'Complete blood count', ar: 'تعداد عام وصيغة', dept: 'HEM', sampleType: 'WB', container: 'EDTA', units: 25, tat: 4, analytes: CBC, favorite: true, method: 'Impedance / flow cytometry' },
  { code: 'ESR', en: 'Erythrocyte sedimentation rate', ar: 'سرعة التثفل', dept: 'HEM', sampleType: 'WB', container: 'ESR', units: 8, tat: 2, analytes: ['ESR'], favorite: true, method: 'Westergren' },
  { code: 'RETIC', en: 'Reticulocyte count', ar: 'تعداد الشبكيات', dept: 'HEM', sampleType: 'WB', container: 'EDTA', units: 15, analytes: ['RETIC'] },
  { code: 'ABO', en: 'Blood group & Rh', ar: 'الزمرة والعامل الريزوسي', dept: 'HEM', sampleType: 'WB', container: 'EDTA', units: 10, analytes: ['ABO', 'RH'], favorite: true },
  { code: 'GLU', en: 'Glucose', ar: 'سكر الدم', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 8, tat: 2, analytes: ['GLU'], favorite: true },
  { code: 'HBA1C', en: 'HbA1c', ar: 'الخضاب السكري', dept: 'CHEM', sampleType: 'WB', container: 'EDTA', units: 35, analytes: ['HBA1C'], favorite: true },
  { code: 'UREA', en: 'Urea', ar: 'البولة', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 8, analytes: ['UREA'], favorite: true },
  { code: 'CREA', en: 'Creatinine + eGFR', ar: 'الكرياتينين ومعدل الرشح', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 10, analytes: ['CREA', 'EGFR'], favorite: true },
  { code: 'UA', en: 'Uric acid', ar: 'حمض البول', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 8, analytes: ['UA'] },
  { code: 'LIPID', en: 'Lipid profile', ar: 'شحوم الدم', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 40, analytes: ['CHOL', 'TG', 'HDL', 'LDL', 'VLDL'], favorite: true },
  { code: 'LFT', en: 'Liver function tests', ar: 'وظائف الكبد', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 60, analytes: ['ALT', 'AST', 'ALP', 'GGT', 'TBIL', 'DBIL', 'IBIL', 'TP', 'ALB', 'GLOB', 'AGR'] },
  { code: 'ALT', en: 'ALT (SGPT)', ar: 'خميرة ALT', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 8, analytes: ['ALT'], favorite: true },
  { code: 'AST', en: 'AST (SGOT)', ar: 'خميرة AST', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 8, analytes: ['AST'] },
  { code: 'ELEC', en: 'Electrolytes (Na, K, Cl)', ar: 'الشوارد', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 25, tat: 2, analytes: ['NA', 'K', 'CL'] },
  { code: 'CA', en: 'Calcium', ar: 'الكالسيوم', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 8, analytes: ['CA'] },
  { code: 'MG', en: 'Magnesium', ar: 'المغنيزيوم', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 10, analytes: ['MG'] },
  { code: 'PHOS', en: 'Phosphorus', ar: 'الفوسفور', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 10, analytes: ['PHOS'] },
  { code: 'CRP', en: 'C-reactive protein', ar: 'البروتين الارتكاسي C', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 15, tat: 2, analytes: ['CRP'], favorite: true },
  { code: 'IRON', en: 'Serum iron', ar: 'الحديد', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 15, analytes: ['IRON'] },
  { code: 'AMY', en: 'Amylase', ar: 'الأميلاز', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 15, analytes: ['AMY'] },
  { code: 'CK', en: 'Creatine kinase', ar: 'الكرياتين كيناز', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 15, analytes: ['CK'] },
  { code: 'LDH', en: 'LDH', ar: 'نازعة هيدروجين اللاكتات', dept: 'CHEM', sampleType: 'SER', container: 'SST', units: 15, analytes: ['LDH'] },
  { code: 'TSH', en: 'TSH', ar: 'الهرمون المنبه للدرق', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 35, tat: 6, analytes: ['TSH'], favorite: true },
  { code: 'FT4', en: 'Free T4', ar: 'الثيروكسين الحر', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 35, tat: 6, analytes: ['FT4'] },
  { code: 'FT3', en: 'Free T3', ar: 'ثلاثي يود الثيرونين الحر', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 35, tat: 6, analytes: ['FT3'] },
  { code: 'VITD', en: 'Vitamin D (25-OH)', ar: 'فيتامين د', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 70, tat: 24, analytes: ['VITD'], favorite: true },
  { code: 'B12', en: 'Vitamin B12', ar: 'فيتامين ب12', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 50, tat: 24, analytes: ['B12'] },
  { code: 'FERR', en: 'Ferritin', ar: 'الفيريتين', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 45, tat: 24, analytes: ['FERR'] },
  { code: 'PSA', en: 'PSA (total)', ar: 'المستضد البروستاتي', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 45, tat: 24, analytes: ['PSA'] },
  { code: 'BHCG', en: 'β-hCG (pregnancy)', ar: 'هرمون الحمل', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 35, tat: 4, analytes: ['BHCG'] },
  { code: 'PRL', en: 'Prolactin', ar: 'البرولاكتين', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 40, tat: 24, analytes: ['PRL'] },
  { code: 'INS', en: 'Insulin (fasting)', ar: 'الأنسولين', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 45, tat: 24, analytes: ['INS'] },
  { code: 'PCT', en: 'Procalcitonin', ar: 'البروكالسيتونين', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 80, tat: 2, analytes: ['PCT'] },
  { code: 'TNI', en: 'Troponin I', ar: 'التروبونين I', dept: 'IMM', sampleType: 'SER', container: 'SST', units: 60, tat: 1, analytes: ['TNI'] },
  { code: 'DDIMER', en: 'D-dimer', ar: 'دي-دايمر', dept: 'IMM', sampleType: 'PLC', container: 'CIT', units: 60, tat: 2, analytes: ['DDIMER'] },
  { code: 'RF', en: 'Rheumatoid factor', ar: 'العامل الرثواني', dept: 'SER', sampleType: 'SER', container: 'SST', units: 15, analytes: ['RF'] },
  { code: 'ASO', en: 'ASO titre', ar: 'أضداد الستربتوليزين O', dept: 'SER', sampleType: 'SER', container: 'SST', units: 15, analytes: ['ASO'] },
  { code: 'WIDAL', en: 'Widal test', ar: 'تفاعل فيدال', dept: 'SER', sampleType: 'SER', container: 'SST', units: 20, analytes: ['WIDAL_O', 'WIDAL_H'] },
  { code: 'BRUC', en: 'Brucella agglutination (Wright)', ar: 'تفاعل رايت', dept: 'SER', sampleType: 'SER', container: 'SST', units: 20, analytes: ['BRUC'] },
  { code: 'HBSAG', en: 'HBs antigen', ar: 'مستضد التهاب الكبد B', dept: 'SER', sampleType: 'SER', container: 'SST', units: 20, analytes: ['HBSAG'] },
  { code: 'HCV', en: 'HCV antibodies', ar: 'أضداد التهاب الكبد C', dept: 'SER', sampleType: 'SER', container: 'SST', units: 25, analytes: ['HCV'] },
  { code: 'HIV', en: 'HIV 1/2 antibodies', ar: 'أضداد فيروس العوز المناعي', dept: 'SER', sampleType: 'SER', container: 'SST', units: 25, analytes: ['HIV'] },
  { code: 'PT', en: 'Prothrombin time (PT/INR)', ar: 'زمن البروثرومبين', dept: 'COAG', sampleType: 'PLC', container: 'CIT', units: 15, tat: 2, analytes: ['PT', 'INR'], favorite: true },
  { code: 'APTT', en: 'APTT', ar: 'زمن الثرومبوبلاستين الجزئي', dept: 'COAG', sampleType: 'PLC', container: 'CIT', units: 15, tat: 2, analytes: ['APTT'] },
  { code: 'URINE', en: 'Urinalysis', ar: 'تحليل بول كامل', dept: 'URN', sampleType: 'URINE', container: 'URC', units: 12, tat: 2, favorite: true,
    analytes: ['U_COLOR', 'U_APPEAR', 'U_SG', 'U_PH', 'U_PRO', 'U_GLU', 'U_KET', 'U_BLD', 'U_NIT', 'U_LEU', 'U_WBC', 'U_RBC', 'U_EPI', 'U_CRYS', 'U_BACT'] },
  { code: 'STOOL', en: 'Stool analysis', ar: 'تحليل براز', dept: 'URN', sampleType: 'STOOL', container: 'STC', units: 12, tat: 2, analytes: ['S_COLOR', 'S_CONS', 'S_OVA', 'S_WBC', 'S_OCC'] },
  { code: 'UCULT', en: 'Urine culture & sensitivity', ar: 'زرع بول وتحسس', dept: 'MIC', sampleType: 'URINE', container: 'URC', units: 45, tat: 72, separateTube: true, analytes: ['UC_RESULT', 'UC_ORG', 'UC_COUNT', 'UC_SENS'] },
  { code: 'ABG', en: 'Arterial blood gas', ar: 'غازات الدم الشرياني', dept: 'BG', sampleType: 'ABG', container: 'HEPS', units: 40, tat: 1, analytes: ['PH', 'PCO2', 'PO2', 'HCO3'] },
];

export const PACKAGES = [
  { code: 'CHECKUP', en: 'General check-up', ar: 'فحص عام شامل', mode: 'units' as const, units: 180, tests: ['CBC', 'GLU', 'UREA', 'CREA', 'UA', 'LIPID', 'ALT', 'AST', 'TSH', 'URINE'] },
  { code: 'DIABETES', en: 'Diabetes follow-up', ar: 'متابعة السكري', mode: 'units' as const, units: 85, tests: ['GLU', 'HBA1C', 'CREA', 'LIPID'] },
  { code: 'PREMARITAL', en: 'Premarital screening', ar: 'فحوص ما قبل الزواج', mode: 'units' as const, units: 95, tests: ['CBC', 'ABO', 'HBSAG', 'HCV', 'HIV'] },
  { code: 'THYROID', en: 'Thyroid panel', ar: 'وظائف الدرق', mode: 'units' as const, units: 90, tests: ['TSH', 'FT4', 'FT3'] },
  { code: 'KIDNEY', en: 'Kidney panel', ar: 'وظائف الكلية', mode: 'sum' as const, units: null, tests: ['UREA', 'CREA', 'UA'] },
];

export const PAYMENT_METHODS = [
  { code: 'CASH', en: 'Cash', ar: 'نقدي', isCash: true },
  { code: 'CARD', en: 'Bank card', ar: 'بطاقة مصرفية', isCash: false },
  { code: 'TRANSFER', en: 'Bank transfer', ar: 'حوالة مصرفية', isCash: false },
  { code: 'WALLET', en: 'Mobile wallet', ar: 'محفظة إلكترونية', isCash: false },
];

export const EXPENSE_CATEGORIES = [
  { en: 'Salaries', ar: 'رواتب' },
  { en: 'Reagents & kits', ar: 'كواشف ومستلزمات' },
  { en: 'Rent', ar: 'إيجار' },
  { en: 'Electricity & generator', ar: 'كهرباء ومولّدة' },
  { en: 'Maintenance', ar: 'صيانة' },
  { en: 'Other', ar: 'أخرى' },
];

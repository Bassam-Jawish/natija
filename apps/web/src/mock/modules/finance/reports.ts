/**
 * Analytics routes and exports: port of apps/api/src/modules/analytics/{routes,export}.ts.
 * Dashboard, management reports and their downloads, which come out as CSV in mock mode (the
 * same sheets as the server's Excel workbooks, one after another). Money figures need
 * finance.read too.
 */
import { z } from 'zod';
import { adminRangeQuery, ANALYTICS_REPORTS, type AnalyticsReport } from '@natija/contracts';
import { forbidden, notFound } from '../../core/context';
import type { MockFile } from '../../core/file';
import { getLab, parse } from '../../core/lib';
import { route, type MockRequest } from '../../core/router';
import * as svc from './analytics';
import { referrals } from './doctors';
import { buildWorkbook, L, type Lang, type SheetSpec } from './workbook';

const nm = (lang: Lang, ar: string | null | undefined, en: string | null | undefined) => (lang === 'ar' ? ar || en : en || ar) ?? '';

/** Build the export file for one analytics report. */
export function exportReport(report: AnalyticsReport, r: svc.Range, lang: Lang, showMoney: boolean): MockFile {
  const lab = getLab();
  const period = `${r.from} → ${r.to}`;
  const labName = nm(lang, lab.nameAr, lab.nameEn);
  const T = (en: string, ar: string) => L(lang, en, ar);
  const head = (title: string): Pick<SheetSpec, 'title' | 'subtitle'> => ({ title: `${labName} · ${title}`, subtitle: period });
  let sheets: SheetSpec[] = [];

  if (report === 'tat') {
    const d = svc.tatReport(r);
    const statCols = [
      { header: T('Tests', 'التحاليل'), key: 'count', format: 'int' as const },
      { header: T('Median (min)', 'الوسيط (دقيقة)'), key: 'median', format: 'minutes' as const },
      { header: T('90th percentile (min)', 'المئين 90 (دقيقة)'), key: 'p90', format: 'minutes' as const },
      { header: T('Within TAT %', 'ضمن الزمن المحدد %'), key: 'onTimePct', format: 'percent' as const },
    ];
    sheets = [
      {
        name: T('Summary', 'ملخص'),
        ...head(T('Turnaround time (received → validated)', 'زمن الإنجاز (من الاستلام إلى المصادقة)')),
        columns: [
          { header: T('Measure', 'المؤشر'), key: 'k', width: 40 },
          { header: T('Value', 'القيمة'), key: 'v', format: 'decimal', width: 16 },
        ],
        rows: [
          { k: T('Tests', 'التحاليل'), v: d.overall.count },
          { k: T('Median (min)', 'الوسيط (دقيقة)'), v: d.overall.median },
          { k: T('90th percentile (min)', 'المئين 90 (دقيقة)'), v: d.overall.p90 },
          { k: T('Mean (min)', 'المتوسط (دقيقة)'), v: d.overall.mean },
          { k: T('Within TAT %', 'ضمن الزمن المحدد %'), v: d.overall.onTimePct },
          { k: T('Collection → receipt, median (min)', 'من السحب إلى الاستلام، الوسيط (دقيقة)'), v: d.phases.collectToReceive },
          { k: T('Receipt → first result, median (min)', 'من الاستلام إلى أول نتيجة، الوسيط (دقيقة)'), v: d.phases.receiveToResult },
          { k: T('Result → validation, median (min)', 'من النتيجة إلى المصادقة، الوسيط (دقيقة)'), v: d.phases.resultToValidate },
        ],
      },
      {
        name: T('By department', 'حسب القسم'),
        columns: [{ header: T('Department', 'القسم'), key: 'name', width: 28 }, ...statCols],
        rows: d.byDepartment.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) })),
      },
      {
        name: T('By test', 'حسب التحليل'),
        columns: [
          { header: T('Code', 'الرمز'), key: 'code', width: 12 },
          { header: T('Test', 'التحليل'), key: 'name', width: 32 },
          { header: T('Target (h)', 'الزمن المحدد (ساعة)'), key: 'tatHours', format: 'int' },
          ...statCols,
        ],
        rows: d.byTest.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) })),
      },
      {
        name: T('By day', 'حسب اليوم'),
        columns: [
          { header: T('Date', 'التاريخ'), key: 'date', width: 12 },
          { header: T('Tests', 'التحاليل'), key: 'count', format: 'int' },
          { header: T('Median (min)', 'الوسيط (دقيقة)'), key: 'median', format: 'minutes' },
          { header: T('90th percentile (min)', 'المئين 90 (دقيقة)'), key: 'p90', format: 'minutes' },
        ],
        rows: d.byDay,
      },
    ];
  } else if (report === 'volume') {
    const d = svc.volumeReport(r);
    sheets = [
      {
        name: T('By day', 'حسب اليوم'),
        ...head(T('Workload', 'حجم العمل')),
        columns: [
          { header: T('Date', 'التاريخ'), key: 'date', width: 12 },
          { header: T('Orders', 'الطلبات'), key: 'orders', format: 'int' },
          { header: T('Tests', 'التحاليل'), key: 'tests', format: 'int' },
          { header: T('Patients', 'المرضى'), key: 'patients', format: 'int' },
        ],
        rows: d.byDay,
        totals: { date: T('Total', 'المجموع'), orders: d.totals.orders, tests: d.totals.tests, patients: d.totals.patients },
      },
      {
        name: T('By department', 'حسب القسم'),
        columns: [
          { header: T('Department', 'القسم'), key: 'name', width: 28 },
          { header: T('Tests', 'التحاليل'), key: 'tests', format: 'int' },
        ],
        rows: d.byDepartment.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) })),
      },
      {
        name: T('By test', 'حسب التحليل'),
        columns: [
          { header: T('Code', 'الرمز'), key: 'code', width: 12 },
          { header: T('Test', 'التحليل'), key: 'name', width: 32 },
          { header: T('Count', 'العدد'), key: 'count', format: 'int' },
        ],
        rows: d.byTest.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) })),
      },
      {
        name: T('By hour', 'حسب الساعة'),
        columns: [
          { header: T('Hour', 'الساعة'), key: 'hour', format: 'int' },
          { header: T('Orders', 'الطلبات'), key: 'orders', format: 'int' },
        ],
        rows: d.byHour,
      },
    ];
  } else if (report === 'revenue') {
    if (!showMoney) return exportReport('volume', r, lang, false);
    const d = svc.revenueReport(r);
    sheets = [
      {
        name: T('Summary', 'ملخص'),
        ...head(T('Revenue', 'الإيرادات')),
        columns: [
          { header: T('Measure', 'المؤشر'), key: 'k', width: 34 },
          { header: T('Amount', 'المبلغ'), key: 'v', format: 'money', width: 18 },
        ],
        rows: [
          { k: T('Billed (gross)', 'المفوتر (الإجمالي)'), v: d.totals.billed },
          { k: T('Discounts', 'الحسومات'), v: d.totals.discounts },
          { k: T('Net revenue', 'صافي الإيراد'), v: d.totals.net },
          { k: T('Patient share', 'حصة المرضى'), v: d.totals.patientShare },
          { k: T('Payer share (receivable)', 'حصة الجهات (ذمم)'), v: d.totals.insurerShare },
          { k: T('Collected (net of refunds)', 'المحصّل (بعد المرتجعات)'), v: d.totals.collected },
          { k: T('Refunds', 'المرتجعات'), v: d.totals.refunds },
          { k: T('Outstanding (patients)', 'المتبقي على المرضى'), v: d.totals.outstanding },
        ],
      },
      {
        name: T('By day', 'حسب اليوم'),
        columns: [
          { header: T('Date', 'التاريخ'), key: 'date', width: 12 },
          { header: T('Net revenue', 'صافي الإيراد'), key: 'net', format: 'money', width: 16 },
          { header: T('Collected', 'المحصّل'), key: 'collected', format: 'money', width: 16 },
        ],
        rows: d.byDay,
      },
      {
        name: T('By payer', 'حسب الجهة'),
        columns: [
          { header: T('Payer', 'الجهة'), key: 'name', width: 30 },
          { header: T('Invoices', 'الفواتير'), key: 'invoices', format: 'int' },
          { header: T('Net', 'الصافي'), key: 'net', format: 'money', width: 16 },
          { header: T('Patient share', 'حصة المريض'), key: 'patient', format: 'money', width: 16 },
          { header: T('Payer share', 'حصة الجهة'), key: 'insurer', format: 'money', width: 16 },
          { header: T('Paid', 'المدفوع'), key: 'paid', format: 'money', width: 16 },
          { header: T('Outstanding', 'المتبقي'), key: 'outstanding', format: 'money', width: 16 },
        ],
        rows: d.byPayer.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) })),
      },
      {
        name: T('By department', 'حسب القسم'),
        columns: [
          { header: T('Department', 'القسم'), key: 'name', width: 28 },
          { header: T('Tests', 'التحاليل'), key: 'tests', format: 'int' },
          { header: T('Net', 'الصافي'), key: 'net', format: 'money', width: 16 },
        ],
        rows: d.byDepartment.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) })),
      },
      {
        name: T('By method', 'حسب طريقة الدفع'),
        columns: [
          { header: T('Method', 'الطريقة'), key: 'name', width: 24 },
          { header: T('Payments', 'الدفعات'), key: 'payments', format: 'money', width: 16 },
          { header: T('Refunds', 'المرتجعات'), key: 'refunds', format: 'money', width: 16 },
          { header: T('Net', 'الصافي'), key: 'net', format: 'money', width: 16 },
        ],
        rows: d.byMethod.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) })),
      },
    ];
  } else if (report === 'productivity') {
    const d = svc.productivityReport(r);
    sheets = [
      {
        name: T('Staff', 'الموظفون'),
        ...head(T('Productivity', 'الإنتاجية')),
        columns: [
          { header: T('Staff member', 'الموظف'), key: 'name', width: 28 },
          { header: T('Results entered', 'نتائج مدخلة'), key: 'entered', format: 'int' },
          { header: T('Verified', 'مدققة فنياً'), key: 'verified', format: 'int' },
          { header: T('Validated', 'مصادق عليها'), key: 'validated', format: 'int' },
          { header: T('Orders registered', 'طلبات مسجلة'), key: 'ordersCreated', format: 'int' },
          { header: T('Samples collected', 'عينات مسحوبة'), key: 'samplesCollected', format: 'int' },
          { header: T('Samples received', 'عينات مستلمة'), key: 'samplesReceived', format: 'int' },
        ],
        rows: d.users.map((u) => ({ ...u, name: u.userId ? nm(lang, u.nameAr, u.nameEn) : T('Automatic (analyzers, calculations)', 'تلقائي (الأجهزة والحسابات)') })),
      },
    ];
  } else if (report === 'rejections') {
    const d = svc.rejectionsReport(r);
    sheets = [
      {
        name: T('By reason', 'حسب السبب'),
        ...head(T(`Rejected samples: ${d.totals.rejected} of ${d.totals.evaluated}`, `العينات المرفوضة: ${d.totals.rejected} من ${d.totals.evaluated}`)),
        columns: [
          { header: T('Reason', 'السبب'), key: 'name', width: 30 },
          { header: T('Samples', 'العينات'), key: 'count', format: 'int' },
        ],
        rows: d.byReason.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) || T('Not given', 'غير محدد') })),
      },
      {
        name: T('By collector', 'حسب الساحب'),
        columns: [
          { header: T('Collected by', 'سحبها'), key: 'name', width: 28 },
          { header: T('Samples', 'العينات'), key: 'count', format: 'int' },
        ],
        rows: d.byCollector.map((x) => ({ ...x, name: nm(lang, x.nameAr, x.nameEn) || T('Unknown', 'غير معروف') })),
      },
      {
        name: T('Recent', 'الأحدث'),
        columns: [
          { header: T('Rejected at', 'وقت الرفض'), key: 'rejectedAt', format: 'datetime', width: 18 },
          { header: T('Tube', 'الأنبوب'), key: 'barcode', width: 18 },
          { header: T('Order', 'الطلب'), key: 'accession', width: 14 },
          { header: T('Patient', 'المريض'), key: 'patient', width: 28 },
          { header: T('Reason', 'السبب'), key: 'reason', width: 26 },
          { header: T('Note', 'ملاحظة'), key: 'note', width: 30 },
        ],
        rows: d.recent.map((x) => ({ ...x, patient: nm(lang, x.patientNameAr, x.patientNameEn), reason: nm(lang, x.reasonNameAr, x.reasonNameEn) })),
      },
    ];
  } else if (report === 'instruments') {
    const d = svc.instrumentsReport(r);
    sheets = [
      {
        name: T('Analyzers', 'الأجهزة'),
        ...head(T('Analyzers', 'الأجهزة')),
        columns: [
          { header: T('Code', 'الرمز'), key: 'code', width: 12 },
          { header: T('Analyzer', 'الجهاز'), key: 'name', width: 26 },
          { header: T('Status', 'الحالة'), key: 'status', width: 12 },
          { header: T('Messages', 'الرسائل'), key: 'messages', format: 'int' },
          { header: T('Errors', 'أخطاء'), key: 'errors', format: 'int' },
          { header: T('Unmatched', 'غير مطابقة'), key: 'unmatched', format: 'int' },
          { header: T('Results', 'النتائج'), key: 'results', format: 'int' },
          { header: T('QC runs', 'تشغيلات الجودة'), key: 'qcRuns', format: 'int' },
          { header: T('QC rejected', 'جودة مرفوضة'), key: 'qcRejected', format: 'int' },
          { header: T('Last message', 'آخر رسالة'), key: 'lastMessageAt', format: 'datetime', width: 18 },
        ],
        rows: d.items,
      },
    ];
  } else {
    const d = referrals(r.from, r.to, showMoney);
    sheets = [
      {
        name: T('Doctors', 'الأطباء'),
        ...head(T('Referrals by doctor', 'الإحالات حسب الطبيب')),
        columns: [
          { header: T('Doctor', 'الطبيب'), key: 'name', width: 30 },
          { header: T('Specialty', 'الاختصاص'), key: 'specialty', width: 24 },
          { header: T('Orders', 'الطلبات'), key: 'orders', format: 'int' },
          { header: T('Patients', 'المرضى'), key: 'patients', format: 'int' },
          { header: T('Tests', 'التحاليل'), key: 'tests', format: 'int' },
          ...(showMoney ? [{ header: T('Revenue', 'الإيراد'), key: 'revenue', format: 'money' as const, width: 16 }] : []),
        ],
        rows: [...d.items, d.walkIn].map((x) => ({
          ...x,
          name: x.doctorId ? nm(lang, x.nameAr, x.nameEn) : T('No referring doctor', 'بدون طبيب محيل'),
          specialty: nm(lang, x.specialtyAr, x.specialtyEn),
        })),
      },
    ];
  }

  return buildWorkbook(sheets, `natija-${report}-${r.from}_${r.to}.xlsx`, { timeZone: lab.timezone });
}

/** Dashboard, management reports and their exports. Money figures need finance.read too. */
export function registerAnalyticsRoutes(): void {
  const perm = { perm: 'analytics.read' };
  const range = (req: MockRequest) => {
    const q = parse(adminRangeQuery, req.query);
    return svc.resolveRange(q.from, q.to);
  };
  const showMoney = (req: MockRequest) => req.auth!.permissions.has('finance.read');

  route('GET', '/analytics/dashboard', perm, (req) => svc.dashboard(range(req), showMoney(req)));
  route('GET', '/analytics/tat', perm, (req) => svc.tatReport(range(req)));
  route('GET', '/analytics/volume', perm, (req) => svc.volumeReport(range(req)));
  route('GET', '/analytics/revenue', perm, (req) => {
    if (!showMoney(req)) throw forbidden('permission', 'Needs finance.read');
    return svc.revenueReport(range(req));
  });
  route('GET', '/analytics/productivity', perm, (req) => svc.productivityReport(range(req)));
  route('GET', '/analytics/rejections', perm, (req) => svc.rejectionsReport(range(req)));
  route('GET', '/analytics/instruments', perm, (req) => svc.instrumentsReport(range(req)));
  route('GET', '/analytics/doctors', perm, (req) => {
    const r = range(req);
    return referrals(r.from, r.to, showMoney(req));
  });

  route('GET', '/analytics/export/:report', perm, (req) => {
    const report = req.params.report as AnalyticsReport;
    if (!(ANALYTICS_REPORTS as readonly string[]).includes(report)) throw notFound('not_found', `No report ${report}`);
    if (report === 'revenue' && !showMoney(req)) throw forbidden('permission', 'Needs finance.read');
    const q = parse(adminRangeQuery.extend({ lang: z.enum(['ar', 'en']).default('ar') }), req.query);
    return exportReport(report, svc.resolveRange(q.from, q.to), q.lang === 'en' ? 'en' : 'ar', showMoney(req));
  });
}

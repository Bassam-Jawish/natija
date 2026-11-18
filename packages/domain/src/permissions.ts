/** Every permission the platform checks on the server. Roles are named sets of these. */
export const PERMISSIONS = {
  'patients.read': { group: 'patients', ar: 'عرض المرضى', en: 'View patients' },
  'patients.write': { group: 'patients', ar: 'إضافة المرضى وتعديلهم', en: 'Add and edit patients' },
  'patients.merge': { group: 'patients', ar: 'دمج سجلات المرضى', en: 'Merge patient records' },
  'orders.read': { group: 'orders', ar: 'عرض الطلبات', en: 'View orders' },
  'orders.create': { group: 'orders', ar: 'إنشاء الطلبات', en: 'Create orders' },
  'orders.edit': { group: 'orders', ar: 'تعديل الطلبات', en: 'Edit orders' },
  'orders.cancel': { group: 'orders', ar: 'إلغاء الطلبات', en: 'Cancel orders' },
  'samples.collect': { group: 'samples', ar: 'سحب العينات وطباعة الملصقات', en: 'Collect samples and print labels' },
  'samples.receive': { group: 'samples', ar: 'استلام العينات في المخبر', en: 'Receive samples at the bench' },
  'samples.reject': { group: 'samples', ar: 'رفض العينات', en: 'Reject samples' },
  'samples.store': { group: 'samples', ar: 'تخزين العينات وإتلافها', en: 'Store and dispose of samples' },
  'results.read': { group: 'results', ar: 'عرض النتائج', en: 'View results' },
  'results.enter': { group: 'results', ar: 'إدخال النتائج', en: 'Enter results' },
  'results.verify': { group: 'results', ar: 'التدقيق الفني للنتائج', en: 'Technically verify results' },
  'results.validate': { group: 'results', ar: 'المصادقة الطبية على النتائج', en: 'Medically validate results' },
  'results.amend': { group: 'results', ar: 'تعديل النتائج بعد الإصدار', en: 'Amend released results' },
  'reports.print': { group: 'reports', ar: 'طباعة التقارير', en: 'Print reports' },
  'reports.deliver': { group: 'reports', ar: 'تسليم التقارير وإرسالها', en: 'Deliver and send reports' },
  'finance.read': { group: 'finance', ar: 'عرض الحسابات', en: 'View finance' },
  'finance.payment': { group: 'finance', ar: 'استلام الدفعات', en: 'Take payments' },
  'finance.refund': { group: 'finance', ar: 'المرتجعات', en: 'Issue refunds' },
  'finance.approve': { group: 'finance', ar: 'الموافقة على الحسومات والمجاني والمرتجعات', en: 'Approve discounts, free tests and refunds' },
  'finance.cash': { group: 'finance', ar: 'فتح الصندوق وإغلاقه', en: 'Open and close cash sessions' },
  'finance.expenses': { group: 'finance', ar: 'المصاريف', en: 'Record expenses' },
  'catalog.manage': { group: 'settings', ar: 'إدارة دليل التحاليل والمجالات', en: 'Manage tests, ranges and catalog' },
  'pricing.manage': { group: 'settings', ar: 'إدارة الأسعار والجهات', en: 'Manage prices and payer groups' },
  'doctors.manage': { group: 'settings', ar: 'إدارة الأطباء', en: 'Manage doctors' },
  'instruments.read': { group: 'instruments', ar: 'عرض الأجهزة والرسائل', en: 'View analyzers and messages' },
  'instruments.manage': { group: 'instruments', ar: 'إعداد الأجهزة وربط الرموز', en: 'Configure analyzers and code maps' },
  'integration.review': { group: 'instruments', ar: 'مراجعة النتائج غير المطابقة', en: 'Review unmatched analyzer results' },
  'qc.read': { group: 'instruments', ar: 'عرض ضبط الجودة', en: 'View quality control' },
  'qc.write': { group: 'instruments', ar: 'تسجيل ضبط الجودة والصيانة', en: 'Record QC and maintenance' },
  'users.manage': { group: 'admin', ar: 'إدارة المستخدمين والأدوار', en: 'Manage staff and roles' },
  'settings.manage': { group: 'admin', ar: 'إعدادات المخبر والهوية', en: 'Lab settings and branding' },
  'audit.read': { group: 'admin', ar: 'سجل التدقيق', en: 'Read the audit log' },
  'analytics.read': { group: 'admin', ar: 'التقارير والإحصائيات', en: 'Reports and statistics' },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}

export type RoleTemplate = { key: string; nameAr: string; nameEn: string; permissions: Permission[] };

const without = (...excluded: Permission[]) => ALL_PERMISSIONS.filter((p) => !excluded.includes(p));

/** System role templates. Each lab gets a copy and can edit it. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  { key: 'owner', nameAr: 'مالك المخبر', nameEn: 'Lab owner', permissions: [...ALL_PERMISSIONS] },
  { key: 'manager', nameAr: 'مدير المخبر', nameEn: 'Lab manager', permissions: without('users.manage') },
  {
    key: 'receptionist',
    nameAr: 'موظف استقبال',
    nameEn: 'Receptionist',
    permissions: [
      'patients.read', 'patients.write', 'orders.read', 'orders.create', 'orders.edit',
      'samples.collect', 'results.read', 'reports.print', 'reports.deliver',
      'finance.read', 'finance.payment', 'finance.cash',
    ],
  },
  {
    key: 'technician',
    nameAr: 'فني مخبر',
    nameEn: 'Lab technician',
    permissions: [
      'patients.read', 'orders.read', 'samples.collect', 'samples.receive', 'samples.reject', 'samples.store',
      'results.read', 'results.enter', 'results.verify', 'instruments.read', 'integration.review',
      'qc.read', 'qc.write', 'reports.print',
    ],
  },
  {
    key: 'specialist',
    nameAr: 'طبيب مخبري (مصادقة)',
    nameEn: 'Specialist / validator',
    permissions: [
      'patients.read', 'orders.read', 'samples.receive', 'samples.reject',
      'results.read', 'results.enter', 'results.verify', 'results.validate', 'results.amend',
      'reports.print', 'reports.deliver', 'instruments.read', 'integration.review', 'qc.read', 'analytics.read',
    ],
  },
  {
    key: 'accountant',
    nameAr: 'محاسب',
    nameEn: 'Accountant',
    permissions: [
      'patients.read', 'orders.read', 'finance.read', 'finance.payment', 'finance.refund',
      'finance.approve', 'finance.cash', 'finance.expenses', 'pricing.manage', 'analytics.read',
    ],
  },
];

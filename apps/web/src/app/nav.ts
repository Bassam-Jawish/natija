import {
  Activity,
  AlertCircle,
  BadgeCheck,
  BarChart3,
  BookOpen,
  ClipboardList,
  Coins,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  MessageSquare,
  Receipt,
  ScrollText,
  Send,
  Settings,
  ShieldCheck,
  Stethoscope,
  Syringe,
  Tags,
  TestTubes,
  UserCog,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = { to: string; labelKey: string; icon: LucideIcon; perms: string[]; end?: boolean };
export type NavGroup = { key: string; labelKey: string; items: NavItem[] };

/** Sidebar navigation. Items show only when the user holds one of `perms`. */
export const NAV: NavGroup[] = [
  {
    key: 'overview',
    labelKey: 'nav.groups.overview',
    items: [{ to: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, perms: ['analytics.read'] }],
  },
  {
    key: 'desk',
    labelKey: 'nav.groups.desk',
    items: [
      { to: '/reception', labelKey: 'nav.reception', icon: UserPlus, perms: ['orders.create'] },
      { to: '/patients', labelKey: 'nav.patients', icon: Users, perms: ['patients.read'] },
      { to: '/orders', labelKey: 'nav.orders', icon: ClipboardList, perms: ['orders.read'] },
    ],
  },
  {
    key: 'lab',
    labelKey: 'nav.groups.lab',
    items: [
      { to: '/collection', labelKey: 'nav.collection', icon: Syringe, perms: ['samples.collect'] },
      { to: '/samples', labelKey: 'nav.samples', icon: TestTubes, perms: ['samples.receive'] },
      { to: '/worklists', labelKey: 'nav.worklists', icon: FlaskConical, perms: ['results.enter'] },
      { to: '/validation', labelKey: 'nav.validation', icon: ShieldCheck, perms: ['results.validate'] },
      { to: '/delivery', labelKey: 'nav.delivery', icon: Send, perms: ['reports.deliver'] },
    ],
  },
  {
    key: 'analyzers',
    labelKey: 'nav.groups.analyzers',
    items: [
      { to: '/instruments', labelKey: 'nav.instruments', icon: Cpu, perms: ['instruments.read'] },
      { to: '/integration/review', labelKey: 'nav.review', icon: AlertCircle, perms: ['integration.review'] },
      { to: '/qc', labelKey: 'nav.qc', icon: Activity, perms: ['qc.read'] },
    ],
  },
  {
    key: 'finance',
    labelKey: 'nav.groups.finance',
    items: [
      { to: '/finance', labelKey: 'nav.cashier', icon: Wallet, perms: ['finance.cash', 'finance.payment'], end: true },
      { to: '/finance/invoices', labelKey: 'nav.invoices', icon: Receipt, perms: ['finance.read'] },
      { to: '/finance/approvals', labelKey: 'nav.approvals', icon: BadgeCheck, perms: ['finance.approve'] },
      { to: '/finance/expenses', labelKey: 'nav.expenses', icon: Coins, perms: ['finance.expenses'] },
    ],
  },
  {
    key: 'insights',
    labelKey: 'nav.groups.insights',
    items: [{ to: '/analytics', labelKey: 'nav.analytics', icon: BarChart3, perms: ['analytics.read'] }],
  },
  {
    key: 'settings',
    labelKey: 'nav.groups.settings',
    items: [
      { to: '/settings', labelKey: 'nav.labSettings', icon: Settings, perms: ['settings.manage'], end: true },
      { to: '/settings/catalog', labelKey: 'nav.catalog', icon: BookOpen, perms: ['catalog.manage'] },
      { to: '/settings/pricing', labelKey: 'nav.pricing', icon: Tags, perms: ['pricing.manage'] },
      { to: '/settings/doctors', labelKey: 'nav.doctors', icon: Stethoscope, perms: ['doctors.manage'] },
      { to: '/settings/staff', labelKey: 'nav.staff', icon: UserCog, perms: ['users.manage'] },
      { to: '/messages', labelKey: 'nav.messages', icon: MessageSquare, perms: ['settings.manage', 'reports.deliver'] },
      { to: '/audit', labelKey: 'nav.audit', icon: ScrollText, perms: ['audit.read'] },
    ],
  },
];

/** Where each role lands after signing in: the first page it can open, in this order. */
export const HOME_ORDER: Array<{ to: string; perms: string[] }> = [
  { to: '/dashboard', perms: ['analytics.read'] },
  { to: '/reception', perms: ['orders.create'] },
  { to: '/worklists', perms: ['results.enter'] },
  { to: '/validation', perms: ['results.validate'] },
  { to: '/finance', perms: ['finance.cash', 'finance.payment'] },
  { to: '/patients', perms: ['patients.read'] },
];

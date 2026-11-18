import type { ComponentType } from 'react';
import { createBrowserRouter, createHashRouter, Outlet } from 'react-router';
import { HASH_ROUTER } from '@/lib/mode';
import { AppShell, RequireAuth, RequirePerm } from '@/components/layout/AppShell';
import { HomeRedirect, NotFoundPage, RouteError } from '@/features/system/SystemPages';

type PageModule = { default: ComponentType };

/** Lazy page, optionally guarded by permissions (any of). */
function page(loader: () => Promise<PageModule>, perms?: string[]) {
  return async () => {
    const Page = (await loader()).default;
    if (!perms) return { Component: Page };
    return {
      Component: () => (
        <RequirePerm perms={perms}>
          <Page />
        </RequirePerm>
      ),
    };
  };
}

// The offline build opens from a file, where only hash routes (…/index.html#/orders) work.
export const router = (HASH_ROUTER ? createHashRouter : createBrowserRouter)([
  { path: '/login', lazy: page(() => import('@/features/auth/LoginPage')) },
  // Public pages for patients and anyone checking a printed report.
  { path: '/r', lazy: page(() => import('@/features/bench/public/PortalPage')) },
  { path: '/r/:token', lazy: page(() => import('@/features/bench/public/PortalPage')) },
  { path: '/verify', lazy: page(() => import('@/features/bench/public/VerifyPage')) },
  { path: '/verify/:code', lazy: page(() => import('@/features/bench/public/VerifyPage')) },
  {
    path: '/print',
    element: (
      <RequireAuth>
        <Outlet />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      { path: 'report/:orderId', lazy: page(() => import('@/features/bench/print/ReportPrint'), ['reports.print', 'results.read']) },
      { path: 'labels/:orderId', lazy: page(() => import('@/features/frontdesk/print/LabelsPrint'), ['samples.collect', 'orders.read']) },
      { path: 'receipt/:orderId', lazy: page(() => import('@/features/frontdesk/print/ReceiptPrint'), ['finance.read', 'orders.read']) },
    ],
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'account', lazy: page(() => import('@/features/system/AccountPage')) },
      // Front desk
      { path: 'reception', lazy: page(() => import('@/features/frontdesk/pages/ReceptionPage'), ['orders.create']) },
      { path: 'patients', lazy: page(() => import('@/features/frontdesk/pages/PatientsPage'), ['patients.read']) },
      { path: 'patients/:id', lazy: page(() => import('@/features/frontdesk/pages/PatientPage'), ['patients.read']) },
      { path: 'orders', lazy: page(() => import('@/features/frontdesk/pages/OrdersPage'), ['orders.read']) },
      { path: 'orders/:id', lazy: page(() => import('@/features/frontdesk/pages/OrderPage'), ['orders.read']) },
      // Laboratory
      { path: 'collection', lazy: page(() => import('@/features/bench/pages/CollectionPage'), ['samples.collect']) },
      { path: 'samples', lazy: page(() => import('@/features/bench/pages/SampleReceptionPage'), ['samples.receive']) },
      { path: 'worklists', lazy: page(() => import('@/features/bench/pages/WorklistPage'), ['results.enter']) },
      { path: 'validation', lazy: page(() => import('@/features/bench/pages/ValidationPage'), ['results.validate']) },
      { path: 'delivery', lazy: page(() => import('@/features/bench/pages/DeliveryPage'), ['reports.deliver']) },
      // Analyzers
      { path: 'instruments', lazy: page(() => import('@/features/instruments/pages/InstrumentsPage'), ['instruments.read']) },
      { path: 'instruments/agents', lazy: page(() => import('@/features/instruments/pages/AgentsPage'), ['instruments.manage']) },
      { path: 'instruments/:id', lazy: page(() => import('@/features/instruments/pages/InstrumentPage'), ['instruments.read']) },
      { path: 'integration/review', lazy: page(() => import('@/features/instruments/pages/ReviewQueuePage'), ['integration.review']) },
      { path: 'qc', lazy: page(() => import('@/features/instruments/pages/QcPage'), ['qc.read']) },
      // Finance
      { path: 'finance', lazy: page(() => import('@/features/admin/pages/CashierPage'), ['finance.cash', 'finance.payment']) },
      { path: 'finance/invoices', lazy: page(() => import('@/features/admin/pages/InvoicesPage'), ['finance.read']) },
      { path: 'finance/approvals', lazy: page(() => import('@/features/admin/pages/ApprovalsPage'), ['finance.approve']) },
      { path: 'finance/expenses', lazy: page(() => import('@/features/admin/pages/ExpensesPage'), ['finance.expenses']) },
      // Insights
      { path: 'dashboard', lazy: page(() => import('@/features/admin/pages/DashboardPage'), ['analytics.read']) },
      { path: 'analytics', lazy: page(() => import('@/features/admin/pages/AnalyticsPage'), ['analytics.read']) },
      // Settings
      { path: 'settings', lazy: page(() => import('@/features/admin/pages/SettingsPage'), ['settings.manage']) },
      { path: 'settings/catalog', lazy: page(() => import('@/features/admin/pages/CatalogPage'), ['catalog.manage']) },
      { path: 'settings/pricing', lazy: page(() => import('@/features/admin/pages/PricingPage'), ['pricing.manage']) },
      { path: 'settings/doctors', lazy: page(() => import('@/features/admin/pages/DoctorsPage'), ['doctors.manage']) },
      { path: 'settings/staff', lazy: page(() => import('@/features/admin/pages/StaffPage'), ['users.manage']) },
      { path: 'messages', lazy: page(() => import('@/features/admin/pages/MessagesPage'), ['settings.manage', 'reports.deliver']) },
      { path: 'audit', lazy: page(() => import('@/features/admin/pages/AuditPage'), ['audit.read']) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

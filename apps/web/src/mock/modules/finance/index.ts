/**
 * Back office (mock mode): finance, analytics and referring doctors, ports of
 * apps/api/src/modules/{finance,analytics,doctors}. Registers their routes and re-exports the
 * services the demo history calls.
 */
import { registerAnalyticsRoutes } from './reports';
import { registerDoctorRoutes } from './doctors';
import { registerFinanceRoutes } from './finance';

export {
  closeSession,
  createExpense,
  createExpenseCategory,
  currentSession,
  decideApproval,
  deleteExpense,
  deleteExpenseCategory,
  getSession,
  listApprovals,
  listExpenseCategories,
  listExpenses,
  listInvoices,
  listPayerGroups,
  listPayments,
  listSessions,
  methodTotals,
  openSession,
  refund,
  statement,
  summary,
  updateExpenseCategory,
} from './finance';
export {
  dashboard,
  instrumentsReport,
  productivityReport,
  rejectionsReport,
  resolveRange,
  revenueReport,
  shiftDay,
  tatReport,
  volumeReport,
  type Range,
} from './analytics';
export { createDoctor, deleteDoctor, listDoctors, referrals, updateDoctor } from './doctors';
export { exportReport } from './reports';
export { fillDays } from './util';

export function registerFinance(): void {
  registerFinanceRoutes();
  registerAnalyticsRoutes();
  registerDoctorRoutes();
}

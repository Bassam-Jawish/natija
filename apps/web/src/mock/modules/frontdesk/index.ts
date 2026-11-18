/**
 * Front desk (mock mode): patients and orders, ported from apps/api/src/modules/patients and
 * apps/api/src/modules/orders. Billing's routes are registered by ../shared/billing.
 * The service functions are re-exported for the demo-history seeder and the other areas.
 */
import { registerOrders } from './orders/routes';
import { registerPatients } from './patients/routes';

export function registerFrontDesk(): void {
  registerPatients();
  registerOrders();
}

export * from './patients/search';
export * from './patients/service';
export * from './orders/pricing';
export * from './orders/service';

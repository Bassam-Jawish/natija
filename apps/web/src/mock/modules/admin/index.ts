/**
 * Lab administration (mock mode): catalog, pricing, staff, settings, the audit log and outgoing
 * messages, mirroring apps/api/src/modules/{catalog,pricing,staff,settings,audit,outbox}. Doctors
 * are in the finance area. The services are exported under the server's names.
 */
import { registerAudit } from './audit';
import { registerCatalog } from './catalog';
import { registerOutbox } from './outbox';
import { registerPricing } from './pricing';
import { registerSettings } from './settings';
import { registerStaff } from './staff';

export * from './audit';
export * from './catalog';
export * from './outbox';
export * from './pricing';
export * from './settings';
export * from './staff';

export function registerAdmin(): void {
  registerCatalog();
  registerPricing();
  registerStaff();
  registerSettings();
  registerAudit();
  registerOutbox();
}

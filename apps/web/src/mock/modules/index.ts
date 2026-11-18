/** Every mock API area, registered once at start-up. Each area folder owns its routes. */
import { registerAdmin } from './admin';
import { registerAuth } from './auth';
import { registerBench } from './bench';
import { registerFinance } from './finance';
import { registerFrontDesk } from './frontdesk';
import { registerInstruments } from './instruments';
import { registerBilling } from './shared/billing';

let registered = false;

export function registerAll(): void {
  if (registered) return;
  registered = true;
  registerAuth();
  registerBilling();
  registerFrontDesk();
  registerBench();
  registerInstruments();
  registerAdmin();
  registerFinance();
}

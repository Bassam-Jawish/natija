/**
 * Simulated clock for the demo history seed. While a time is set, `new Date()` and `Date.now()`
 * return it, so the API's own services stamp every record as if the work happened at that
 * moment. Importing this module installs the clock: import it before anything else, so every
 * Date the process creates comes from it.
 */
const RealDate = Date;
let simulated: number | null = null;

const SimDate = class extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(simulated ?? RealDate.now());
    else super(...(args as [any]));
  }
} as unknown as DateConstructor;
Object.defineProperty(SimDate, 'now', { value: () => simulated ?? RealDate.now() });
globalThis.Date = SimDate;

export function setSimTime(at: number): void {
  simulated = at;
}

export function clearSimTime(): void {
  simulated = null;
}

/** The wall clock, whatever the simulated time is. */
export function realNow(): number {
  return RealDate.now();
}

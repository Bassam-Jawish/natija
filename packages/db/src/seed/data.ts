/**
 * Seed data that also runs in the browser (the web app's mock mode): the catalog, the three
 * fictional labs, the patient and lab-value generator, and the per-lab seeder. In the browser
 * build, password hashing in seed-lab.ts is swapped for a stub (the mock accepts any password).
 */
export * from './catalog-data';
export * from './labs-data';
export * from './demo-data';
export { seedLab, INSTRUMENT_CODES, type LabSeed } from './seed-lab';

/**
 * Bench (mock mode): samples, worklists, results, reports and the public report pages, ported
 * from apps/api/src/modules/{samples,worklists,results,reports,public}. The service functions
 * keep the server's names, parameters and return shapes (synchronous here) and are exported for
 * the demo-history seeder.
 */
import { registerPublic } from './public';
import { registerReports } from './reports';
import { registerResults } from './results';
import { registerSamples } from './samples';
import { registerWorklists } from './worklists';

export {
  collectionQueue,
  collectSamples,
  disposeSample,
  getBenchMeta,
  getSample,
  getSampleByBarcode,
  getSampleEvents,
  listSamples,
  receiveSamples,
  rejectSample,
  storeSample,
  transferSample,
  type MoveOptions,
  type SampleListParams,
} from './samples';
export { departmentScope, getWorklist, type WorklistParams } from './worklists';
export {
  amendResult,
  checkSignature,
  enterResult,
  enterResults,
  getOrderResults,
  getResultHistory,
  getValidationQueue,
  normalizeManualValue,
  recordCriticalCall,
  rerunResult,
  validateResults,
  verifyResults,
  type ActionOptions,
  type Scope,
} from './results';
export {
  buildReportSnapshot,
  canonicalJson,
  createReportLink,
  createReportVersion,
  deliverReport,
  getOrderReports,
  getReport,
  latestReleasedReport,
  listDeliveries,
  markDeliveredIfComplete,
  releaseReport,
  reportContentHash,
  whatsappDigits,
  type ReleaseOptions,
} from './reports';
export { branding, labBranding, lookupReport, openReportByToken, reportInfo, verifyReport } from './public';

/** Bench: samples, worklists, results, reports, public report pages (mock mode). */
export function registerBench(): void {
  registerSamples();
  registerWorklists();
  registerResults();
  registerReports();
  registerPublic();
}

/**
 * Analyzers in mock mode: instruments, code maps, the simulator, received messages, the review
 * queue, Lab Agents, QC and maintenance (ports of apps/api/src/modules/{instruments,agents,
 * integration,qc}, services/ingest.ts and the worklist of agent-api). The Lab Agent's own device
 * API (agent-api/routes.ts) is not ported: no Lab Agent exists in mock mode.
 */
import { registerAgentRoutes } from './agents';
import { registerIntegrationRoutes } from './integration';
import { registerQcRoutes } from './qc';
import { registerInstrumentRoutes } from './routes';

export function registerInstruments(): void {
  registerInstrumentRoutes();
  registerAgentRoutes();
  registerIntegrationRoutes();
  registerQcRoutes();
}

export { ensureVirtualAgent, simulateOnInstrument, VIRTUAL_AGENT_NAME } from './simulate';
export { ingestMessage, logIntegrationEvent, convertValue, unitMismatch, markTubeInAnalysis, iso, type IngestInput } from './ingest';
export { recordQcRun, type QcMaterialRow, type QcRunRow } from './qc-runs';
export { pendingWork, testCodes, type PendingTube } from './worklist';
export { listInstruments, listEvents, profileSummary, agentRef, AGENT_ONLINE_MS } from './serialize';
export { markSilentInstrumentsOffline, OFFLINE_AFTER_MS } from './offline';

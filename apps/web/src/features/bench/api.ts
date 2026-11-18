/** Typed calls for the laboratory pages. Query keys start with the live-event prefixes. */
import { useQuery } from '@tanstack/react-query';
import type {
  BenchCollectResult,
  BenchCriticalCall,
  BenchDeliverResult,
  BenchDeliveryChannel,
  BenchDeliveryRow,
  BenchMeta,
  BenchOrderReports,
  BenchOrderResults,
  BenchReceiveResult,
  BenchRejectResult,
  BenchReportLink,
  BenchReportVersion,
  BenchResult,
  BenchResultHistory,
  BenchSample,
  BenchSampleListQuery,
  BenchVerifyResult,
  CollectionQueue,
  PublicLabBranding,
  PublicReport,
  PublicReportInfo,
  PublicVerifyResult,
  ValidationQueueRow,
  Worklist,
  WorklistQuery,
} from '@natija/contracts';
import { api } from '@/lib/api';

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export const benchKeys = {
  meta: ['samples-meta'] as const,
  samples: (q: Query) => ['samples', 'list', q] as const,
  queue: (q: Query) => ['samples', 'collection', q] as const,
  orderSamples: (orderId: string) => ['samples', 'order', orderId] as const,
  worklist: (q: Query) => ['worklists', q] as const,
  validationQueue: (q: Query) => ['validation', 'queue', q] as const,
  orderResults: (orderId: string) => ['results', 'order', orderId] as const,
  history: (resultId: string) => ['results', 'history', resultId] as const,
  orderReports: (orderId: string, version?: number) => ['reports', 'order', orderId, version ?? 'latest'] as const,
  deliveries: (q: Query) => ['reports', 'deliveries', q] as const,
};

/** Departments, containers, rejection reasons, instruments and the bench settings. */
export function useBenchMeta() {
  return useQuery({ queryKey: benchKeys.meta, queryFn: () => api.get<BenchMeta>('/samples/meta'), staleTime: 5 * 60_000 });
}

export const benchApi = {
  samples: (q: BenchSampleListQuery) => api.get<{ items: BenchSample[]; total: number }>('/samples', q as Query),
  collectionQueue: (q: Query) => api.get<CollectionQueue>('/samples', { ...q, view: 'collection' }),
  orderSamples: (orderId: string) => api.get<{ items: BenchSample[]; total: number }>('/samples', { orderId, events: true, limit: 100 }),
  collect: (body: { sampleIds?: string[]; barcodes?: string[] }) => api.post<BenchCollectResult>('/samples/collect', body),
  receive: (barcodes: string[]) => api.post<BenchReceiveResult>('/samples/receive', { barcodes }),
  reject: (id: string, body: { reasonId: string; note?: string | null; recollect: boolean }) => api.post<BenchRejectResult>(`/samples/${id}/reject`, body),
  transfer: (id: string, body: { toLocation: string; note?: string | null }) => api.post<BenchSample>(`/samples/${id}/transfer`, body),
  store: (id: string, body: { location: string; note?: string | null }) => api.post<BenchSample>(`/samples/${id}/store`, body),
  dispose: (id: string, body: { note?: string | null } = {}) => api.post<BenchSample>(`/samples/${id}/dispose`, body),

  worklist: (q: WorklistQuery) => api.get<Worklist>('/worklists', q as Query),
  saveResults: (entries: Array<{ resultId: string; value?: string | null; comment?: string | null }>) =>
    api.post<{ items: BenchResult[] }>('/results/batch', { entries }),
  setComment: (resultId: string, comment: string | null) => api.put<BenchResult>(`/results/${resultId}`, { comment }),
  verify: (resultIds: string[]) => api.post<BenchVerifyResult>('/results/verify', { resultIds }),
  validate: (resultIds: string[], password: string) => api.post<BenchVerifyResult>('/results/validate', { resultIds, password }),
  rerun: (resultId: string, reason: string) => api.post<BenchResult>(`/results/${resultId}/rerun`, { reason }),
  criticalCall: (resultId: string, body: { recipientName: string; recipientRole: string; phone?: string | null; readBack: boolean; note?: string | null }) =>
    api.post<BenchCriticalCall>(`/results/${resultId}/critical-call`, body),
  amend: (resultId: string, body: { value: string; reason: string; password: string }) =>
    api.post<{ result: BenchResult; report: BenchReportVersion }>(`/results/${resultId}/amend`, body),
  history: (resultId: string) => api.get<BenchResultHistory>(`/results/${resultId}/history`),
  validationQueue: (q: Query) => api.get<{ items: ValidationQueueRow[] }>('/results/validation-queue', q),
  orderResults: (orderId: string) => api.get<BenchOrderResults>(`/results/orders/${orderId}`),

  orderReports: (orderId: string, version?: number) => api.get<BenchOrderReports>(`/reports/orders/${orderId}`, { version }),
  release: (orderId: string, resultIds?: string[]) => api.post<BenchReportVersion>(`/reports/orders/${orderId}/release`, resultIds ? { resultIds } : {}),
  link: (orderId: string) => api.post<BenchReportLink>(`/reports/orders/${orderId}/link`),
  deliver: (orderId: string, channel: BenchDeliveryChannel, to?: string | null) => api.post<BenchDeliverResult>(`/reports/orders/${orderId}/deliver`, { channel, to }),
  deliveries: (q: Query) => api.get<{ items: BenchDeliveryRow[]; total: number }>('/reports/deliveries', q),

  publicInfo: (token: string) => api.post<PublicReportInfo>('/public/report/info', { token }),
  publicOpen: (token: string, code: string) => api.post<PublicReport>('/public/report/open', { token, code }),
  publicLookup: (labCode: string, accession: string, code: string) => api.post<PublicReport>('/public/report/lookup', { labCode, accession, code }),
  publicLab: (code: string) => api.get<PublicLabBranding>(`/public/labs/${encodeURIComponent(code)}`),
  publicVerify: (code: string) => api.get<PublicVerifyResult>(`/public/verify/${encodeURIComponent(code)}`),
};

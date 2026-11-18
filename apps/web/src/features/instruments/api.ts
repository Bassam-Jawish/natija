/** Typed calls for the analyzer pages. Query keys start with the live-event prefixes (instruments, integration, qc). */
import { useQuery } from '@tanstack/react-query';
import type {
  AgentCreated,
  AgentItem,
  InstrumentDetail,
  InstrumentFormData,
  InstrumentListItem,
  InstrumentMappingItem,
  InstrumentProfileSummary,
  InstrumentUpdateBody,
  IntegrationEventItem,
  IntegrationMessageDetail,
  IntegrationMessageItem,
  IntegrationOverview,
  MaintenanceItem,
  MappingBody,
  MappingUpdateBody,
  Page,
  QcChart,
  QcMaterialItem,
  QcRunItem,
  ReviewDetail,
  ReviewItem,
  SimulateBody,
  SimulateResponse,
} from '@natija/contracts';
import { api } from '@/lib/api';

export type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export const keys = {
  list: ['instruments', 'list'] as const,
  profiles: ['instruments', 'profiles'] as const,
  formData: ['instruments', 'form-data'] as const,
  detail: (id: string) => ['instruments', 'detail', id] as const,
  mappings: (id: string) => ['instruments', 'mappings', id] as const,
  messages: (id: string, q: Query) => ['instruments', 'messages', id, q] as const,
  message: (messageId: string) => ['instruments', 'message', messageId] as const,
  events: (id: string, q: Query) => ['instruments', 'events', id, q] as const,
  agents: ['instruments', 'agents'] as const,
  overview: ['integration', 'overview'] as const,
  review: (q: Query) => ['integration', 'review', q] as const,
  reviewItem: (id: string) => ['integration', 'review-item', id] as const,
  qcMaterials: (q: Query) => ['qc', 'materials', q] as const,
  qcChart: (id: string, q: Query) => ['qc', 'chart', id, q] as const,
  qcRuns: (q: Query) => ['qc', 'runs', q] as const,
  maintenance: (q: Query) => ['qc', 'maintenance', q] as const,
};

export type MaterialBody = {
  instrumentId?: string | null;
  analyteId: string;
  name: string;
  lot: string;
  level: string;
  targetMean: number;
  targetSd: number;
  unit?: string | null;
  expiresOn?: string | null;
  isActive?: boolean;
};

export type MaintenanceBody = {
  instrumentId: string;
  kind: MaintenanceItem['kind'];
  performedAt?: string;
  nextDueAt?: string | null;
  description?: string;
  outcome: MaintenanceItem['outcome'];
};

export type AssignBody = { resultId: string; value?: string; note?: string; rememberMapping?: boolean };

export const ins = {
  list: () => api.get<InstrumentListItem[]>('/instruments'),
  profiles: () => api.get<InstrumentProfileSummary[]>('/instruments/profiles'),
  formData: () => api.get<InstrumentFormData>('/instruments/form-data'),
  detail: (id: string) => api.get<InstrumentDetail>(`/instruments/${id}`),
  update: (id: string, body: InstrumentUpdateBody) => api.patch<InstrumentDetail>(`/instruments/${id}`, body),

  mappings: (id: string) => api.get<InstrumentMappingItem[]>(`/instruments/${id}/mappings`),
  addMapping: (id: string, body: MappingBody) => api.post<InstrumentMappingItem>(`/instruments/${id}/mappings`, body),
  updateMapping: (id: string, mappingId: string, body: MappingUpdateBody) => api.patch<InstrumentMappingItem>(`/instruments/${id}/mappings/${mappingId}`, body),
  deleteMapping: (id: string, mappingId: string) => api.del<{ ok: true }>(`/instruments/${id}/mappings/${mappingId}`),
  restoreDefaults: (id: string) => api.post<{ created: number }>(`/instruments/${id}/mappings/defaults`),

  messages: (id: string, q: Query) => api.get<Page<IntegrationMessageItem>>(`/instruments/${id}/messages`, q),
  message: (messageId: string) => api.get<IntegrationMessageDetail>(`/instruments/messages/${messageId}`),
  events: (id: string, q: Query) => api.get<Page<IntegrationEventItem>>(`/instruments/${id}/events`, q),
  simulate: (id: string, body: Partial<SimulateBody>) => api.post<SimulateResponse>(`/instruments/${id}/simulate`, body),

  agents: () => api.get<AgentItem[]>('/agents'),
  createAgent: (name: string) => api.post<AgentCreated>('/agents', { name }),
  renameAgent: (id: string, name: string) => api.patch<AgentItem>(`/agents/${id}`, { name }),
  newCode: (id: string) => api.post<AgentCreated>(`/agents/${id}/enrollment-code`),
  revokeAgent: (id: string) => api.post<AgentItem>(`/agents/${id}/revoke`),

  overview: () => api.get<IntegrationOverview>('/integration/overview'),
  review: (q: Query) => api.get<Page<ReviewItem>>('/integration/review', q),
  reviewItem: (id: string) => api.get<ReviewDetail>(`/integration/review/${id}`),
  assign: (id: string, body: AssignBody) =>
    api.post<{ ok: true; resultId: string; orderId: string; value: string; flag: string | null; isCritical: boolean }>(`/integration/review/${id}/assign`, body),
  dismiss: (id: string, note: string) => api.post<ReviewItem>(`/integration/review/${id}/dismiss`, { note }),

  qcMaterials: (q: Query) => api.get<QcMaterialItem[]>('/qc/materials', q),
  createMaterial: (body: MaterialBody) => api.post<QcMaterialItem>('/qc/materials', body),
  updateMaterial: (id: string, body: Partial<MaterialBody>) => api.patch<QcMaterialItem>(`/qc/materials/${id}`, body),
  chart: (id: string, q: Query) => api.get<QcChart>(`/qc/materials/${id}/chart`, q),
  runs: (q: Query) => api.get<Page<QcRunItem>>('/qc/runs', q),
  addRun: (body: { materialId: string; value: number; note?: string }) => api.post<QcRunItem>('/qc/runs', body),
  maintenance: (q: Query) => api.get<Page<MaintenanceItem>>('/qc/maintenance', q),
  addMaintenance: (body: MaintenanceBody) => api.post<MaintenanceItem>('/qc/maintenance', body),
};

export function useProfiles() {
  return useQuery({ queryKey: keys.profiles, queryFn: ins.profiles, staleTime: 30 * 60_000 });
}

export function useFormData() {
  return useQuery({ queryKey: keys.formData, queryFn: ins.formData, staleTime: 5 * 60_000 });
}

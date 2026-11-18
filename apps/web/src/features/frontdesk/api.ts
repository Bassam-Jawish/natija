/**
 * Front desk API: typed calls and query hooks. Query keys start with the live-event prefixes
 * (['orders', …], ['patients', …]) so server events refresh them; the reception form data and
 * live quotes use ['frontdesk', …] so busy days don't refetch them on every order event.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivityEntry,
  AttachmentKind,
  AttachmentRow,
  CancelResult,
  DiscountResult,
  DuplicateCandidate,
  DuplicateCheckInput,
  InvoiceDetail,
  ItemsChanged,
  MergeInput,
  MergeResult,
  OrderCreated,
  OrderCreateInput,
  OrderDetail,
  OrderFormData,
  OrderItemInput,
  OrderLabels,
  OrderListItem,
  OrderQuote,
  OrderQuoteInput,
  OrderReceipt,
  OrderUpdateInput,
  Page,
  PatientCreateInput,
  PatientDetail,
  PatientHistory,
  PatientListItem,
  PatientUpdateInput,
  PaymentInput,
  PaymentResult,
} from '@natija/contracts';
import { api, withQuery } from '@/lib/api';

type Query = Record<string, string | number | boolean | null | undefined>;

export const fd = {
  formData: () => api.get<OrderFormData>('/orders/form-data'),
  quote: (body: OrderQuoteInput) => api.post<OrderQuote>('/orders/quote', body),
  createOrder: (body: OrderCreateInput) => api.post<OrderCreated>('/orders', body),
  orders: (q: Query) => api.get<Page<OrderListItem>>('/orders', q),
  order: (id: string) => api.get<OrderDetail>(`/orders/${id}`),
  updateOrder: (id: string, body: OrderUpdateInput) => api.put<OrderDetail>(`/orders/${id}`, body),
  addItems: (id: string, items: OrderItemInput[]) => api.post<ItemsChanged>(`/orders/${id}/items`, { items }),
  removeItem: (id: string, itemId: string, reason: string) => api.del<ItemsChanged>(withQuery(`/orders/${id}/items/${itemId}`, { reason })),
  cancelOrder: (id: string, reason: string) => api.post<CancelResult>(`/orders/${id}/cancel`, { reason }),
  labels: (id: string) => api.get<OrderLabels>(`/orders/${id}/labels`),
  labelsPrinted: (id: string, sampleIds?: string[]) => api.post<{ printed: number }>(`/orders/${id}/labels/printed`, { sampleIds }),
  receipt: (id: string) => api.get<OrderReceipt>(`/orders/${id}/receipt`),
  activity: (id: string) => api.get<{ items: ActivityEntry[] }>(`/orders/${id}/activity`),

  patients: (q: Query) => api.get<Page<PatientListItem>>('/patients', q),
  patient: (id: string) => api.get<PatientDetail>(`/patients/${id}`),
  createPatient: (body: PatientCreateInput) => api.post<PatientDetail>('/patients', body),
  updatePatient: (id: string, body: PatientUpdateInput) => api.put<PatientDetail>(`/patients/${id}`, body),
  duplicates: (body: DuplicateCheckInput) => api.post<{ items: DuplicateCandidate[] }>('/patients/duplicates', body),
  merge: (body: MergeInput) => api.post<MergeResult>('/patients/merge', body),
  history: (id: string) => api.get<PatientHistory>(`/patients/${id}/history`),
  attachments: (id: string) => api.get<{ items: AttachmentRow[] }>(`/patients/${id}/attachments`),
  upload: (id: string, file: File, kind: AttachmentKind) => {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    return api.upload<AttachmentRow>(withQuery(`/patients/${id}/attachments`, { kind }), form);
  },
  deleteAttachment: (id: string, attachmentId: string) => api.del<{ ok: true }>(`/patients/${id}/attachments/${attachmentId}`),
  attachmentUrl: (id: string, attachmentId: string, download = false) => api.url(`/patients/${id}/attachments/${attachmentId}`, download ? { download: 1 } : undefined),

  invoice: (id: string) => api.get<InvoiceDetail>(`/billing/invoices/${id}`),
  pay: (body: PaymentInput) => api.post<PaymentResult>('/billing/payments', body),
  discount: (invoiceId: string, body: { amount?: number; percent?: number; reason: string }) => api.post<DiscountResult>(`/billing/invoices/${invoiceId}/discount`, body),
  myCashSession: () => api.get<{ cashSession: { id: string; openedAt: string } | null }>('/billing/cash-session'),
  /** Opening and closing cash sessions belongs to the finance module. */
  openCashSession: (openingFloat: number) => api.post<unknown>('/finance/cash-sessions', { openingFloat }),
};

export const keys = {
  formData: ['frontdesk', 'form-data'] as const,
  quote: (body: unknown) => ['frontdesk', 'quote', body] as const,
  duplicates: (body: unknown) => ['frontdesk', 'duplicates', body] as const,
  orders: (q: unknown) => ['orders', 'list', q] as const,
  order: (id: string) => ['orders', 'detail', id] as const,
  activity: (id: string) => ['orders', 'activity', id] as const,
  labels: (id: string) => ['orders', 'labels', id] as const,
  receipt: (id: string) => ['orders', 'receipt', id] as const,
  patients: (q: unknown) => ['patients', 'list', q] as const,
  patient: (id: string) => ['patients', 'detail', id] as const,
  history: (id: string) => ['patients', 'history', id] as const,
  attachments: (id: string) => ['patients', 'attachments', id] as const,
};

export function useFormData() {
  return useQuery({ queryKey: keys.formData, queryFn: fd.formData, staleTime: 5 * 60_000 });
}

export function useQuote(body: OrderQuoteInput | null) {
  return useQuery({
    queryKey: keys.quote(body),
    queryFn: () => fd.quote(body!),
    enabled: !!body && body.items.length > 0 && !!body.payerGroupId,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** The user's open cash session; under ['finance'] so finance events (session opened or closed) refresh it. */
export function useMyCashSession(enabled = true) {
  return useQuery({ queryKey: ['finance', 'my-cash-session'], queryFn: fd.myCashSession, enabled, staleTime: 30_000 });
}

export function useOrder(id: string | undefined) {
  return useQuery({ queryKey: keys.order(id ?? ''), queryFn: () => fd.order(id!), enabled: !!id });
}

export function usePatient(id: string | undefined) {
  return useQuery({ queryKey: keys.patient(id ?? ''), queryFn: () => fd.patient(id!), enabled: !!id });
}

/** After a change to an order or a patient: refresh everything that may show it. */
export function useRefresh() {
  const qc = useQueryClient();
  return {
    orders: () => qc.invalidateQueries({ queryKey: ['orders'] }),
    patients: () => qc.invalidateQueries({ queryKey: ['patients'] }),
    formData: () => qc.invalidateQueries({ queryKey: keys.formData }),
    finance: () => qc.invalidateQueries({ queryKey: ['finance'] }),
  };
}

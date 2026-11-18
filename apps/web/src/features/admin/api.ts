/**
 * Typed calls for the administration area. Query keys start with the area prefix so live
 * events refresh them: ['finance', …] and ['dashboard', …] refresh on money and lab events,
 * ['outbox', …] on outbox changes; the other admin keys start with ['admin', …].
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  CatalogLookups,
  CatalogPackage,
  CatalogTest,
  PricingPayerGroup,
  SettingsBranch,
  SettingsPaymentMethod,
  StaffPermissionGroup,
  StaffRole,
  StaffUser,
} from '@natija/contracts';
import { api } from '@/lib/api';

export const adminKeys = {
  lookups: ['admin', 'catalog', 'lookups'] as const,
  tests: (q?: object) => ['admin', 'catalog', 'tests', q ?? {}] as const,
  test: (id: string) => ['admin', 'catalog', 'test', id] as const,
  analytes: (q?: object) => ['admin', 'catalog', 'analytes', q ?? {}] as const,
  analyte: (id: string) => ['admin', 'catalog', 'analyte', id] as const,
  packages: ['admin', 'catalog', 'packages'] as const,
  payers: ['admin', 'pricing', 'payers'] as const,
  priceList: (q?: object) => ['admin', 'pricing', 'price-list', q ?? {}] as const,
  overrides: (payerGroupId?: string) => ['admin', 'pricing', 'overrides', payerGroupId ?? 'all'] as const,
  doctors: (q?: object) => ['admin', 'doctors', q ?? {}] as const,
  referrals: (q?: object) => ['admin', 'doctors', 'referrals', q ?? {}] as const,
  users: ['admin', 'staff', 'users'] as const,
  roles: ['admin', 'staff', 'roles'] as const,
  permissions: ['admin', 'staff', 'permissions'] as const,
  lab: ['admin', 'settings', 'lab'] as const,
  methods: ['admin', 'settings', 'methods'] as const,
  branches: ['admin', 'settings', 'branches'] as const,
  audit: (q?: object) => ['admin', 'audit', q ?? {}] as const,
  auditFacets: ['admin', 'audit', 'facets'] as const,
  analytics: (report: string, q?: object) => ['admin', 'analytics', report, q ?? {}] as const,
};

/** Live-refreshed keys (see lib/live.tsx). */
export const financeKeys = {
  all: ['finance'] as const,
  session: ['finance', 'session'] as const,
  sessions: (q?: object) => ['finance', 'sessions', q ?? {}] as const,
  payments: (q?: object) => ['finance', 'payments', q ?? {}] as const,
  invoices: (q?: object) => ['finance', 'invoices', q ?? {}] as const,
  invoice: (id: string) => ['finance', 'invoice', id] as const,
  statement: (q?: object) => ['finance', 'statement', q ?? {}] as const,
  approvals: (q?: object) => ['finance', 'approvals', q ?? {}] as const,
  expenses: (q?: object) => ['finance', 'expenses', q ?? {}] as const,
  categories: ['finance', 'expense-categories'] as const,
  summary: (q?: object) => ['finance', 'summary', q ?? {}] as const,
};

export const dashboardKey = (q: object) => ['dashboard', 'admin', q] as const;
export const outboxKey = (q: object) => ['outbox', 'list', q] as const;

const LONG = 5 * 60_000;

export function useLookups() {
  return useQuery({ queryKey: adminKeys.lookups, queryFn: () => api.get<CatalogLookups>('/catalog/lookups'), staleTime: LONG });
}

export function useCatalogTests(query: { q?: string; departmentId?: string; active?: string } = {}) {
  return useQuery({
    queryKey: adminKeys.tests(query),
    queryFn: () => api.get<CatalogTest[]>('/catalog/tests', query),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function usePackages() {
  return useQuery({ queryKey: adminKeys.packages, queryFn: () => api.get<CatalogPackage[]>('/catalog/packages'), staleTime: 60_000 });
}

export function usePayerGroups() {
  return useQuery({ queryKey: adminKeys.payers, queryFn: () => api.get<PricingPayerGroup[]>('/pricing/payer-groups'), staleTime: LONG });
}

export function usePaymentMethods() {
  return useQuery({ queryKey: adminKeys.methods, queryFn: () => api.get<SettingsPaymentMethod[]>('/settings/payment-methods'), staleTime: LONG });
}

export function useBranches() {
  return useQuery({ queryKey: adminKeys.branches, queryFn: () => api.get<SettingsBranch[]>('/settings/branches'), staleTime: LONG });
}

export function useStaffUsers(enabled = true) {
  return useQuery({ queryKey: adminKeys.users, queryFn: () => api.get<StaffUser[]>('/staff/users'), enabled });
}

export function useRoles(enabled = true) {
  return useQuery({ queryKey: adminKeys.roles, queryFn: () => api.get<StaffRole[]>('/staff/roles'), enabled });
}

export function usePermissionGroups(enabled = true) {
  return useQuery({ queryKey: adminKeys.permissions, queryFn: () => api.get<StaffPermissionGroup[]>('/staff/permissions'), staleTime: LONG, enabled });
}

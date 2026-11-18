import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@natija/contracts';
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from './api';
import { applyLanguage } from './i18n';

type AuthValue = {
  me: Me | null;
  loading: boolean;
  login: (labCode: string, username: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  /** True when the user holds any of the given permissions. */
  can: (...perms: string[]) => boolean;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

function applyLab(me: Me | null) {
  const root = document.documentElement;
  if (me) {
    root.style.setProperty('--c-brand', me.lab.brandColor);
    setCsrfToken(me.csrfToken);
  } else {
    root.style.removeProperty('--c-brand');
    setCsrfToken('');
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const me = query.data ?? null;

  useEffect(() => applyLab(me), [me]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['me'], null);
    });
  }, [qc]);

  const login = useCallback(
    async (labCode: string, username: string, password: string) => {
      const result = await api.post<Me>('/auth/login', { labCode, username, password });
      applyLab(result);
      if (result.user.language) applyLanguage(result.user.language);
      // Keep the ['me'] query object (its observers stay attached); drop everything cached for the previous user.
      qc.setQueryData(['me'], result);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'demo-accounts' });
      return result;
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      qc.setQueryData(['me'], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    }
  }, [qc]);

  const value = useMemo<AuthValue>(() => {
    const perms = new Set(me?.permissions ?? []);
    return {
      me,
      loading: query.isLoading,
      login,
      logout,
      can: (...wanted: string[]) => wanted.length === 0 || wanted.some((p) => perms.has(p)),
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: ['me'] });
      },
    };
  }, [me, query.isLoading, login, logout, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The signed-in user's lab. Only use inside the authenticated app shell. */
export function useLab() {
  const { me } = useAuth();
  if (!me) throw new Error('useLab outside a signed-in session');
  return me.lab;
}

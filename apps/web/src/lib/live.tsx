import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import { loadMock, MOCK } from './mode';

/**
 * Live updates over server-sent events. Known event types invalidate the matching React Query
 * keys automatically, so lists refresh by themselves. Use query keys that start with these
 * prefixes: ['orders'], ['patients'], ['samples'], ['worklists'], ['validation'], ['results'],
 * ['reports'], ['instruments'], ['integration'], ['qc'], ['finance'], ['notifications'],
 * ['outbox'], ['dashboard'].
 */
const INVALIDATE: Record<string, string[][]> = {
  notification: [['notifications']],
  'results.changed': [['orders'], ['worklists'], ['validation'], ['results'], ['dashboard']],
  'orders.changed': [['orders'], ['dashboard'], ['samples']],
  'samples.changed': [['samples'], ['orders'], ['worklists']],
  'instruments.changed': [['instruments']],
  'integration.message': [['instruments'], ['integration'], ['worklists'], ['orders'], ['qc']],
  'finance.changed': [['finance'], ['orders'], ['dashboard']],
  'outbox.changed': [['outbox']],
  'reports.changed': [['reports'], ['orders']],
  'catalog.changed': [['admin', 'catalog'], ['frontdesk'], ['worklists']],
  'pricing.changed': [['admin', 'pricing'], ['frontdesk']],
  'doctors.changed': [['admin', 'doctors'], ['frontdesk']],
  'staff.changed': [['admin', 'staff']],
  'settings.changed': [['admin', 'settings'], ['frontdesk'], ['me']],
};

type Listener = (type: string, data: unknown) => void;
type LiveValue = { connected: boolean; subscribe: (fn: Listener) => () => void };
const LiveContext = createContext<LiveValue>({ connected: false, subscribe: () => () => {} });

export function LiveProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!me) return;
    if (MOCK) {
      // Mock mode: events come straight from the in-browser API.
      let stop: (() => void) | null = null;
      let cancelled = false;
      void loadMock().then((m) => {
        if (cancelled) return;
        stop = m.subscribeMock((type, data) => {
          // Another tab saved changes: everything on screen may be stale.
          if (type === 'mock.synced') {
            void qc.invalidateQueries();
            return;
          }
          for (const key of INVALIDATE[type] ?? []) void qc.invalidateQueries({ queryKey: key });
          listeners.current.forEach((fn) => fn(type, data));
        });
        setConnected(true);
      });
      return () => {
        cancelled = true;
        stop?.();
        setConnected(false);
      };
    }
    const es = new EventSource('/api/v1/notifications/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const handle = (type: string) => (ev: MessageEvent) => {
      let data: unknown = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        /* keep empty */
      }
      for (const key of INVALIDATE[type] ?? []) void qc.invalidateQueries({ queryKey: key });
      listeners.current.forEach((fn) => fn(type, data));
    };
    const types = Object.keys(INVALIDATE);
    const handlers = types.map((t) => [t, handle(t)] as const);
    handlers.forEach(([t, h]) => es.addEventListener(t, h as EventListener));
    return () => {
      handlers.forEach(([t, h]) => es.removeEventListener(t, h as EventListener));
      es.close();
      setConnected(false);
    };
  }, [me?.user.id, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: LiveValue = {
    connected,
    subscribe: (fn) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
  };
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}

/** Run a callback for one event type, e.g. useLiveEvent('notification', (data) => …). */
export function useLiveEvent(type: string, handler: (data: unknown) => void) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((t, data) => t === type && ref.current(data)), [subscribe, type]);
}

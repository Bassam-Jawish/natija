import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { BenchResult } from '@natija/contracts';
import { ApiError } from '@/lib/api';
import { toast } from '@/components/ui';
import { benchApi } from '../api';
import { useBenchError } from './common';

export function useInvalidateBench() {
  const qc = useQueryClient();
  return useCallback(() => {
    for (const key of [['worklists'], ['results'], ['validation'], ['orders'], ['reports']]) void qc.invalidateQueries({ queryKey: key });
  }, [qc]);
}

/**
 * Typed-but-unsaved values for a result grid. Ctrl+S (or save()) sends every changed value in
 * one batch; fields the server refuses turn red with the reason. Leaving with unsaved values asks first.
 */
export function useResultEntry() {
  const { t } = useTranslation('bench');
  const errorMessage = useBenchError();
  const invalidate = useInvalidateBench();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const originals = useRef(new Map<string, string>());

  const setDraft = useCallback((r: BenchResult, value: string) => {
    if (!originals.current.has(r.id)) originals.current.set(r.id, r.value ?? '');
    setDrafts((d) => ({ ...d, [r.id]: value }));
    setFieldErrors((e) => {
      if (!e[r.id]) return e;
      const next = { ...e };
      delete next[r.id];
      return next;
    });
  }, []);

  const dirtyIds = useMemo(() => Object.keys(drafts).filter((id) => drafts[id] !== originals.current.get(id)), [drafts]);

  const mutation = useMutation({
    mutationFn: (ids: string[]) => benchApi.saveResults(ids.map((id) => ({ resultId: id, value: drafts[id]!.trim() === '' ? null : drafts[id]!.trim() }))),
    onSuccess: (res) => {
      toast.success(t('entry.saved', { count: res.items.length }));
      const critical = res.items.filter((r) => r.isCritical).length;
      if (critical) toast.warning(t('entry.criticalSaved', { count: critical }));
      setDrafts((d) => {
        const next = { ...d };
        for (const r of res.items) {
          delete next[r.id];
          originals.current.delete(r.id);
        }
        return next;
      });
      setFieldErrors({});
      invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors) {
        const map: Record<string, string> = {};
        for (const [id, codes] of Object.entries(err.errors)) map[id] = t(`errors.${codes[0]}`, { defaultValue: codes[0] });
        setFieldErrors(map);
      }
      toast.error(errorMessage(err));
    },
  });

  const save = useCallback(() => {
    if (!dirtyIds.length || mutation.isPending) return;
    mutation.mutate(dirtyIds);
  }, [dirtyIds, mutation]);

  const discard = useCallback(() => {
    setDrafts({});
    setFieldErrors({});
    originals.current.clear();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  useEffect(() => {
    if (!dirtyIds.length) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirtyIds.length]);

  return { drafts, fieldErrors, setDraft, dirtyCount: dirtyIds.length, save, saving: mutation.isPending, discard };
}

/** Technical verification of the given results, with a toast for what was skipped. */
export function useVerify(onDone?: () => void) {
  const { t } = useTranslation('bench');
  const errorMessage = useBenchError();
  const invalidate = useInvalidateBench();
  return useMutation({
    mutationFn: (ids: string[]) => benchApi.verify(ids),
    onSuccess: (res) => {
      if (res.done.length) toast.success(t('entry.verified', { count: res.done.length }));
      if (res.skipped.length) toast.info(t('entry.verifySkipped', { count: res.skipped.length }));
      invalidate();
      onDone?.();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

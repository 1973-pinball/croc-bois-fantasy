'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DRAFT_REFRESH_INTERVAL_MS, draftBoardSchema, type DraftBoard } from '@/lib/draft-board';

/** The private advisor follows the same authoritative picks as the public room. */
export function useAdvisorBoard(seasonId: string, enabled: boolean) {
  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const previousSeason = useRef(seasonId);
  const accept = useCallback((next: DraftBoard) => {
    setBoard(previous => !previous || previous.seasonId !== next.seasonId || next.revision > previous.revision ? next : previous);
    setCheckedAt(new Date().toISOString());
    setError('');
  }, []);
  const refresh = useCallback(async (background = false) => {
    if (!enabled || request.current) return;
    const controller = new AbortController();
    const current = generation.current;
    request.current = controller;
    if (!background) setRefreshing(true);
    try {
      const response = await fetch(`/api/draft-board?seasonId=${encodeURIComponent(seasonId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'The draft board could not be refreshed.');
      const next = draftBoardSchema.parse(body.board);
      if (next.seasonId !== seasonId) throw new Error('The draft response belongs to another season.');
      if (!controller.signal.aborted && current === generation.current) accept(next);
    } catch (failure) {
      if (!controller.signal.aborted && current === generation.current) setError(failure instanceof Error ? failure.message : 'The draft board could not be refreshed.');
    } finally {
      if (request.current === controller) request.current = null;
      if (!background && current === generation.current) setRefreshing(false);
    }
  }, [accept, enabled, seasonId]);
  useEffect(() => {
    generation.current++;
    setRefreshing(false);
    if (previousSeason.current !== seasonId) {
      setBoard(null); setError(''); setCheckedAt(null); previousSeason.current = seasonId;
    }
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh(true); };
    visibleRefresh();
    const timer = window.setInterval(visibleRefresh, DRAFT_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => {
      generation.current++;
      request.current?.abort(); request.current = null;
      window.clearInterval(timer);
      window.removeEventListener('focus', visibleRefresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
    };
  }, [refresh]);
  return { board, error, checkedAt, refreshing, refresh, accept };
}

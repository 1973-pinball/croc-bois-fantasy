'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DraftAdvisorReport } from '@/lib/draft-advisor';
import type { DraftForecastReport } from '@/lib/draft-forecast';
import { draftForecastRequestKey, type DraftForecastMode, type DraftForecastRequestInput, type DraftForecastWorkerRequest, type DraftForecastWorkerResponse } from '@/lib/draft-forecast-request';

type State = {
  requestKey: string; resultKey: string; resultMode: DraftForecastMode; report: DraftAdvisorReport | DraftForecastReport | null;
  busy: boolean; error: string; progress: { completed: number; total: number } | null;
};

/** Private projections stay in this browser; terminating the worker cancels obsolete calculations. */
export function useDraftForecast(input: DraftForecastRequestInput | null, mode: DraftForecastMode) {
  const key = useMemo(() => input ? draftForecastRequestKey(input, mode) : '', [input, mode]);
  const latestInput = useRef(input);
  latestInput.current = input;
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ requestKey: '', resultKey: '', resultMode: mode, report: null, busy: false, error: '', progress: null });
  useEffect(() => {
    const requestInput = latestInput.current;
    if (!key || !requestInput) return;
    const id = ++generation.current;
    let worker: Worker | null = null;
    let active = true;
    setState(previous => ({ ...previous, requestKey: key, busy: true, error: '', progress: null }));
    const fail = (message: string) => {
      if (active && generation.current === id) setState(previous => ({ ...previous, requestKey: key, busy: false, error: message, progress: null }));
      worker?.terminate();
    };
    try {
      worker = new Worker(new URL('../lib/draft-forecast.worker.ts', import.meta.url), { type: 'module', name: 'Private draft forecast' });
      worker.onmessage = (event: MessageEvent<DraftForecastWorkerResponse>) => {
        if (!active || generation.current !== id || event.data.id !== id) return;
        const message = event.data;
        if (message.type === 'progress') {
          setState(previous => ({ ...previous, progress: { completed: message.completed, total: message.total } }));
        } else if (message.type === 'result') {
          setState({ requestKey: key, resultKey: key, resultMode: mode, report: message.report, busy: false, error: '', progress: null });
          worker?.terminate();
        } else fail(message.message);
      };
      worker.onerror = event => { event.preventDefault(); fail('The draft analysis could not finish. Retry when you are ready; saved projections remain available.'); };
      worker.postMessage({ id, mode, input: requestInput } satisfies DraftForecastWorkerRequest);
    } catch { fail('This browser could not start the draft analysis. Retry or reopen the app; saved projections remain available.'); }
    return () => { active = false; generation.current++; worker?.terminate(); };
  }, [key, mode, attempt]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return {
    report: state.report, resultMode: state.resultMode, retry,
    busy: Boolean(key) && (state.requestKey !== key || state.busy),
    stale: Boolean(state.report) && state.resultKey !== key,
    current: Boolean(key && state.report && state.resultKey === key && !state.busy && !state.error),
    error: state.requestKey === key ? state.error : '',
    progress: state.requestKey === key ? state.progress : null,
  };
}

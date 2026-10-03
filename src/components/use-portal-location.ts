'use client';

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { portalHref, readPortalLocation, type PortalView } from '@/lib/portal-location';

const eventName = 'croc-location-change';
function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener('hashchange', listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener('hashchange', listener);
    window.removeEventListener(eventName, listener);
  };
}
const snapshot = () => window.location.search + window.location.hash;
const InitialSearchContext = createContext('');

/** Share the request's initial URL with nested public filters during SSR/hydration. */
export function PortalSearchProvider({ initialSearch, children }: { initialSearch: string; children: ReactNode }) {
  return createElement(InitialSearchContext.Provider, { value: initialSearch }, children);
}

export function updateQuery(patch: Record<string, string | number | boolean | null>, replace = true) {
  const href = portalHref(window.location.search, patch);
  const hash = 'view' in patch ? '' : window.location.hash;
  if (href + hash === window.location.pathname + window.location.search + window.location.hash) return;
  if (replace) window.history.replaceState(window.history.state, '', href + hash);
  else {
    window.history.replaceState({ ...window.history.state, crocScroll: window.scrollY }, '');
    const changingView = 'view' in patch && patch.view !== new URLSearchParams(window.location.search).get('view');
    window.history.pushState({ ...window.history.state, crocScroll: changingView ? 0 : window.scrollY }, '', href + hash);
  }
  window.dispatchEvent(new Event(eventName));
}

export function usePortalLocation(defaultView: PortalView = 'overview', initialSearch = '') {
  const serverSnapshot = useCallback(() => initialSearch, [initialSearch]);
  const location = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [search, hash = ''] = location.split('#');
  return {
    ...readPortalLocation(search, hash ? '#' + hash : '', defaultView),
    href: (patch: Record<string, string | number | boolean | null>) => portalHref(search, patch),
    update: updateQuery,
  };
}

/** Public filter state can be bookmarked without persisting private league work. */
export function useQueryFilter(key: string, fallback: string) {
  const initialSearch = useContext(InitialSearchContext);
  const serverSnapshot = useCallback(() => initialSearch, [initialSearch]);
  const location = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const value = new URLSearchParams(location.split('#')[0]).get(key) ?? fallback;
  const set = useCallback((next: string) => updateQuery({ [key]: next === fallback ? null : next }), [key, fallback]);
  return [value, set] as const;
}

export function useViewFocus(view: PortalView) {
  const frame = useRef(0);
  const restore = useRef(false);
  const focus = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const anchor = window.location.hash && document.getElementById(window.location.hash.slice(1));
      const heading = document.querySelector<HTMLElement>('#main-content h1');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      if (anchor) anchor.scrollIntoView({ behavior: 'instant', block: 'start' });
      else window.scrollTo({ top: restore.current ? Number(window.history.state?.crocScroll) || 0 : 0, behavior: 'instant' });
      restore.current = false;
    });
  }, []);
  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    const back = () => { restore.current = true; focus(); };
    let saveFrame = 0;
    const saveScroll = () => {
      if (saveFrame) return;
      saveFrame = requestAnimationFrame(() => {
        saveFrame = 0;
        window.history.replaceState({ ...window.history.state, crocScroll: window.scrollY }, '');
      });
    };
    window.addEventListener('popstate', back);
    window.addEventListener('scroll', saveScroll, { passive: true });
    return () => { cancelAnimationFrame(frame.current); cancelAnimationFrame(saveFrame); window.removeEventListener('popstate', back); window.removeEventListener('scroll', saveScroll); window.history.scrollRestoration = previous; };
  }, [focus]);
  useEffect(() => { focus(); }, [view, focus]);
}

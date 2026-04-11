import { useEffect, useRef } from 'react';

export const MIND_STORAGE_CHANGED = 'mybrain:mind-storage-changed';

/**
 * Fire after pipeline persistence, consolidation, or other cross-page mind/memory writes.
 */
export function notifyMindStorageChanged(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(MIND_STORAGE_CHANGED, {
      detail: { ts: Date.now(), ...detail },
    })
  );
}

/**
 * Re-run `load` whenever mind storage updates (e.g. pipeline finished on another route).
 * Pass the same `load` function you use for initial fetch; keep it stable with useCallback if needed.
 */
export function useMindStorageRefresh(load) {
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const onMind = () => {
      const fn = loadRef.current;
      if (typeof fn === 'function') {
        void Promise.resolve(fn()).catch((e) => console.warn('[mindStorageRefresh]', e));
      }
    };
    window.addEventListener(MIND_STORAGE_CHANGED, onMind);
    return () => window.removeEventListener(MIND_STORAGE_CHANGED, onMind);
  }, []);
}

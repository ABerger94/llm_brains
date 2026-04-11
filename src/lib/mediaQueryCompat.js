/**
 * Older WebKit (pre–Safari 14) only supports MediaQueryList.addListener/removeListener.
 * @param {MediaQueryList} mq
 * @param {() => void} handler
 * @returns {() => void}
 */
export function subscribeMediaQueryChange(mq, handler) {
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
  mq.addListener(handler);
  return () => mq.removeListener(handler);
}

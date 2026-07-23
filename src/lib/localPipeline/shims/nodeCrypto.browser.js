/**
 * Browser replacement for `node:crypto`, aliased in only for the browser-only
 * build (see vite.config.js). server/pipeline.js's only use of node:crypto is
 * `crypto.randomUUID()`, which the Web Crypto API provides natively under the
 * same name — no polyfill logic needed, just a module that resolves.
 */
export default {
  randomUUID: () => globalThis.crypto.randomUUID(),
};

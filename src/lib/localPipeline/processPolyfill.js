/**
 * server/pipeline.js, server/mindPolicy.js, and their dependency chain read
 * `process.env.SOMETHING || default` for feature flags/tuning (see the alias
 * comment in vite.config.js) — reasonable in Node, but `process` doesn't
 * exist as a browser global at all. A single empty `env` object makes every
 * such read fall through to its default, same as an unconfigured server.
 *
 * A runtime polyfill (not a Vite `define`) so it can't collide with Vite's
 * own `process.env.NODE_ENV` replacement, which is separate and unaffected.
 * Side-effect only — must be imported before server/pipeline.js anywhere
 * this matters (see localPipelineRunner.js).
 */
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: {} };
}

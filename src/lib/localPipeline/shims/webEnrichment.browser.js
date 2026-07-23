/**
 * Browser replacement for server/webEnrichment.js, aliased in only for the
 * browser-only build (see vite.config.js). Web search enrichment needs a
 * Brave Search API key, which can't be shipped in a public browser bundle —
 * see the plan's "explicitly out of scope" section. No-op: modules that would
 * have emitted a WEB_REQUEST simply get no fulfillment, same as when
 * WEB_FETCH_DISABLED is set server-side.
 */
export async function maybeFulfillWebRequests() {
  // web enrichment disabled in browser mode
}

/**
 * Browser replacement for server/embeddingService.js, aliased in only for the
 * browser-only build (see vite.config.js). Embedding-ranked retrieval needs a
 * Hugging Face token, which can't be shipped in a public browser bundle — see
 * the plan's "explicitly out of scope" section. Returning null matches the
 * real module's own "embeddings unavailable" return value, which
 * pipeline.js/mindPolicy.js already fall back from (recency-based retrieval).
 */
export async function querySimilarities() {
  return null;
}

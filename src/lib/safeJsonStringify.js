/**
 * Pipeline POST bodies must be JSON-serializable. IndexedDB / continuation memory can occasionally
 * contain BigInt or (after failed clones) non-tree data; stringify then throws and the run dies
 * right after "Starting full-stack…" with an opaque error.
 */

export function pipelineJsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * @param {unknown} payload - object to send as POST /api/pipeline/stream body
 * @returns {string}
 */
export function safeJsonStringifyPipelineBody(payload) {
  try {
    return JSON.stringify(payload, pipelineJsonReplacer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Pipeline request could not be serialized (${msg}). Try Graph Pipeline → Reset, or shorten pinned working memory / module prompt overrides.`
    );
  }
}

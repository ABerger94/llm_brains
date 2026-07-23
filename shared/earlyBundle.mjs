/**
 * One-call early cognitive bundle (layers 1–4): output is split into per-module
 * strings that match the usual pipeline module output contracts and markers.
 */
export const EARLY_BUNDLE_MODULE_ORDER = [
  'SensorySalience',
  'ContextMemory',
  'Deliberation',
  'Beliefs',
  'SelfRelationTension',
];

const MARK = (n) => `<<<MODULE ${n}>>>`;
const END = (n) => `<<<END_MODULE ${n}>>>`;

/**
 * @param {string} [extraNote]
 * @returns {string}
 */
export function buildEarlyBundleSystemPrompt(extraNote = '') {
  return (
    'You are a single run that simulates FIVE separate cognitive modules in one response. ' +
    'For EACH module, write the body EXACTLY as that module would: same sections, same JSON tail lines, same markers, ' +
    'as the five specialists (SensorySalience, ContextMemory, Deliberation, Beliefs, SelfRelationTension) in order.\n\n' +
    '**Critical formatting rules:**\n' +
    '- For every module, wrap its full output between these exact delimiters (start line and end line only, no text outside the delimiters for that block):\n' +
    EARLY_BUNDLE_MODULE_ORDER.map((n) => `  ${MARK(n)} ...module body... ${END(n)}`)
      .join('\n') +
    '\n' +
    '- Do not omit any module. Do not use different delimiter spellings.\n' +
    '- Do not put INTEGRATION_JSON in this run (Integration is a later step).\n' +
    '- SensorySalience: SALIENT_1.. lines, A/B as in the standalone prompt; optional WEB_REQUEST at end of block only if needed.\n' +
    '- ContextMemory: end with SURPRISE_ASSESSMENT: {...} and WORKING_MEMORY_PROMOTE: {"ids":[]} lines exactly.\n' +
    '- Deliberation: end with USER_STANCE_PREDICTION: {...} and HYPOTHESES_JSON: {...} lines.\n' +
    '- Beliefs: end with BELIEF_REVISIONS: {...} and EPISTEMIC_CLAIMS: {...}.\n' +
    '- SelfRelationTension: TENSIONS section; use NONE or substantive entries.\n' +
    (String(extraNote || '').trim() ? `\n**Note:** ${String(extraNote).trim()}\n` : '') +
    '\n**Compact output:** keep each module concise; no cross-module preamble before the first ' +
    MARK('SensorySalience') +
    '.'
  );
}

const MIN_STRICT = 20;

/**
 * @param {string} text
 * @returns {Record<string, string>|null}
 */
export function splitEarlyBundleToModuleOutputs(text) {
  const raw = String(text || '');
  if (raw.length < 200) return null;
  const out = {};
  for (const name of EARLY_BUNDLE_MODULE_ORDER) {
    const a = raw.indexOf(MARK(name));
    const b = raw.indexOf(END(name));
    if (a === -1 || b === -1 || b <= a) return null;
    const start = a + MARK(name).length;
    const slice = raw.slice(start, b).trim();
    if (slice.length < (name === 'SelfRelationTension' ? 8 : MIN_STRICT)) return null;
    out[name] = slice;
  }
  return out;
}

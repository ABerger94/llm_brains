import { BeliefTension } from './data';

const MAX_INPUT_LEN = 380;
const SEP = ' · ';

function dedupeDescriptions(lines) {
  const seen = new Set();
  const out = [];
  for (const s of lines) {
    const k = s.slice(0, 200);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * @param {unknown[]} arr
 * @returns {string[]}
 */
function descriptionsFromMemoryBeliefTensions(arr) {
  if (!Array.isArray(arr) || !arr.length) return [];
  const tail = arr.slice(-12).reverse();
  return tail.map((t) => String(t?.description || '').trim()).filter(Boolean);
}

/**
 * Build scheduler payload for a belief_tension_review task: user-visible topic + short reason.
 * Prefers in-memory `sharedMemory.beliefTensions` (freshest), then active rows in IndexedDB.
 * @param {{ beliefTensions?: unknown[] } | null | undefined} sharedMemory
 * @returns {Promise<{ input_text: string, reason: string }>}
 */
export async function buildBeliefTensionReviewSchedulePayload(sharedMemory) {
  const fromMem = descriptionsFromMemoryBeliefTensions(sharedMemory?.beliefTensions);
  let lines = dedupeDescriptions(fromMem);

  if (!lines.length) {
    try {
      const rows = await BeliefTension.filter({ tension_state: 'active' }, '-created_date', 10);
      lines = dedupeDescriptions(
        rows.map((r) => String(r.description || '').trim()).filter(Boolean)
      );
    } catch {
      lines = [];
    }
  }

  const picked = lines.slice(0, 3);
  let input_text = '';
  for (const line of picked) {
    const piece = line.length > 220 ? `${line.slice(0, 219)}…` : line;
    const next = input_text ? `${input_text}${SEP}${piece}` : piece;
    if (next.length > MAX_INPUT_LEN) {
      if (!input_text) input_text = `${piece.slice(0, MAX_INPUT_LEN - 1)}…`;
      break;
    }
    input_text = next;
  }

  if (!String(input_text || '').trim()) {
    input_text = 'Belief tension review — active tensions on Belief Map.';
  }

  return {
    input_text,
    reason: 'Auto-queued after pipeline flagged belief tensions.',
  };
}

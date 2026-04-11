/**
 * Graph Pipeline transcript: show module output without mid-word breaks (word/sentence-safe chunks).
 */

const MAX_CHUNK_CHARS = 520;
/** Enough steps for long Memory / Reasoning text without folding most of it into an ellipsis tail. */
const MAX_CHUNKS = 48;
const CHUNK_DELAY_MS = 45;
/** Above this length, thoughts are shown in timed chunks so the stream advances visibly before the next module. */
const SINGLE_CHUNK_MAX_CHARS = 900;

function splitLongSentenceWords(sentence, maxLen) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const out = [];
  let buf = '';
  for (const w of words) {
    const next = buf ? `${buf} ${w}` : w;
    if (next.length <= maxLen) {
      buf = next;
    } else {
      if (buf) out.push(buf);
      buf = w.length <= maxLen ? w : w.slice(0, maxLen);
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [sentence];
}

function segmentSentences(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const out = [];
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    for (const s of seg.segment(text)) {
      const t = s.segment.trim();
      if (t) out.push(t);
    }
  } catch {
    const parts = text.split(/(?<=[.!?])\s+/);
    for (const p of parts) {
      const t = p.trim();
      if (t) out.push(t);
    }
  }
  return out.length ? out : [text];
}

export function splitModuleThoughtChunks(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.length <= SINGLE_CHUNK_MAX_CHARS) return [raw];

  const sentences = segmentSentences(raw);
  const chunks = [];
  let buf = '';

  const flushBuf = () => {
    if (buf) {
      chunks.push(buf);
      buf = '';
    }
  };

  for (const sent of sentences) {
    if (buf.length + sent.length + 1 <= MAX_CHUNK_CHARS) {
      buf = buf ? `${buf} ${sent}` : sent;
    } else {
      flushBuf();
      if (sent.length <= MAX_CHUNK_CHARS) {
        buf = sent;
      } else {
        const wparts = splitLongSentenceWords(sent, MAX_CHUNK_CHARS);
        for (let i = 0; i < wparts.length - 1; i += 1) {
          chunks.push(wparts[i]);
        }
        buf = wparts[wparts.length - 1] || '';
      }
    }
  }
  flushBuf();

  const limited = chunks.slice(0, MAX_CHUNKS);
  if (chunks.length > MAX_CHUNKS) {
    const rest = chunks.slice(MAX_CHUNKS).join(' ');
    limited[limited.length - 1] = `${limited[limited.length - 1]} …${rest}`;
  }
  return limited.length ? limited : [raw];
}

/**
 * Append thought chunks; does not append module-complete (caller uses try/finally).
 */
export async function streamModuleThoughts(text, moduleId, appendEntry, pausedRef) {
  const parts = splitModuleThoughtChunks(text);
  for (const part of parts) {
    if (pausedRef.current) return;
    appendEntry('module-thought', part, moduleId, { bypassPause: true });
    await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
  }
}

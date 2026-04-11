/**
 * Optional prior-turn dialogue prepended to pipeline user input (bounded, plain text).
 */

export function formatRecentDialogueBlock(recentDialogue) {
  if (!Array.isArray(recentDialogue) || recentDialogue.length === 0) return '';
  const lines = [];
  for (const item of recentDialogue.slice(-20)) {
    if (!item || typeof item !== 'object') continue;
    const role =
      item.role === 'assistant' ? 'Assistant' : item.role === 'user' ? 'User' : null;
    if (!role) continue;
    const content = String(item.content || '').trim().slice(0, 3500);
    if (content) lines.push(`${role}: ${content}`);
  }
  if (!lines.length) return '';
  return `RECENT_EXCHANGE (prior turns; the current user message and attachments follow after this block):\n\n${lines.join('\n\n')}`;
}

/** Must match the separator used in buildPipelineUserInput (head = prior turns, tail = current turn). */
export const COMPOSED_INPUT_TURN_SEPARATOR = '\n---\n\n';

/**
 * Pull the RECENT_EXCHANGE block from a composed pipeline input so modules can see prior dialogue
 * without hunting inside a huge originalInput string.
 * @returns {string | null} bounded plain text or null when this turn has no prior-exchange prefix
 */
export function extractRecentExchangeFromComposedInput(composedInput) {
  const s = String(composedInput || '');
  const sep = COMPOSED_INPUT_TURN_SEPARATOR;
  const idx = s.indexOf(sep);
  if (idx === -1) return null;
  const head = s.slice(0, idx).trim();
  if (!head.startsWith('RECENT_EXCHANGE')) return null;
  const max = 14_000;
  if (head.length > max) return `${head.slice(0, max)}\n[…trimmed]`;
  return head;
}

export function buildPipelineUserInput(inputText, attachmentBlock, recentDialogue) {
  const main = [String(inputText || '').trim(), attachmentBlock].filter(Boolean).join('\n\n').trim();
  const pre = formatRecentDialogueBlock(recentDialogue);
  if (!pre) return main;
  return `${pre}${COMPOSED_INPUT_TURN_SEPARATOR}${main}`;
}

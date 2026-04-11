/**
 * Dashboard “Topic” / run header: user prompt or attachment hint — not execution-log text.
 * @param {string} userInput
 * @param {unknown[]} attachments
 * @param {number} pendingFileCount
 */
export function buildGraphPipelineRunContextLabel(userInput, attachments, pendingFileCount) {
  const t = String(userInput || '').trim();
  if (t) return t;
  const att = Array.isArray(attachments) ? attachments : [];
  const pfc = Math.max(0, Number(pendingFileCount) || 0);
  const named = att.map((a) => String(a?.filename || a?.name || '').trim()).filter(Boolean);
  const total = att.length + pfc;
  if (total <= 0) return '';
  if (named.length === 1 && pfc === 0) return `Attachment: ${named[0]}`;
  if (named.length > 0) {
    const rest = named.length - 1 + pfc;
    return rest > 0 ? `${named[0]} +${rest} more` : `Attachments (${named.length})`;
  }
  return pfc > 0 ? `Pending upload: ${pfc} file(s)` : `Attachments (${total})`;
}

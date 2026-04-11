/** @param {unknown[]} rest Entries after user-input within one turn */
function findVoicePrimaryIndex(rest) {
  const voiceTypeIdx = rest.findIndex((e) => e && e.type === 'voice');
  if (voiceTypeIdx !== -1) return voiceTypeIdx;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const e = rest[i];
    if (e && e.type === 'module-thought' && e.moduleId === 'voice') return i;
  }
  return -1;
}

/**
 * Partition consciousness stream entries into flat or folded turns (pipeline hidden under details/summary UI).
 * @param {unknown[]} entries
 * @param {boolean} isProcessing
 * @returns {(
 *   | { kind: 'flat'; key: string; entries: unknown[] }
 *   | { kind: 'foldedTurn'; key: string; userEntry: unknown; pipelineEntries: unknown[]; voiceEntry: unknown }
 * )[]}
 */
export function buildConsciousnessStreamRenderPlan(entries, isProcessing) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return [];

  /** @type {{ type: 'orphan' | 'turn'; slice: unknown[] }[]} */
  const turns = [];
  let i = 0;
  while (i < list.length) {
    const start = i;
    const first = list[i];
    if (!first || first.type !== 'user-input') {
      let j = i + 1;
      while (j < list.length && list[j]?.type !== 'user-input') j += 1;
      turns.push({ type: 'orphan', slice: list.slice(start, j) });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < list.length && list[j]?.type !== 'user-input') j += 1;
    turns.push({ type: 'turn', slice: list.slice(start, j) });
    i = j;
  }

  const lastTurnIdx = turns.length - 1;
  const plan = [];

  turns.forEach((turn, turnIdx) => {
    const slice = turn.slice;
    if (turn.type === 'orphan') {
      const k = slice[0] && slice[0].id != null ? String(slice[0].id) : `orphan-${plan.length}`;
      plan.push({ kind: 'flat', key: k, entries: slice });
      return;
    }

    const userEntry = slice[0];
    const rest = slice.slice(1);
    const isLastTurn = turnIdx === lastTurnIdx;
    const runFinishedForTurn = !isLastTurn || !isProcessing;

    const voiceIdx = findVoicePrimaryIndex(rest);
    if (voiceIdx === -1 || !runFinishedForTurn) {
      plan.push({
        kind: 'flat',
        key: String(userEntry.id ?? `turn-${plan.length}`),
        entries: slice,
      });
      return;
    }

    const voiceEntry = rest[voiceIdx];
    const pipelineEntries = [...rest.slice(0, voiceIdx), ...rest.slice(voiceIdx + 1)];
    plan.push({
      kind: 'foldedTurn',
      key: String(userEntry.id ?? turnIdx),
      userEntry,
      pipelineEntries,
      voiceEntry,
    });
  });

  return plan;
}

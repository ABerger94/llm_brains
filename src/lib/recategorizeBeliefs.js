/**
 * Batch LLM pass to assign belief map categories to all BeliefStore rows.
 */

import { BELIEF_MAP_CATEGORY_ORDER, normalizeBeliefMapCategory } from '../../shared/beliefMapCategory.mjs';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { BeliefStore } from './data';
import { invokeLLM } from './llm';
import { isValidIndexedDbRecordKey } from './browserStorage';
import { notifyMindStorageChanged } from './mindStorageEvents';

const LIST_LIMIT = 400;
const BATCH_SIZE = 25;

const ASSIGN_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: {
            type: 'string',
            enum: [...BELIEF_MAP_CATEGORY_ORDER],
          },
        },
        required: ['id', 'category'],
      },
    },
  },
  required: ['assignments'],
};

const RUBRIC = `Categories (pick exactly one per belief):
- factual: states of affairs, definitions, what-is claims about the world or session.
- normative: ought/should, values, obligations, what's good or bad.
- self: identity, preferences, boundaries, capabilities of this mind or the user as modeled as a person/self.
- causal: mechanisms, because, if-then empirical links (not moral ought).
- predictive: likely futures, expectations, forecasts.`;

/**
 * @returns {Promise<{ updated: number, batches: number, message: string }>}
 */
export async function recategorizeAllBeliefsInStore() {
  const rows = await BeliefStore.list('-created_date', LIST_LIMIT);
  const targets = rows.filter((r) => isValidIndexedDbRecordKey(r.id));
  if (targets.length === 0) {
    return { updated: 0, batches: 0, message: 'No beliefs in the store.' };
  }

  let updated = 0;
  let batches = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE);
    const payload = chunk.map((b) => ({
      id: b.id,
      statement: clipTextComplete(String(b.statement || ''), 500, { ellipsis: true }),
    }));

    batches += 1;
    const result = await invokeLLM({
      prompt: `Assign each belief exactly one map category for visualization.

${RUBRIC}

Beliefs (JSON array of { id, statement }):
${JSON.stringify(payload, null, 2)}

Return assignments: one { id, category } per listed id. Use only the five category strings.`,
      response_json_schema: ASSIGN_SCHEMA,
    });

    const list = Array.isArray(result?.assignments) ? result.assignments : [];
    const idSet = new Set(chunk.map((b) => b.id));

    for (const a of list) {
      const id = String(a?.id || '').trim();
      const cat = normalizeBeliefMapCategory(a?.category);
      if (!id || !cat || !idSet.has(id)) continue;
      await BeliefStore.update(id, { category: cat });
      updated += 1;
    }
  }

  if (updated) notifyMindStorageChanged({ source: 'beliefs' });

  return {
    updated,
    batches,
    message: `Recategorized ${updated} belief(s) in ${batches} batch(es).`,
  };
}

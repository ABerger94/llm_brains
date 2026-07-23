import { GoalItem as DefaultGoalItem } from './data';

/**
 * New root goal rows: point root at self, clear parent, default depth 0.
 * @param {{ id: string } & Record<string, unknown>} record
 * @param {typeof DefaultGoalItem} [goalItemManager]
 */
export async function finalizeNewGoalRoot(record, goalItemManager = DefaultGoalItem) {
  if (!record?.id) return record;
  if (record.root_goal_id) return goalItemManager.retrieve(record.id) || record;
  await goalItemManager.update(record.id, {
    root_goal_id: record.id,
    parent_goal_id: null,
    pursuit_depth: Number.isFinite(Number(record.pursuit_depth)) ? Number(record.pursuit_depth) : 0,
  });
  return goalItemManager.retrieve(record.id) || record;
}

import { CuriosityItem as DefaultCuriosityItem } from './data';

/**
 * New root curiosity rows: point root at self, clear parent, default depth 0.
 * @param {{ id: string } & Record<string, unknown>} record
 * @param {typeof DefaultCuriosityItem} [curiosityItemManager]
 */
export async function finalizeNewCuriosityRoot(record, curiosityItemManager = DefaultCuriosityItem) {
  if (!record?.id) return record;
  if (record.root_curiosity_id) return curiosityItemManager.retrieve(record.id) || record;
  await curiosityItemManager.update(record.id, {
    root_curiosity_id: record.id,
    parent_curiosity_id: null,
    pursuit_depth: Number.isFinite(Number(record.pursuit_depth)) ? Number(record.pursuit_depth) : 0,
  });
  return curiosityItemManager.retrieve(record.id) || record;
}

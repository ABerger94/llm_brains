import { CuriosityItem } from './data';

/**
 * New root curiosity rows: point root at self, clear parent, default depth 0.
 * @param {{ id: string } & Record<string, unknown>} record
 */
export async function finalizeNewCuriosityRoot(record) {
  if (!record?.id) return record;
  if (record.root_curiosity_id) return CuriosityItem.retrieve(record.id) || record;
  await CuriosityItem.update(record.id, {
    root_curiosity_id: record.id,
    parent_curiosity_id: null,
    pursuit_depth: Number.isFinite(Number(record.pursuit_depth)) ? Number(record.pursuit_depth) : 0,
  });
  return CuriosityItem.retrieve(record.id) || record;
}

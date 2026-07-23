/**
 * Legacy PendingMindUpdate rows (older builds) are auto-promoted on startup; new runs no longer create inbox items.
 */
import {
  getMindEntityStores,
  getActiveMindEntityProfile,
  setActiveMindEntityProfile,
  MIND_STORAGE_PROFILE_PRIMARY,
  MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
} from './mindEntityContext';
import { notifyMindStorageChanged } from './mindStorageEvents';
import {
  applySelfModelDeltaToWorldModel,
  syncBeliefStoreRowsFromSharedMemory,
  applyParsedBeliefRevisionsToPersistedStore,
  syncIntegrationStanceToWorldModel,
} from './mindPersistence';

/**
 * @param {string} id
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function promotePendingMindUpdate(id) {
  const stores = getMindEntityStores();
  const row = await stores.PendingMindUpdate.retrieve(id);
  if (!row || row.status !== 'pending') return { ok: false, error: 'not_found_or_not_pending' };

  try {
    if (row.kind === 'belief_revisions') {
      await applyParsedBeliefRevisionsToPersistedStore(row.payload);
    } else if (row.kind === 'world_self_item') {
      const it = row.payload?.item;
      if (it && typeof it === 'object') {
        await applySelfModelDeltaToWorldModel({ items: [it] });
      }
    } else if (row.kind === 'belief_store_sync') {
      const bs = row.payload?.beliefStore;
      if (Array.isArray(bs) && bs.length) {
        await syncBeliefStoreRowsFromSharedMemory({ beliefStore: bs, moduleOutputs: {} });
      }
    } else if (row.kind === 'world_integration_stance') {
      const gw = row.payload?.integrationJson;
      if (gw && typeof gw === 'object') {
        await syncIntegrationStanceToWorldModel({
          moduleOutputs: {
            Integration: `INTEGRATION_JSON: ${JSON.stringify(gw)}`,
          },
        });
      }
    } else {
      return { ok: false, error: 'unknown_kind' };
    }
    await stores.PendingMindUpdate.update(id, { status: 'approved' });
    notifyMindStorageChanged({ source: 'beliefs' });
    notifyMindStorageChanged({ source: 'world-model' });
    notifyMindStorageChanged({ source: 'pending-mind-updates' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * @param {string} id
 */
export async function rejectPendingMindUpdate(id) {
  const stores = getMindEntityStores();
  const row = await stores.PendingMindUpdate.retrieve(id);
  if (!row) return false;
  await stores.PendingMindUpdate.update(id, { status: 'rejected' });
  notifyMindStorageChanged({ source: 'pending-mind-updates' });
  return true;
}

/**
 * @param {string[]} ids
 */
export async function promotePendingMindUpdatesBatch(ids) {
  let ok = 0;
  for (const id of ids) {
    const r = await promotePendingMindUpdate(id);
    if (r.ok) ok += 1;
  }
  return ok;
}

/**
 * Apply every pending row for the active mind profile (used after profile switch or in isolation).
 * @returns {Promise<number>} count successfully promoted
 */
async function promoteAllPendingMindUpdatesForActiveProfile() {
  const stores = getMindEntityStores();
  if (!stores.PendingMindUpdate?.filter) return 0;
  const rows = await stores.PendingMindUpdate.filter({ status: 'pending' }, '-created_date', 500);
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id).filter(Boolean);
  return promotePendingMindUpdatesBatch(ids);
}

/**
 * Drain legacy `pending` inbox rows for primary and System B mirror so nothing stays stuck after staging removal.
 * @returns {Promise<number>} total rows promoted across profiles
 */
export async function promoteAllPendingMindUpdates() {
  const prev = getActiveMindEntityProfile();
  let total = 0;
  try {
    setActiveMindEntityProfile(MIND_STORAGE_PROFILE_PRIMARY);
    total += await promoteAllPendingMindUpdatesForActiveProfile();
    setActiveMindEntityProfile(MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR);
    total += await promoteAllPendingMindUpdatesForActiveProfile();
  } finally {
    setActiveMindEntityProfile(prev);
  }
  return total;
}

export async function countPendingMindUpdates() {
  const stores = getMindEntityStores();
  if (!stores.PendingMindUpdate?.filter) return 0;
  const rows = await stores.PendingMindUpdate.filter({ status: 'pending' }, '-created_date', 500);
  return rows.length;
}

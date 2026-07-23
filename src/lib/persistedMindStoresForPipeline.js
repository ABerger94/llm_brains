import { clipTextComplete } from '../../shared/textClip.mjs';
import { temporalEventsExcludingPauseNoise } from '../../shared/temporalTimelinePauseFilter.mjs';
import {
  getActiveMindEntityProfile,
  getMindEntityStores,
  getMindEntityStoresForProfile,
  normalizeScheduledTaskMindStorageProfile,
} from './mindEntityContext';
import { searchLongTermMemory } from './longTermMemorySearch';

/**
 * Long-term memory, belief store, consolidation digest (affective/tone history), and biography
 * for pipeline POST options — mirrored into CONTEXT_AND_POLICY on the server for every module except Voice.
 */
export async function fetchPersistedMindStoresForPipeline(userInput, opts = {}) {
  const profile =
    opts.mindStorageProfile !== undefined
      ? normalizeScheduledTaskMindStorageProfile(opts.mindStorageProfile)
      : getActiveMindEntityProfile();
  const S = getMindEntityStoresForProfile(profile);
  const ltmCap = Math.min(24, Math.max(4, Number(opts.ltmCap) || 14));
  const beliefCap = Math.min(40, Math.max(6, Number(opts.beliefCap) || 28));
  const digestCap = Math.min(12, Math.max(2, Number(opts.digestCap) || 8));
  const q = String(userInput || '').trim();

  const [ltmRows, beliefAll, digests, bio] = await Promise.all([
    q ? searchLongTermMemory(q, ltmCap, S.LongTermMemory) : S.LongTermMemory.list('-created_date', ltmCap),
    S.BeliefStore.list('-created_date', 120),
    S.ConsolidationDigest.list('-created_date', digestCap),
    S.MindBiography.list('-created_date', 1),
  ]);

  const persistedLongTermMemories = (ltmRows || []).slice(0, ltmCap).map((m) => ({
    title: clipTextComplete(String(m.title || '').trim(), 220, { ellipsis: false }),
    content: clipTextComplete(String(m.content || '').trim(), 1400, { ellipsis: true }),
    memory_type: String(m.memory_type || 'unknown').slice(0, 28),
    created_date: String(m.created_date || '').slice(0, 44),
  }));

  const mapBeliefRow = (b) => ({
    statement: clipTextComplete(String(b.statement || '').trim(), 560, { ellipsis: true }),
    confidence:
      typeof b.confidence === 'number' && Number.isFinite(b.confidence) ? Math.min(1, Math.max(0, b.confidence)) : null,
    category: String(b.category || '').slice(0, 36),
    source: String(b.source || '').slice(0, 44),
    status: String(b.status || 'active').slice(0, 20),
  });

  const contradicted = beliefAll.filter((b) => b.status === 'contradicted');
  const active = beliefAll.filter((b) => (b.status || 'active') === 'active');
  const seen = new Set();
  const persistedBeliefRows = [];
  for (const b of contradicted) {
    if (persistedBeliefRows.length >= beliefCap) break;
    if (!b.id || seen.has(b.id)) continue;
    seen.add(b.id);
    persistedBeliefRows.push(mapBeliefRow(b));
  }
  for (const b of active) {
    if (persistedBeliefRows.length >= beliefCap) break;
    if (!b.id || seen.has(b.id)) continue;
    seen.add(b.id);
    persistedBeliefRows.push(mapBeliefRow(b));
  }

  const persistedAffectHistory = (digests || [])
    .map((d) => ({
      summary: clipTextComplete(String(d.digest_summary || d.digest_text || '').trim(), 480, { ellipsis: true }),
      created_date: String(d.created_date || '').slice(0, 44),
    }))
    .filter((x) => x.summary);

  const b0 = bio?.[0];
  const persistedBiographyExcerpt = b0
    ? clipTextComplete(String(b0.summary || b0.full_text || '').trim(), 2800, { ellipsis: true })
    : '';

  return {
    persistedLongTermMemories,
    persistedBeliefRows,
    persistedAffectHistory,
    persistedBiographyExcerpt,
  };
}

/** One batch for graph pipeline: mind stores + auxiliary lists used for execution log lines. */
export async function loadGraphPipelineClientContext(userInput) {
  const S = getMindEntityStores();
  const inputText = String(userInput || '').trim();
  const [mindStores, recentTemporalEventsRaw, biographies, worldModel, curiosityItems] = await Promise.all([
    fetchPersistedMindStoresForPipeline(inputText),
    S.TemporalEvent.list('-created_date', 16),
    S.MindBiography.list('-created_date', 1),
    S.WorldModel.list('-updated_date', 30),
    S.CuriosityItem.list('-created_date', 15),
  ]);
  const recentTemporalEvents = temporalEventsExcludingPauseNoise(recentTemporalEventsRaw);
  return { mindStores, recentTemporalEvents, biographies, worldModel, curiosityItems };
}

export function logGraphPipelineContextLoaded(ctx, addLog) {
  const { mindStores, recentTemporalEvents, biographies, worldModel, curiosityItems } = ctx;
  addLog('Loading persisted memories, beliefs, affect notes, timeline…');
  const ltmN = mindStores.persistedLongTermMemories?.length ?? 0;
  const belN = mindStores.persistedBeliefRows?.length ?? 0;
  const affN = mindStores.persistedAffectHistory?.length ?? 0;
  if (ltmN > 0) addLog(`${ltmN} long-term memory row(s) sent to server (Memory + related modules).`);
  if (belN > 0) addLog(`${belN} belief row(s) sent to server (contradicted first, then active).`);
  if (affN > 0) addLog(`${affN} consolidation digest snippet(s) sent (affect / tone continuity).`);
  if (mindStores.persistedBiographyExcerpt) addLog('Latest biography excerpt sent to server.');

  if (recentTemporalEvents.length > 0) {
    addLog(`${recentTemporalEvents.length} temporal event(s) sent to server (Temporal Awareness).`);
  }
  if (biographies[0]?.summary) addLog('Biography present in local store.');
  const beliefs = (mindStores.persistedBeliefRows || []).length;
  if (!biographies[0] && beliefs === 0 && ltmN === 0 && (worldModel?.length || 0) === 0) {
    if ((curiosityItems || []).length === 0 && recentTemporalEvents.length === 0) {
      addLog('Little local context yet — run pipelines or add data on Mind / Memory / Belief pages.');
    }
  }
  const curiosity = (curiosityItems || [])
    .filter((c) => {
      const s = c.status || 'open';
      return s === 'open' || s === 'pursuing';
    })
    .slice(0, 10);
  if (worldModel.length > 0) addLog(`${worldModel.length} world model entries in local store.`);
  if (curiosity.length > 0) addLog(`${curiosity.length} open curiosity items in local store.`);
}

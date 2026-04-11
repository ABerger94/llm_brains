import { slimEpistemicFusion } from '../../shared/epistemicFusion.mjs';
import { pipelineJsonReplacer } from './safeJsonStringify.js';

/**
 * Limits size of sharedMemory sent back into POST /api/pipeline/stream.
 * Default trims module outputs to keep JSON small; supervisor continuation legs use a much higher
 * cap so the prior leg’s full trace is preserved (align with server `PIPELINE_CONTINUATION_MODULE_MAX_CHARS` default).
 * Oversized POST bodies may return HTTP 413.
 */

const MAX_MODULE_OUTPUT = 8000;
/** Match server `continuationModuleMaxChars` default when env unset (400_000). */
const CONTINUATION_MAX_MODULE_OUTPUT = 400_000;
const MAX_ORIGINAL_INPUT = 32000;
const MAX_IDENTITY = 12000;
const MAX_RERUN = 6000;
const MAX_NARRATIVE_ENTRY = 6000;
const MAX_META_FLAGS = 12;
const MAX_WEB_FINDINGS = 8000;
const MAX_STRUCTURAL_SELF = 4000;
const MAX_GLOBAL_WORKSPACE = 3500;

/**
 * @param {object|null|undefined} sm
 * @param {{ continuation?: boolean }} [opts] - when true, preserve long moduleOutputs for supervisor RERUN POSTs
 */
export function slimSharedMemoryForPipelinePost(sm, opts = {}) {
  if (sm == null || typeof sm !== 'object') return sm;
  const continuation = opts.continuation === true;
  const moduleCap = continuation ? CONTINUATION_MAX_MODULE_OUTPUT : MAX_MODULE_OUTPUT;
  const originalInputCap = continuation ? Math.max(MAX_ORIGINAL_INPUT, 96_000) : MAX_ORIGINAL_INPUT;
  let o;
  try {
    o = JSON.parse(JSON.stringify(sm, pipelineJsonReplacer));
  } catch (e) {
    console.warn(
      '[slimSharedMemory] cannot clone shared memory; starting this leg without a continuation seed',
      e?.message || e
    );
    return null;
  }
  try {
    if (o.moduleOutputs && typeof o.moduleOutputs === 'object') {
      for (const key of Object.keys(o.moduleOutputs)) {
        if (key.endsWith('__meta')) continue;
        const v = o.moduleOutputs[key];
        if (typeof v === 'string' && v.length > moduleCap) {
          o.moduleOutputs[key] = `${v.slice(0, moduleCap)}\n\n[…trimmed for continuation (${v.length} chars)]`;
        }
      }
    }
    if (typeof o.originalInput === 'string' && o.originalInput.length > originalInputCap) {
      o.originalInput = `${o.originalInput.slice(0, originalInputCap)}\n[…trimmed]`;
    }
    if (typeof o.identityNarrative === 'string' && o.identityNarrative.length > MAX_IDENTITY) {
      o.identityNarrative = `${o.identityNarrative.slice(0, MAX_IDENTITY)}…`;
    }
    if (typeof o.rerunGuidance === 'string' && o.rerunGuidance.length > MAX_RERUN) {
      o.rerunGuidance = `${o.rerunGuidance.slice(0, MAX_RERUN)}…`;
    }
    if (Array.isArray(o.narrativeHistory)) {
      o.narrativeHistory = o.narrativeHistory.slice(-10).map((x) => {
        if (typeof x !== 'string') return x;
        return x.length > MAX_NARRATIVE_ENTRY ? `${x.slice(0, MAX_NARRATIVE_ENTRY)}…` : x;
      });
    }
    if (Array.isArray(o.metaCognitionFlags)) {
      o.metaCognitionFlags = o.metaCognitionFlags.slice(-MAX_META_FLAGS);
    }
    if (Number.isFinite(Number(o.metacognitionRerunsUsed))) {
      o.metacognitionRerunsUsed = Math.min(50, Math.max(0, Math.floor(Number(o.metacognitionRerunsUsed))));
    }
    if (Array.isArray(o.curiosityQueue)) {
      o.curiosityQueue = o.curiosityQueue.slice(-20).map((x) => {
        const s = String(x);
        return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
      });
    }
    if (typeof o.webFindings === 'string' && o.webFindings.length > MAX_WEB_FINDINGS) {
      o.webFindings = `${o.webFindings.slice(0, MAX_WEB_FINDINGS)}\n[…trimmed]`;
    }
    if (Array.isArray(o.webFetchLog)) {
      o.webFetchLog = o.webFetchLog.slice(-8);
    }
    if (Array.isArray(o.structuralSelfModel)) {
      o.structuralSelfModel = o.structuralSelfModel.slice(0, 10).map((r) => ({
        ...r,
        description: String(r.description || '').slice(0, 400),
      }));
    }
    if (o.globalWorkspace && typeof o.globalWorkspace === 'object') {
      const gw = o.globalWorkspace;
      const ip = gw.iitProxy && typeof gw.iitProxy === 'object' ? gw.iitProxy : null;
      o.globalWorkspace = {
        ...gw,
        provisionalStance: String(gw.provisionalStance || '').slice(0, MAX_GLOBAL_WORKSPACE),
        salience: Array.isArray(gw.salience) ? gw.salience.map((s) => String(s).slice(0, 300)).slice(0, 8) : [],
        unityRationale: String(gw.unityRationale || '').slice(0, 400),
        phenomenalUnity: String(gw.phenomenalUnity || '').slice(0, 16),
        broadcastWinners: Array.isArray(gw.broadcastWinners)
          ? gw.broadcastWinners.map((s) => String(s).slice(0, 220)).slice(0, 4)
          : [],
        ...(ip
          ? {
              iitProxy: {
                causalTightness: ip.causalTightness,
                note: String(ip.note || '').slice(0, 240),
              },
            }
          : {}),
      };
    }
    if (o.workspaceIgnition && typeof o.workspaceIgnition === 'object') {
      const ig = o.workspaceIgnition;
      o.workspaceIgnition = {
        rankedTopics: Array.isArray(ig.rankedTopics)
          ? ig.rankedTopics.map((t) => String(t).slice(0, 200)).slice(0, 8)
          : [],
        ...(ig.dominantHypothesisId != null && String(ig.dominantHypothesisId).trim()
          ? { dominantHypothesisId: String(ig.dominantHypothesisId).slice(0, 28) }
          : {}),
        conflictPressure:
          typeof ig.conflictPressure === 'number' && Number.isFinite(ig.conflictPressure)
            ? ig.conflictPressure
            : undefined,
        notes: Array.isArray(ig.notes) ? ig.notes.map((n) => String(n).slice(0, 40)).slice(0, 6) : [],
      };
    }
    if (o.epistemicFusion && typeof o.epistemicFusion === 'object') {
      o.epistemicFusion = slimEpistemicFusion(o.epistemicFusion);
    }
    if (o.priorTurnGlobalWorkspace && typeof o.priorTurnGlobalWorkspace === 'object') {
      const pt = o.priorTurnGlobalWorkspace;
      const hy = Array.isArray(pt.hypotheses)
        ? pt.hypotheses.slice(0, 6).map((h) => {
            if (!h || typeof h !== 'object') return null;
            return {
              id: String(h.id || '').slice(0, 28),
              label: String(h.label || '').slice(0, 240),
              weight: typeof h.weight === 'number' && Number.isFinite(h.weight) ? h.weight : undefined,
              evidence_for: String(h.evidence_for || '').slice(0, 160),
              evidence_against: String(h.evidence_against || '').slice(0, 160),
              would_flip_if: String(h.would_flip_if || '').slice(0, 140),
            };
          })
        : [];
      const hyClean = hy.filter(Boolean);
      o.priorTurnGlobalWorkspace = {
        ...pt,
        provisionalStance: String(pt.provisionalStance || '').slice(0, 900),
        conflictsPreview: Array.isArray(pt.conflictsPreview)
          ? pt.conflictsPreview.map((s) => String(s).slice(0, 300)).slice(0, 3)
          : [],
        openQuestionsPreview: Array.isArray(pt.openQuestionsPreview)
          ? pt.openQuestionsPreview.map((s) => String(s).slice(0, 280)).slice(0, 3)
          : [],
        ...(hyClean.length ? { hypotheses: hyClean } : {}),
      };
    }
    if (typeof o.recentExchangeBlock === 'string' && o.recentExchangeBlock.length > 12000) {
      o.recentExchangeBlock = `${o.recentExchangeBlock.slice(0, 12000)}\n[…trimmed for continuation]`;
    }
    if (o.personalityProfile && typeof o.personalityProfile === 'object') {
      const pp = o.personalityProfile;
      const facets = Array.isArray(pp.facets) ? pp.facets.slice(0, 24) : [];
      o.personalityProfile = {
        ...pp,
        facets: facets.map((f) => ({
          ...f,
          evidence: String(f.evidence || '').slice(0, 300),
          label: String(f.label || '').slice(0, 80),
        })),
        systemTreatmentNotes: String(pp.systemTreatmentNotes || '').slice(0, 600),
      };
    }
    if (o.workingMemory?.items) {
      o.workingMemory = {
        items: o.workingMemory.items.slice(0, 10).map((it) => ({
          ...it,
          text: String(it.text || '').slice(0, 800),
        })),
      };
    }
    const ss = JSON.stringify(o.structuralSelfModel || []);
    if (ss.length > MAX_STRUCTURAL_SELF) {
      o.structuralSelfModel = (o.structuralSelfModel || []).slice(0, 4);
    }
    if (Array.isArray(o.recentTemporalTimeline)) {
      o.recentTemporalTimeline = o.recentTemporalTimeline.slice(0, 16).map((r) => {
        if (!r || typeof r !== 'object') return r;
        return {
          title: String(r.title || '').slice(0, 200),
          details: String(r.details || '').slice(0, 420),
          source: String(r.source || '').slice(0, 36),
          created_date: String(r.created_date || '').slice(0, 44),
        };
      });
    }
    if (Array.isArray(o.clientLtmDigest)) {
      o.clientLtmDigest = o.clientLtmDigest.slice(0, 12).map((r) => {
        if (!r || typeof r !== 'object') return r;
        return {
          title: String(r.title || '').slice(0, 200),
          content: String(r.content || '').slice(0, 800),
          memory_type: String(r.memory_type || '').slice(0, 28),
          created_date: String(r.created_date || '').slice(0, 44),
        };
      });
    }
    if (Array.isArray(o.clientBeliefDigest)) {
      o.clientBeliefDigest = o.clientBeliefDigest.slice(0, 16).map((r) => {
        if (!r || typeof r !== 'object') return r;
        return {
          statement: String(r.statement || '').slice(0, 400),
          confidence: typeof r.confidence === 'number' ? r.confidence : undefined,
          category: String(r.category || '').slice(0, 32),
          source: String(r.source || '').slice(0, 40),
          ...(String(r.status || '').trim() && String(r.status || '').trim() !== 'active'
            ? { status: String(r.status || '').slice(0, 20) }
            : {}),
        };
      });
    }
    if (Array.isArray(o.clientAffectDigest)) {
      o.clientAffectDigest = o.clientAffectDigest.slice(0, 6).map((r) => {
        if (!r || typeof r !== 'object') return r;
        return {
          summary: String(r.summary || '').slice(0, 360),
          created_date: String(r.created_date || '').slice(0, 44),
        };
      });
    }
    if (typeof o.clientBiographyExcerpt === 'string' && o.clientBiographyExcerpt.length > 2200) {
      o.clientBiographyExcerpt = `${o.clientBiographyExcerpt.slice(0, 2200)}\n[…trimmed]`;
    }
    return o;
  } catch (e) {
    console.warn('[slimSharedMemory] trim step failed; sending un-trimmed clone', e?.message || e);
    return o;
  }
}

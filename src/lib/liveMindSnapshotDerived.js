/**
 * Derive belief / emergence / identity / curiosity / goal signals purely from live pipeline module outputs
 * (plus graph lastSharedMemory for stance + DMN). No Dexie reads.
 */

import { graphPipelineStore } from './graphPipelineStore';
import { backendModuleNameToUiId } from './cognitiveModules';
import {
  collectPipelineEmergenceMarkers,
  derivePipelineBiographyIdentityFields,
} from '../../shared/biographyIdentityExtract.mjs';
import { parseSelfModelDelta, parseTraitDelta } from './mindPersistence';
import {
  parseFollowupCuriositiesFromModuleOutput,
  parseCuriosityUrgencyFromOutput,
  parseGoalUrgencyFromOutput,
} from './priorityUtils';
import { extractPrimaryTurnText } from './priorPredictionAudit';
import { clipTextComplete } from '../../shared/textClip.mjs';

/** @param {Record<string, string>|null|undefined} mo @param {string} pipelineName */
export function moduleOutputByName(mo, pipelineName) {
  if (!mo || typeof mo !== 'object') return '';
  const ui = backendModuleNameToUiId(pipelineName);
  const v = mo[pipelineName] ?? (ui ? mo[ui] : undefined);
  return String(v ?? '').trim();
}

function parseJsonAfterMarker(text, marker) {
  const raw = String(text || '');
  const needle = `${marker}:`;
  const idx = raw.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return null;
  const sub = raw.slice(idx + needle.length).trimStart();
  const brace = sub.indexOf('{');
  if (brace === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = brace; i < sub.length; i += 1) {
    if (sub[i] === '{') depth += 1;
    else if (sub[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(sub.slice(brace, end + 1));
  } catch {
    return null;
  }
}

/** @param {string} planningText */
function parseUserStancePredictionFromPlanning(planningText) {
  const parsed = parseJsonAfterMarker(String(planningText || ''), 'USER_STANCE_PREDICTION');
  if (!parsed || typeof parsed !== 'object') return null;
  const expectUserWants = String(parsed.expectUserWants || parsed.summary || '').trim();
  if (!expectUserWants && parsed.confidence == null) return null;
  return {
    expectUserWants: expectUserWants || String(parsed.summary || '').trim(),
    summary: parsed.summary != null ? String(parsed.summary) : undefined,
    confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : undefined,
  };
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function sliceSection(text, label) {
  const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, 'i');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : '';
}

function curiosityMainQuestionFromOutput(raw) {
  const t = String(raw || '').trim();
  if (t.length < 8) return '';
  const lines = t.split(/\r?\n/).map((l) => l.trim());
  const mq = lines.find((l) => /^MAIN_QUESTION:\s*/i.test(l));
  if (mq) {
    const q = mq.replace(/^MAIN_QUESTION:\s*/i, '').trim();
    if (q.length >= 8) return clipTextComplete(q, 2000, { ellipsis: false });
  }
  return '';
}

function goalBulletsFromGenerationOutput(raw) {
  const t = String(raw || '').trim();
  if (t.length < 12) return [];
  const out = [];
  for (const label of ['THIS_TURN', 'LONGER_TERM', 'NEW']) {
    const body = sliceSection(t, label);
    if (!body) continue;
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const cleaned = line.replace(/^[-*•]\s*/, '').trim();
      if (cleaned.length >= 12) {
        out.push({ section: label, text: clipTextComplete(cleaned, 2000, { ellipsis: false }) });
      }
    }
  }
  return out.slice(0, 12);
}

/**
 * @param {object[]} beliefSignals
 * @param {{ kind: string, ref?: string, text?: string }} item
 */
function pushDeduped(beliefSignals, item, seen) {
  const key = `${item.kind}|${(item.ref || item.text || '').toLowerCase().slice(0, 96)}`;
  if (seen.has(key)) return;
  seen.add(key);
  beliefSignals.push(item);
}

/**
 * @param {string} beliefStoreText
 */
function extractBeliefSignalsFromBeliefStoreText(beliefStoreText) {
  const text = String(beliefStoreText || '');
  /** @type {object[]} */
  const items = [];
  const seen = new Set();

  const rev = parseJsonAfterMarker(text, 'BELIEF_REVISIONS');
  for (const r of rev?.revisions || []) {
    const ref = String(r?.ref || '').trim();
    if (!ref) continue;
    const action = String(r?.action || '').toLowerCase();
    if (/strengthen|reinforce/.test(action)) {
      pushDeduped(items, { kind: 'reinforced', ref, action }, seen);
    } else if (/downgrade|weaken/.test(action)) {
      pushDeduped(items, { kind: 'weakened', ref, action }, seen);
    } else if (/remove|supersede/.test(action)) {
      pushDeduped(items, { kind: 'removed', ref, action }, seen);
    } else if (/resolve|resolved|mark_resolved/.test(action)) {
      pushDeduped(items, { kind: 'resolved', ref, action }, seen);
    }
  }

  const claims = parseJsonAfterMarker(text, 'EPISTEMIC_CLAIMS');
  for (const c of claims?.claims || []) {
    const claimText = String(c?.text || '').trim();
    if (claimText.length < 8) continue;
    pushDeduped(
      items,
      { kind: 'epistemic_claim', text: claimText, claimKind: String(c?.kind || '').trim() || undefined },
      seen
    );
  }

  for (const line of text.split('\n')) {
    const st = line.match(/\bSTATUS:\s*(\w+)/i);
    const bm = line.match(/BELIEF:\s*([^|]+)/i);
    if (st && bm) {
      const status = st[1].toLowerCase();
      if (status === 'reinforced' || status === 'new' || status === 'updated') {
        pushDeduped(
          items,
          { kind: `status_${status}`, text: bm[1].trim().slice(0, 400) },
          seen
        );
      }
    }
  }

  return items;
}

function pickRichestSourceForEmergence(sources) {
  let best = null;
  let bestScore = -1;
  for (const s of sources) {
    const mo = s?.moduleOutputs || {};
    const v = moduleOutputByName(mo, 'Voice').length;
    const n = moduleOutputByName(mo, 'Narrative').length;
    const i = moduleOutputByName(mo, 'Identity').length;
    const score = v + n + i;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/**
 * Same source list as {@link computeLiveMindSnapshot}: active rows, or idle graph store when empty.
 * @param {object[]} sources
 * @param {{ idleGraphFallback?: boolean }} [opts] - When `idleGraphFallback` is false (e.g. System Chat per-system buckets), do not substitute the global graph store — an empty bucket stays empty so the mirror leg does not mirror the primary leg’s module outputs.
 * @returns {object[]}
 */
export function resolveLivePipelineSourcesForMindSnapshot(sources, opts = {}) {
  const idleGraphFallback = opts.idleGraphFallback !== false;
  let srcs = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!srcs.length && idleGraphFallback) {
    const gp = graphPipelineStore.getState();
    const mo = gp.moduleOutputs && typeof gp.moduleOutputs === 'object' ? gp.moduleOutputs : {};
    const has =
      Object.values(mo).some((v) => String(v || '').trim()) || String(gp.finalOutput || '').trim();
    if (has) {
      srcs = [
        {
          kind: 'graph',
          moduleOutputs: mo,
          moduleStatuses: gp.moduleStatuses || {},
          finalOutput: gp.finalOutput || '',
          isProcessing: Boolean(gp.isRunning),
          loopCount: Number(gp.loopCount) || 0,
        },
      ];
    }
  }
  return srcs;
}

/**
 * Stance vs prediction stability for Live Analytics (same inputs as Mind snapshot “Stance vs prediction”).
 * @param {object[]} sources
 * @param {object|null} lastSharedMemory
 */
export function computeLiveIdentityStabilityFromSources(sources, lastSharedMemory) {
  const srcs = resolveLivePipelineSourcesForMindSnapshot(sources);
  const richestSource = pickRichestSourceForEmergence(srcs);
  const dmnFromSm = typeof lastSharedMemory?.dmnCarryover === 'string' ? lastSharedMemory.dmnCarryover : '';
  return computeLiveIdentityStability(lastSharedMemory, {
    fallbackModuleOutputs:
      (!lastSharedMemory || typeof lastSharedMemory !== 'object') && richestSource?.moduleOutputs
        ? richestSource.moduleOutputs
        : null,
    fallbackDmn: dmnFromSm,
    pipelineSources: srcs,
  });
}

/**
 * @param {object|null} lastSharedMemory
 * @param {{
 *   fallbackModuleOutputs?: Record<string, string>|null,
 *   fallbackDmn?: string,
 *   pipelineSources?: object[]|null,
 * }} [options]
 */
export function computeLiveIdentityStability(lastSharedMemory, options = {}) {
  const { fallbackModuleOutputs = null, fallbackDmn = '', pipelineSources = null } = options;
  let sm = lastSharedMemory && typeof lastSharedMemory === 'object' ? lastSharedMemory : null;
  const graphComposerInput = String(graphPipelineStore.getState().input || '').trim();

  if (!sm && fallbackModuleOutputs && typeof fallbackModuleOutputs === 'object') {
    sm = {
      moduleOutputs: fallbackModuleOutputs,
      dmnCarryover: typeof fallbackDmn === 'string' ? fallbackDmn : '',
      originalInput: graphComposerInput,
      userStancePrediction: null,
      priorTurnPredictionAudit: null,
    };
  }

  if (!sm) {
    return {
      headline: 'No graph shared-memory snapshot',
      detail:
        'Finish a graph pipeline leg in this tab to capture shared memory, or leave module outputs in the graph store for identity cues from live outputs only.',
      tier: 'unknown',
      overlap: null,
      signals: [],
      derivedPreview: '',
    };
  }

  const mo = sm.moduleOutputs && typeof sm.moduleOutputs === 'object' ? sm.moduleOutputs : {};
  const planningText = moduleOutputByName(mo, 'Planning');
  const parsedPlanningPred = parseUserStancePredictionFromPlanning(planningText);
  const predFromSm = sm.userStancePrediction && typeof sm.userStancePrediction === 'object' ? sm.userStancePrediction : null;
  const expectFromSm = String(predFromSm?.expectUserWants || predFromSm?.summary || '').trim();
  const effectivePred =
    expectFromSm || parsedPlanningPred
      ? {
          expectUserWants: expectFromSm || String(parsedPlanningPred?.expectUserWants || '').trim(),
          summary: predFromSm?.summary ?? parsedPlanningPred?.summary,
          confidence:
            typeof predFromSm?.confidence === 'number' && Number.isFinite(predFromSm.confidence)
              ? predFromSm.confidence
              : parsedPlanningPred?.confidence,
        }
      : null;
  const expectUserWants = String(effectivePred?.expectUserWants || '').trim();

  const originalInputMerged = String(sm.originalInput || graphComposerInput || '').trim();
  const newPrimary = extractPrimaryTurnText(originalInputMerged);

  const audit = sm.priorTurnPredictionAudit;
  const auditOverlap =
    audit && typeof audit === 'object' && typeof audit.overlapScore === 'number' && Number.isFinite(audit.overlapScore)
      ? Math.min(1, Math.max(0, audit.overlapScore))
      : null;

  let overlap = null;
  /** @type {'audit'|'primary'|'integration'|'voice'|null} */
  let overlapSource = null;
  let stanceNote = '';

  if (auditOverlap != null) {
    overlap = auditOverlap;
    overlapSource = 'audit';
    const pct = Math.round(overlap * 100);
    const align = String(audit.heuristicAlignment || 'unknown').trim() || 'unknown';
    stanceNote = `Cross-turn audit (prior Planning vs this primary turn): ${pct}% token overlap; heuristic ${align}.`;
    const prevExpect = String(audit.previousExpectUserWants || '').trim();
    if (prevExpect) {
      stanceNote += ` Prior expect: ${clipTextComplete(prevExpect, 160, { ellipsis: true })}`;
    }
    const newTurn = String(audit.newPrimaryTurnPreview || '').trim();
    if (newTurn) {
      stanceNote += ` New turn: ${clipTextComplete(newTurn, 160, { ellipsis: true })}`;
    }
  } else if (expectUserWants && newPrimary.trim().length > 4) {
    const embOverlap = sm._embeddingStanceOverlap;
    const embOverlapValid = typeof embOverlap === 'number' && Number.isFinite(embOverlap);
    if (embOverlapValid) {
      overlap = embOverlap;
    } else {
      const predTokens = tokenize(expectUserWants);
      const newTokens = tokenize(newPrimary);
      overlap = jaccard(predTokens, newTokens);
    }
    overlapSource = 'primary';
    const pct = Math.round(overlap * 100);
    const simMethod = embOverlapValid ? 'semantic' : 'token';
    if (overlap > 0.22) {
      stanceNote = `Planning “expect user wants” vs this leg’s primary turn: ${pct}% ${simMethod} overlap (aligned).`;
    } else if (overlap > 0.08) {
      stanceNote = `Planning expectation vs primary turn: ${pct}% ${simMethod} overlap (moderate drift).`;
    } else {
      stanceNote = `Planning expectation vs primary turn: ${pct}% ${simMethod} overlap (strong drift or new thread).`;
    }
  } else if (expectUserWants) {
    stanceNote =
      'Planning expectation text is present, but this leg’s primary turn is missing or too short — paste a message in Graph Pipeline or run a full leg so shared memory / composer input can be compared.';
  } else if (audit && typeof audit === 'object' && (audit.previousExpectUserWants || audit.newPrimaryTurnPreview)) {
    stanceNote =
      'Prior-turn prediction audit present but overlap score unavailable; see PRIOR_TURN_PREDICTION_AUDIT in shared memory.';
  } else {
    stanceNote =
      'No cross-turn audit yet. No USER_STANCE_PREDICTION JSON found in parsed Planning output (module may omit the line).';
  }

  const gwScanSources =
    Array.isArray(pipelineSources) && pipelineSources.length > 0 ? pipelineSources : [{ moduleOutputs: mo }];
  const gwSignals = extractGlobalWorkspaceSignalsFromSources(sm, gwScanSources);
  const prov = String(gwSignals?.provisionalStance || '').trim();

  if (overlap == null && expectUserWants && prov.length > 24) {
    const o = jaccard(tokenize(expectUserWants), tokenize(prov));
    overlap = o;
    overlapSource = 'integration';
    const pct = Math.round(o * 100);
    if (o > 0.22) {
      stanceNote = `Integration provisional stance vs Planning “expect user wants”: ${pct}% token overlap (aligned).`;
    } else if (o > 0.08) {
      stanceNote = `Integration provisional stance vs Planning expectation: ${pct}% overlap (moderate drift).`;
    } else {
      stanceNote = `Integration provisional stance vs Planning expectation: ${pct}% overlap (different emphasis or new thread).`;
    }
  }

  if (overlap == null && expectUserWants) {
    const voiceBlob = moduleOutputByName(mo, 'Voice') || '';
    if (voiceBlob.trim().length > 48) {
      const slice = voiceBlob.slice(0, 1600);
      const o = jaccard(tokenize(expectUserWants), tokenize(slice));
      overlap = o;
      overlapSource = 'voice';
      const pct = Math.round(o * 100);
      if (o > 0.22) {
        stanceNote = `Planning “expect user wants” vs Voice output (excerpt): ${pct}% token overlap (aligned).`;
      } else if (o > 0.08) {
        stanceNote = `Planning vs Voice excerpt: ${pct}% overlap (moderate).`;
      } else {
        stanceNote = `Planning vs Voice excerpt: ${pct}% overlap (Voice may elaborate beyond the expectation).`;
      }
    }
  }

  const diagnosticParts = [];
  if (newPrimary.trim()) {
    diagnosticParts.push(`Primary turn (this leg): ${clipTextComplete(newPrimary.trim(), 220, { ellipsis: true })}`);
  } else if (!graphComposerInput) {
    diagnosticParts.push('Graph composer is empty — open Graph Pipeline and type a message to anchor “primary turn”.');
  }
  if (
    expectUserWants &&
    overlapSource !== 'primary' &&
    overlapSource !== 'audit'
  ) {
    diagnosticParts.push(
      `Planning expectation: ${clipTextComplete(expectUserWants, 200, { ellipsis: true })}${parsedPlanningPred && !expectFromSm ? ' (parsed from Planning text)' : ''}`
    );
  } else if (!expectUserWants && planningText && String(planningText).trim().length > 40) {
    diagnosticParts.push(
      `Planning module ran (${String(planningText).trim().length} chars) but no USER_STANCE_PREDICTION JSON was parsed — check for a line USER_STANCE_PREDICTION: {"expectUserWants":"…","confidence":0.5}.`
    );
  }
  if (prov.length > 16 && overlapSource !== 'integration') {
    diagnosticParts.push(`Integration stance (excerpt): ${clipTextComplete(prov, 200, { ellipsis: true })}`);
  }
  if (overlapSource && overlapSource !== 'audit') {
    stanceNote += ` Source: ${overlapSource === 'primary' ? 'user vs Planning' : overlapSource === 'integration' ? 'Integration vs Planning' : 'Voice vs Planning'}.`;
  }

  if (stanceNote && diagnosticParts.length) {
    stanceNote = `${stanceNote} ${diagnosticParts.join(' ')}`;
  } else if (diagnosticParts.length && !stanceNote) {
    stanceNote = diagnosticParts.join(' ');
  }

  const idText = moduleOutputByName(mo, 'Identity');
  const narText = moduleOutputByName(mo, 'Narrative');
  const dmn = typeof sm.dmnCarryover === 'string' ? sm.dmnCarryover : '';
  const derived = derivePipelineBiographyIdentityFields({
    identityModuleText: idText,
    narrativeText: narText,
    dmnText: dmn,
  });
  const selfDelta = parseSelfModelDelta(idText);
  const traitDelta = parseTraitDelta(idText);
  const signals = [];
  if (derived.notable_delta_line?.trim()) signals.push('Narrative WHAT CHANGED');
  if (selfDelta && typeof selfDelta === 'object' && Object.keys(selfDelta).length) signals.push('SELF_MODEL_DELTA');
  if (traitDelta && typeof traitDelta === 'object' && Object.keys(traitDelta).length) signals.push('TRAIT_DELTA');

  let headline;
  if (overlap != null) {
    if (overlap > 0.22) headline = 'Stability: aligned with predicted stance';
    else if (overlap > 0.08) headline = 'Stability: moderate drift vs prediction';
    else headline = 'Stability: strong drift vs prediction';
  } else if (signals.length) {
    headline = 'Stability: identity / narrative signals (no stance compare)';
  } else if (expectUserWants || prov.length > 20 || planningText?.trim()) {
    headline = 'Stability: partial cues (see detail)';
  } else {
    headline = 'Stability: thin signals this leg';
  }

  const detail = [stanceNote, signals.length ? `Structured signals: ${signals.join(', ')}.` : null]
    .filter(Boolean)
    .join(' ');

  let tier = 'unknown';
  if (overlap != null) {
    if (overlap > 0.22) tier = 'aligned';
    else if (overlap > 0.08) tier = 'moderate';
    else tier = 'drift';
  } else if (signals.length) tier = 'identity_activity';
  else if (expectUserWants || prov.length > 20 || planningText?.trim()) tier = 'partial';

  return {
    headline,
    detail,
    tier,
    overlap,
    signals,
    derivedPreview: derived.notable_delta_line?.slice(0, 280) || '',
  };
}

const FALLBACK_UNITY_SENTINEL = 'No valid INTEGRATION_JSON line was parsed';

/**
 * @param {object|null|undefined} gw raw INTEGRATION_JSON / globalWorkspace object
 */
function normalizeGlobalWorkspaceDto(gw) {
  if (!gw || typeof gw !== 'object') {
    return null;
  }

  const unityRationale = String(gw.unityRationale || '').trim();
  const iit = gw.iitProxy && typeof gw.iitProxy === 'object' ? gw.iitProxy : null;

  return {
    phenomenalUnity: String(gw.phenomenalUnity || 'unknown'),
    unityRationale,
    integrationConfidence: typeof gw.integrationConfidence === 'number' ? gw.integrationConfidence : null,
    broadcastWinners: Array.isArray(gw.broadcastWinners) ? gw.broadcastWinners.map(String).filter(Boolean).slice(0, 4) : [],
    hypotheses: Array.isArray(gw.hypotheses)
      ? gw.hypotheses
          .filter((h) => h && typeof h === 'object' && String(h.label || '').trim())
          .map((h) => ({
            id: String(h.id || ''),
            label: String(h.label || ''),
            weight: typeof h.weight === 'number' ? h.weight : 0.5,
            evidence_for: String(h.evidence_for || ''),
            evidence_against: String(h.evidence_against || ''),
            would_flip_if: String(h.would_flip_if || ''),
          }))
          .slice(0, 8)
      : [],
    epistemicThreads: Array.isArray(gw.epistemicThreads)
      ? gw.epistemicThreads
          .filter((t) => t && typeof t === 'object' && String(t.thread || '').trim())
          .map((t) => ({ thread: String(t.thread || ''), kind: String(t.kind || 'unknown') }))
          .slice(0, 6)
      : [],
    salience: Array.isArray(gw.salience) ? gw.salience.map(String).filter(Boolean).slice(0, 8) : [],
    conflicts: Array.isArray(gw.conflicts) ? gw.conflicts.map(String).filter(Boolean).slice(0, 8) : [],
    openQuestions: Array.isArray(gw.openQuestions) ? gw.openQuestions.map(String).filter(Boolean).slice(0, 8) : [],
    provisionalStance: String(gw.provisionalStance || '').trim().slice(0, 1200),
    iitProxy: iit ? { causalTightness: typeof iit.causalTightness === 'number' ? iit.causalTightness : null, note: String(iit.note || '') } : null,
    isFallback: unityRationale.includes(FALLBACK_UNITY_SENTINEL),
  };
}

/**
 * Extract structured Integration / Global Workspace signals from lastSharedMemory
 * (primary) or by re-parsing INTEGRATION_JSON from one source's Integration output.
 */
export function extractGlobalWorkspaceSignals(lastSharedMemory, richestSource) {
  let gw = lastSharedMemory?.globalWorkspace;
  if (!gw || typeof gw !== 'object') {
    const mo = richestSource?.moduleOutputs && typeof richestSource.moduleOutputs === 'object' ? richestSource.moduleOutputs : {};
    const finalizeText = moduleOutputByName(mo, 'IntegrationFinalize');
    const integrationText = moduleOutputByName(mo, 'Integration');
    if (finalizeText) {
      gw = parseJsonAfterMarker(finalizeText, 'INTEGRATION_JSON');
    }
    if ((!gw || typeof gw !== 'object') && integrationText) {
      gw = parseJsonAfterMarker(integrationText, 'INTEGRATION_JSON');
    }
  }
  return normalizeGlobalWorkspaceDto(gw);
}

/**
 * Prefer `lastSharedMemory.globalWorkspace`; otherwise scan **every** active pipeline source for
 * parseable INTEGRATION_JSON. Live Analytics used to only check the "richest" source (Voice+Narrative+Identity
 * length), so Integration on Graph Pipeline could be missed when Curiosity/scheduler rows had longer Voice.
 *
 * @param {object|null} lastSharedMemory
 * @param {object[]} sources merged pipeline rows (graph, curiosity, goal, scheduler, …)
 */
export function extractGlobalWorkspaceSignalsFromSources(lastSharedMemory, sources) {
  const fromSm = extractGlobalWorkspaceSignals(lastSharedMemory, null);
  if (fromSm) return fromSm;
  const srcs = Array.isArray(sources) ? sources : [];
  for (const s of srcs) {
    const parsed = extractGlobalWorkspaceSignals(null, s);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * @param {object[]} sources - live pipeline source objects (moduleOutputs keyed by UI id or server name)
 * @param {object|null} lastSharedMemory - graphPipelineStore.lastSharedMemory
 * @param {{ idleGraphFallback?: boolean }} [opts] - Passed to {@link resolveLivePipelineSourcesForMindSnapshot}; set `idleGraphFallback: false` for System Chat per-system columns so an empty bucket does not read the bound graph session.
 */
export function computeLiveMindSnapshot(sources, lastSharedMemory, opts = {}) {
  const srcs = resolveLivePipelineSourcesForMindSnapshot(sources, opts);

  const richestSource = pickRichestSourceForEmergence(srcs);
  const dmnFromSm = typeof lastSharedMemory?.dmnCarryover === 'string' ? lastSharedMemory.dmnCarryover : '';
  const stability = computeLiveIdentityStability(lastSharedMemory, {
    fallbackModuleOutputs:
      (!lastSharedMemory || typeof lastSharedMemory !== 'object') && richestSource?.moduleOutputs
        ? richestSource.moduleOutputs
        : null,
    fallbackDmn: dmnFromSm,
    pipelineSources: srcs,
  });

  /** @type {object[]} */
  const beliefSignals = [];
  const beliefSeen = new Set();
  for (const s of srcs) {
    const t =
      moduleOutputByName(s.moduleOutputs || {}, 'Beliefs') ||
      moduleOutputByName(s.moduleOutputs || {}, 'Belief Store');
    if (!t) continue;
    for (const it of extractBeliefSignalsFromBeliefStoreText(t)) {
      const key = `${it.kind}|${(it.ref || it.text || '').toLowerCase().slice(0, 120)}`;
      if (beliefSeen.has(key)) continue;
      beliefSeen.add(key);
      beliefSignals.push(it);
    }
  }

  const emMo = richestSource?.moduleOutputs || {};
  const emergence = collectPipelineEmergenceMarkers({
    voiceText: moduleOutputByName(emMo, 'Voice') || richestSource?.finalOutput || '',
    narrativeText: moduleOutputByName(emMo, 'Narrative'),
    identityText:
      moduleOutputByName(emMo, 'SelfRelationTension') || moduleOutputByName(emMo, 'Identity'),
    dmnText: dmnFromSm,
  });

  /** @type {object[]} */
  const curiosityItems = [];
  const curiositySeen = new Set();
  for (const s of srcs) {
    const raw =
      moduleOutputByName(s.moduleOutputs || {}, 'Motivation') ||
      moduleOutputByName(s.moduleOutputs || {}, 'Curiosity');
    if (!raw) continue;
    const main = curiosityMainQuestionFromOutput(raw);
    if (main) {
      const h = main.toLowerCase().slice(0, 80);
      if (!curiositySeen.has(h)) {
        curiositySeen.add(h);
        const u = parseCuriosityUrgencyFromOutput(raw);
        curiosityItems.push({ type: 'main', text: main, urgency: u });
      }
    }
    for (const f of parseFollowupCuriositiesFromModuleOutput(raw)) {
      const q = String(f.question || '').trim();
      if (q.length < 8) continue;
      const h = q.toLowerCase().slice(0, 80);
      if (curiositySeen.has(h)) continue;
      curiositySeen.add(h);
      curiosityItems.push({ type: 'followup', text: q, priority: f.priority });
    }
  }

  /** @type {object[]} */
  const goalItems = [];
  const goalSeen = new Set();
  for (const s of srcs) {
    const raw = moduleOutputByName(s.moduleOutputs || {}, 'Goal Generation');
    if (!raw) continue;
    const urgency = parseGoalUrgencyFromOutput(raw);
    for (const g of goalBulletsFromGenerationOutput(raw)) {
      const h = g.text.toLowerCase().slice(0, 80);
      if (goalSeen.has(h)) continue;
      goalSeen.add(h);
      goalItems.push({ ...g, urgency });
    }
  }

  const idMo = richestSource?.moduleOutputs || {};
  const idText = moduleOutputByName(idMo, 'Identity');
  const narText = moduleOutputByName(idMo, 'Narrative');
  const identityDerived = derivePipelineBiographyIdentityFields({
    identityModuleText: idText,
    narrativeText: narText,
    dmnText: dmnFromSm,
  });
  const selfDelta = parseSelfModelDelta(idText);
  const traitDelta = parseTraitDelta(idText);

  /** @type {{ label: string, excerpt: string }[]} */
  const identityLogs = [];
  if (identityDerived.notable_delta_line?.trim()) {
    identityLogs.push({
      label: 'Narrative WHAT CHANGED (excerpt)',
      excerpt: clipTextComplete(identityDerived.notable_delta_line, 600, { ellipsis: true }),
    });
  }
  if (selfDelta && typeof selfDelta === 'object' && Object.keys(selfDelta).length) {
    identityLogs.push({
      label: 'SELF_MODEL_DELTA (keys)',
      excerpt: clipTextComplete(JSON.stringify(selfDelta), 800, { ellipsis: true }),
    });
  }
  if (traitDelta && typeof traitDelta === 'object' && Object.keys(traitDelta).length) {
    identityLogs.push({
      label: 'TRAIT_DELTA (keys)',
      excerpt: clipTextComplete(JSON.stringify(traitDelta), 800, { ellipsis: true }),
    });
  }
  if (identityDerived.identity_keywords?.length) {
    identityLogs.push({
      label: 'Harvested identity keywords',
      excerpt: identityDerived.identity_keywords.slice(0, 16).join(', '),
    });
  }
  if (identityDerived.core_values?.length) {
    identityLogs.push({
      label: 'Harvested core values',
      excerpt: identityDerived.core_values.slice(0, 12).join(', '),
    });
  }

  const gwSignals = extractGlobalWorkspaceSignalsFromSources(lastSharedMemory, srcs);

  const hasAny =
    beliefSignals.length > 0 ||
    emergence.markers.length > 0 ||
    curiosityItems.length > 0 ||
    goalItems.length > 0 ||
    identityLogs.length > 0 ||
    stability.tier !== 'unknown' ||
    gwSignals !== null;

  return {
    sourcesUsed: srcs.length,
    hasAny,
    stability,
    globalWorkspace: gwSignals,
    beliefSignals,
    emergenceMarkers: emergence.markers,
    emergenceEvidence: emergence.evidence_items,
    curiosityItems,
    goalItems,
    identityLogs,
  };
}

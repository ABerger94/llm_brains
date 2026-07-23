/**
 * Post-merge, post-rerank hints when persisted store digests overlap each other or in-run beliefStore.
 *
 * Priority when sources disagree (product rule):
 * - Persisted browser-store rows (PERSISTED_* blocks) define stable identity for listed items.
 * - In-run `beliefStore` entries and workspace strings in SHARED_MEMORY_JSON are this-turn only;
 *   they win for explicit new revisions when merged deliberately, but must not silently replace
 *   persisted rows—call out reconciliation in module output.
 */

const SIGNIFICANT_TOKEN = /\b[a-z]{4,}\b/gi;

/** @param {string} s */
function tokenSet(s) {
  const m = String(s).toLowerCase().match(SIGNIFICANT_TOKEN);
  if (!m) return new Set();
  return new Set(m);
}

/** @param {Set<string>} a @param {Set<string>} b */
function sharedTokenCount(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Cheap overlap: at least `minShared` significant tokens and ratio vs smaller set.
 * @param {string} textA
 * @param {string} textB
 */
function tokensOverlap(textA, textB, minShared = 2) {
  const A = tokenSet(textA);
  const B = tokenSet(textB);
  if (A.size < 2 || B.size < 2) return false;
  const sh = sharedTokenCount(A, B);
  if (sh < minShared) return false;
  const smaller = Math.min(A.size, B.size);
  return sh >= Math.max(minShared, smaller * 0.35);
}

/**
 * Mutates sharedMemory: sets `contextMergeOverlapHints` (string[]) or deletes it.
 * @param {object} sharedMemory
 */
export function applyCrossChannelDigestHints(sharedMemory) {
  delete sharedMemory.contextMergeOverlapHints;
  delete sharedMemory.contextMergeWorkspaceAdmissionHints;
  const hints = [];

  const ltm = sharedMemory.clientLtmDigest;
  const bel = sharedMemory.clientBeliefDigest;
  const world = sharedMemory.clientWorldEnvironmentDigest;
  const runBeliefs = sharedMemory.beliefStore;

  if (Array.isArray(ltm) && Array.isArray(bel)) {
    for (let bi = 0; bi < Math.min(bel.length, 28); bi++) {
      const bstmt = String(bel[bi]?.statement || '');
      for (let li = 0; li < Math.min(ltm.length, 22); li++) {
        const ltext = `${ltm[li]?.title || ''} ${ltm[li]?.content || ''}`;
        if (tokensOverlap(bstmt, ltext)) {
          hints.push(
            `PERSISTED_BELIEF_STORE #${bi + 1} ↔ PERSISTED_LONG_TERM_MEMORY #${li + 1} (see both; reconcile, do not double-count)`
          );
          break;
        }
      }
    }
  }

  if (Array.isArray(bel) && Array.isArray(world)) {
    for (let wi = 0; wi < Math.min(world.length, 16); wi++) {
      const wtext = `${world[wi]?.label || ''} ${world[wi]?.description || ''}`;
      for (let bi = 0; bi < Math.min(bel.length, 28); bi++) {
        const bstmt = String(bel[bi]?.statement || '');
        if (tokensOverlap(bstmt, wtext)) {
          hints.push(
            `PERSISTED_BELIEF_STORE #${bi + 1} ↔ PERSISTED_WORLD_ENVIRONMENT #${wi + 1} (align with STRUCTURAL_SELF / world rules)`
          );
          break;
        }
      }
    }
  }

  if (Array.isArray(runBeliefs) && Array.isArray(bel)) {
    for (let ri = 0; ri < Math.min(runBeliefs.length, 20); ri++) {
      const raw = runBeliefs[ri];
      const rtext = String(raw?.belief || raw?.statement || '').trim();
      if (rtext.length < 40) continue;
      const clip = rtext.slice(0, 800);
      for (let pi = 0; pi < Math.min(bel.length, 28); pi++) {
        const pstmt = String(bel[pi]?.statement || '');
        if (tokensOverlap(clip, pstmt)) {
          hints.push(
            `in-run beliefStore[${ri}] may overlap PERSISTED_BELIEF_STORE #${pi + 1} — prefer persisted row identity unless this turn explicitly revises`
          );
          break;
        }
      }
    }
  }

  const seen = new Set();
  const uniq = [];
  for (const h of hints) {
    if (seen.has(h)) continue;
    seen.add(h);
    uniq.push(h);
    if (uniq.length >= 8) break;
  }
  if (uniq.length) sharedMemory.contextMergeOverlapHints = uniq;
}

/**
 * After Integration sets `globalWorkspace`, mark which persisted digest rows token-overlap the
 * broadcast stance/salience (admission hints — not a second retrieval pass).
 * Mutates sharedMemory: `contextMergeWorkspaceAdmissionHints` or deletes it.
 * @param {object} sharedMemory
 */
export function applyWorkspaceDigestAdmissionHints(sharedMemory) {
  delete sharedMemory.contextMergeWorkspaceAdmissionHints;
  const gw = sharedMemory?.globalWorkspace;
  if (!gw || typeof gw !== 'object') return;

  const stance = String(gw.provisionalStance || '').trim();
  const sal = Array.isArray(gw.salience) ? gw.salience : [];
  const salText = sal.map((s) => String(s)).join(' ');
  const corpus = `${stance}\n${salText}`.trim();
  if (corpus.length < 24) return;

  const hints = [];
  const ltm = sharedMemory.clientLtmDigest;
  if (Array.isArray(ltm)) {
    for (let i = 0; i < Math.min(ltm.length, 18); i++) {
      const row = `${ltm[i]?.title || ''} ${ltm[i]?.content || ''}`;
      if (tokensOverlap(corpus, row, 2)) {
        hints.push(
          `PERSISTED_LONG_TERM_MEMORY #${i + 1} — token overlap with GLOBAL_WORKSPACE_JSON stance/salience (admit for reconciliation; prefer workspace for this-turn thread)`
        );
      }
    }
  }
  const bel = sharedMemory.clientBeliefDigest;
  if (Array.isArray(bel)) {
    for (let i = 0; i < Math.min(bel.length, 24); i++) {
      const row = String(bel[i]?.statement || '');
      if (tokensOverlap(corpus, row, 2)) {
        hints.push(
          `PERSISTED_BELIEF_STORE #${i + 1} — token overlap with GLOBAL_WORKSPACE_JSON stance/salience (reconcile; do not double-count)`
        );
      }
    }
  }
  const world = sharedMemory.clientWorldEnvironmentDigest;
  if (Array.isArray(world)) {
    for (let i = 0; i < Math.min(world.length, 10); i++) {
      const row = `${world[i]?.label || ''} ${world[i]?.description || ''}`;
      if (tokensOverlap(corpus, row, 2)) {
        hints.push(
          `PERSISTED_WORLD_ENVIRONMENT #${i + 1} — token overlap with GLOBAL_WORKSPACE_JSON stance/salience (align with structural world + workspace thread)`
        );
      }
    }
  }

  const seen = new Set();
  const uniq = [];
  for (const h of hints) {
    if (seen.has(h)) continue;
    seen.add(h);
    uniq.push(h);
    if (uniq.length >= 10) break;
  }
  if (uniq.length) sharedMemory.contextMergeWorkspaceAdmissionHints = uniq;
}

/**
 * Policy block: priority rules + optional overlap hints from {@link applyCrossChannelDigestHints}.
 * @param {object} sm
 */
export function buildContextMergePriorityBlock(sm) {
  const base = `CONTEXT_MERGE_PRIORITY: Persisted browser-store rows below (PERSISTED_* headers) are saved snapshots from the user’s device. In-run SHARED_MEMORY_JSON fields (beliefStore, workspace, moduleOutputs) are this turn only—when they overlap, reconcile explicitly; do not treat module prose as newly persisted store facts unless the product flow confirms it.`;
  const hints = sm?.contextMergeOverlapHints;
  const wsHints = sm?.contextMergeWorkspaceAdmissionHints;
  const parts = [base];
  if (Array.isArray(hints) && hints.length) {
    parts.push(
      `Overlap hints (cheap token match; verify before merging):\n${hints.map((h) => `- ${h}`).join('\n')}`
    );
  }
  if (Array.isArray(wsHints) && wsHints.length) {
    parts.push(
      `Workspace admission hints (digest rows that overlap current GLOBAL_WORKSPACE_JSON stance/salience):\n${wsHints.map((h) => `- ${h}`).join('\n')}`
    );
  }
  return parts.join('\n');
}

/**
 * Dev-only: approximate character volume of digest payloads (not full policy strings).
 * @param {object} sm
 */
export function logContextDigestSizes(sm) {
  const keys = [
    'clientLtmDigest',
    'clientBeliefDigest',
    'clientAffectDigest',
    'clientWorldEnvironmentDigest',
    'clientCuriosityDigest',
    'clientGoalDigest',
    'recentTemporalTimeline',
  ];
  const parts = [];
  for (const k of keys) {
    const v = sm[k];
    if (!Array.isArray(v) || !v.length) continue;
    let chars = 0;
    for (const row of v) {
      chars += JSON.stringify(row).length;
    }
    parts.push(`${k}≈${chars}`);
  }
  const bio = String(sm.clientBiographyExcerpt || '').length;
  if (bio) parts.push(`clientBiographyExcerpt≈${bio}`);
  if (parts.length) console.log('[context digest sizes]', parts.join('; '));
}

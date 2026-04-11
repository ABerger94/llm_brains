/** In-memory only: lets Dashboard abort in-flight graph SSE for a curiosity/goal pursuit slot. */

const curiosity = new Map();
const goals = new Map();

/**
 * @param {string} curiosityId
 * @param {AbortController} controller
 */
export function registerCuriosityPursuitGraphAbort(curiosityId, controller) {
  const id = String(curiosityId || '');
  if (!id || !controller) return;
  curiosity.set(id, controller);
}

/** @param {string} curiosityId */
export function clearCuriosityPursuitGraphAbort(curiosityId) {
  curiosity.delete(String(curiosityId || ''));
}

/**
 * @param {string} curiosityId
 * @returns {boolean} true if a controller was present and abort() was called
 */
export function abortRegisteredCuriosityPursuitGraph(curiosityId) {
  const id = String(curiosityId || '');
  const ac = curiosity.get(id);
  if (!ac) return false;
  curiosity.delete(id);
  try {
    ac.abort();
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * @param {string} goalId
 * @param {AbortController} controller
 */
export function registerGoalPursuitGraphAbort(goalId, controller) {
  const id = String(goalId || '');
  if (!id || !controller) return;
  goals.set(id, controller);
}

/** @param {string} goalId */
export function clearGoalPursuitGraphAbort(goalId) {
  goals.delete(String(goalId || ''));
}

/**
 * @param {string} goalId
 * @returns {boolean}
 */
export function abortRegisteredGoalPursuitGraph(goalId) {
  const id = String(goalId || '');
  const ac = goals.get(id);
  if (!ac) return false;
  goals.delete(id);
  try {
    ac.abort();
  } catch {
    /* ignore */
  }
  return true;
}

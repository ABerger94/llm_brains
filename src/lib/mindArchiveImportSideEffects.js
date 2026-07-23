/**
 * Reconcile in-memory UI stores with IndexedDB after a mind archive import (KV + records already written).
 */

import { syncDashboardScheduledRunningFromDb } from './dashboardScheduledRunningSync';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import {
  replaceCuriosityPursuitsSnapshotFromImportedKv,
  sanitizeCuriosityPursuitsReloadFlagsAfterMindImport,
} from './curiosityPagePursuitStore';
import {
  replaceGoalPursuitsSnapshotFromImportedKv,
  sanitizeGoalPursuitsReloadFlagsAfterMindImport,
} from './goalPagePursuitStore';
import { graphPipelineStore } from './graphPipelineStore';
import { clearCooperativePauseRegistryAndMirror } from './pipelineActiveRunRegistry';
import { resetSchedulerPipelineUiAfterImport } from './schedulerPipelineUiStore';

export function afterMindArchiveImport() {
  if (typeof window === 'undefined') return;
  graphPipelineStore.rehydrateFromPersisted();
  consciousnessStreamStore.rehydrateFromPersisted();
  replaceCuriosityPursuitsSnapshotFromImportedKv();
  replaceGoalPursuitsSnapshotFromImportedKv();
  sanitizeCuriosityPursuitsReloadFlagsAfterMindImport();
  sanitizeGoalPursuitsReloadFlagsAfterMindImport();
  resetSchedulerPipelineUiAfterImport();
  clearCooperativePauseRegistryAndMirror();
  void syncDashboardScheduledRunningFromDb();
}

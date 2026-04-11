import { TemporalEvent } from './data';
import { temporalEventsExcludingPauseNoise } from '../../shared/temporalTimelinePauseFilter.mjs';

/**
 * Load recent rows from the Temporal Timeline (TemporalEvent) for pipeline POST `options.recentTemporalEvents`.
 */
export async function fetchRecentTemporalEventsForPipeline(maxItems = 24) {
  try {
    const n = Math.min(48, Math.max(4, Number(maxItems) || 24));
    const raw = await TemporalEvent.list('-created_date', n);
    return temporalEventsExcludingPauseNoise(raw);
  } catch {
    return [];
  }
}

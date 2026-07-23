import { COGNITIVE_MODULES } from './cognitiveModules';

export function streamTimeLabel(isoOrMs) {
  let d;
  if (isoOrMs == null || isoOrMs === '') {
    d = new Date();
  } else if (typeof isoOrMs === 'number' || typeof isoOrMs === 'string') {
    d = new Date(isoOrMs);
  } else {
    d = new Date();
  }
  if (Number.isNaN(d.getTime())) {
    d = new Date();
  }
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

export function formatMetaCalibration(cal) {
  if (!cal || typeof cal !== 'object') return '';
  return [
    cal.decision && `decision=${cal.decision}`,
    cal.uncertainty != null && !Number.isNaN(cal.uncertainty) && `uncertainty=${cal.uncertainty}`,
    cal.gaps && `gaps=${cal.gaps}`,
    cal.clarify && `clarify=${cal.clarify}`,
    cal.strategy && `strategy=${cal.strategy}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function conversationToStreamEntries(rows) {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.created_date).getTime() - new Date(b.created_date).getTime()
  );
  const out = [];
  for (const m of sorted) {
    const t = streamTimeLabel(m.created_date);
    const idBase = m.id || `${t}-${Math.random()}`;
    if (m.role === 'user') {
      out.push({
        id: `${idBase}-u`,
        type: 'user-input',
        content: m.content || '',
        moduleId: null,
        moduleName: null,
        moduleColor: null,
        moduleGlyph: null,
        time: t,
      });
    } else if (m.role === 'assistant') {
      const sm = m.shared_memory || {};
      const mt = (sm.metacognitionTimeline || []).slice(-6);
      for (let i = 0; i < mt.length; i += 1) {
        const cal = mt[i];
        const line = formatMetaCalibration(cal);
        if (line) {
          out.push({
            id: `${idBase}-mt-${i}`,
            type: 'meta-calibration',
            content: line,
            moduleId: 'executiveGate',
            moduleName: 'ExecutiveGate',
            moduleColor: COGNITIVE_MODULES.find((x) => x.id === 'executiveGate')?.color,
            moduleGlyph: 'M',
            time: t,
          });
        }
      }
      out.push({
        id: `${idBase}-a`,
        type: 'voice',
        content: m.content || '',
        moduleId: 'voice',
        moduleName: 'Voice',
        moduleColor: COGNITIVE_MODULES.find((x) => x.id === 'voice')?.color,
        moduleGlyph: 'V',
        time: t,
      });
      if (m.reruns_used) {
        out.push({
          id: `${idBase}-r`,
          type: 'system',
          content: `Reruns used: ${m.reruns_used}`,
          moduleId: null,
          moduleName: null,
          moduleColor: null,
          moduleGlyph: null,
          time: t,
        });
      }
    } else {
      out.push({
        id: `${idBase}-s`,
        type: 'system',
        content: m.content || '',
        moduleId: null,
        moduleName: null,
        moduleColor: null,
        moduleGlyph: null,
        time: t,
      });
    }
  }
  return out;
}

export { buildConsciousnessStreamRenderPlan } from './conversationStreamRenderPlan.js';

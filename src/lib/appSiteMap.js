import {
  Activity,
  BookMarked,
  BookOpen,
  Brain,
  Clock,
  Cpu,
  Database,
  FileSearch,
  FileText,
  Fingerprint,
  Gauge,
  GitBranch,
  Globe,
  Home,
  MessageSquare,
  Moon,
  Orbit,
  Radio,
  Search,
  Settings,
  Target,
  Zap,
} from 'lucide-react';

/**
 * Single source of truth for app routes, sidebar labels, and header titles.
 * Keep this in sync with <Routes> in App.jsx (same paths).
 */

/** @typedef {'root'|'cognition'|'mind'|'memory'|'analytics'|'training'|'footer'} AppNavSectionId */

/** @type {{ id: AppNavSectionId, heading: string | null }} */
export const APP_NAV_SECTIONS = [
  { id: 'root', heading: null },
  { id: 'cognition', heading: 'COGNITION' },
  { id: 'mind', heading: 'MIND' },
  { id: 'memory', heading: 'MEMORY' },
  { id: 'analytics', heading: 'ANALYTICS' },
  { id: 'training', heading: 'TRAINING' },
  { id: 'footer', heading: null },
];

/**
 * @type {Array<{
 *   path: string
 *   title: string
 *   nav?: { section: AppNavSectionId, label?: string }
 *   icon?: typeof Home
 *   manualBlurb?: string
 * }>}
 */
export const APP_ROUTES = [
  { path: '/', title: 'Dashboard', nav: { section: 'root', label: 'Dashboard' }, icon: Home, manualBlurb: 'Overview, backup, quick links, latest pipeline voice.' },
  {
    path: '/dialogue',
    title: 'Dialogue',
    nav: { section: 'root', label: 'Dialogue' },
    icon: MessageSquare,
    manualBlurb:
      'Index of sessions and recent answered questions or goals. Session transcript at /dialogue/:sessionId; full question or goal detail at /dialogue/curiosity/:id and /dialogue/goal/:id with View thread for pursuit clusters.',
  },
  {
    path: '/graph-pipeline',
    title: 'Graph Pipeline',
    nav: { section: 'cognition' },
    icon: GitBranch,
    manualBlurb:
      'Runs list at /graph-pipeline; each session opens a workspace with curiosity-style pipeline UI (stage map, neural graph, execution.log) plus inspector and composer. Probabilistic features (adaptive temperature, soft metacognition thresholds, multi-sample modules, embedding-ranked memory) run transparently during each graph run. Scheduled graph tasks also open at /graph-pipeline/scheduled/:taskId. /consciousness-stream redirects here.',
  },
  { path: '/biography', title: 'Mind Biography', nav: { section: 'mind' }, icon: BookOpen, manualBlurb: 'First-person narrative versions and auto-appends from runs.' },
  { path: '/health', title: 'Cognitive Health', nav: { section: 'mind' }, icon: Activity, manualBlurb: 'Aggregate readiness and mind-health snapshot cards. Health endpoint now includes embedding cache stats and calibrated thresholds.' },
  { path: '/mind-self', title: 'Self & consolidation', nav: { section: 'mind' }, icon: Brain, manualBlurb: 'Self-ledger, user model, consolidation digest.' },
  {
    path: '/dmn-reflections',
    title: 'DMN Reflections',
    nav: { section: 'mind' },
    icon: Orbit,
    manualBlurb: 'Default-mode internal narratives from the self-ledger (scheduled drift reflections).',
  },
  { path: '/personality', title: 'Personality', nav: { section: 'mind' }, icon: Fingerprint, manualBlurb: 'Personality profile tooling for the modeled mind. Facet ranking now uses embedding similarity when available.' },
  { path: '/beliefs', title: 'Belief Map', nav: { section: 'mind' }, icon: BookMarked, manualBlurb: 'Belief network, tensions, pipeline belief digest. Epistemic fusion now uses embedding-based semantic similarity when available.' },
  { path: '/curiosity', title: 'Curiosity Queue', nav: { section: 'mind' }, icon: Search, manualBlurb: 'Open questions from runs and manual items.' },
  {
    path: '/goals',
    title: 'Goals',
    nav: { section: 'mind', label: 'Goals' },
    icon: Target,
    manualBlurb: 'Self-set goals, graph/LLM pursuit, scheduler integration; seeded from Goal Generation (like Curiosity Queue).',
  },
  { path: '/temporal', title: 'Temporal Timeline', nav: { section: 'mind' }, icon: Clock, manualBlurb: 'Pipeline events, health metrics, milestones.' },
  { path: '/world-model', title: 'World Model', nav: { section: 'mind' }, icon: Globe, manualBlurb: 'Structured world slots and extraction from runs.' },
  {
    path: '/shared-memory',
    title: 'Shared Memory',
    nav: { section: 'memory' },
    icon: FileText,
    manualBlurb: 'Editable per-run workspace JSON: moduleOutputs, globalWorkspace, web fields, recentExchangeBlock, cognitivePolicy (now stochastic), interoception, embedding similarity scores, etc.',
  },
  { path: '/memory', title: 'Long-Term Memory', nav: { section: 'memory' }, icon: Database, manualBlurb: 'Durable LTM rows and search. Pipeline retrieval now re-ranks entries by embedding cosine similarity blended with recency decay.' },
  { path: '/dreaming', title: 'Dreaming Mode', nav: { section: 'mind' }, icon: Moon, manualBlurb: 'Creative recombination of memories and beliefs.' },
  { path: '/emergence', title: 'Emergence Log', nav: { section: 'analytics' }, icon: Gauge, manualBlurb: 'Deviation scan across recent pipeline runs.' },
  {
    path: '/output-search',
    title: 'Output search',
    nav: { section: 'analytics', label: 'Output search' },
    icon: FileSearch,
    manualBlurb: 'Keyword search across saved pipeline runs and optional assistant transcript messages.',
  },
  {
    path: '/live-analytics',
    title: 'Live Analytics',
    nav: { section: 'analytics', label: 'Live Analytics' },
    icon: Radio,
    manualBlurb:
      'Live module outputs for active pipelines. Use Output search or Cognitive Health for persisted runs.',
  },
  {
    path: '/iterations',
    title: 'Iterations',
    nav: { section: 'analytics' },
    icon: Clock,
    manualBlurb: 'Saved PipelineRun audit: supervisor reruns (Metacognition / Workspace Metacognition), loop_count, snapshots. Reruns now use probabilistic confidence thresholds instead of binary decisions.',
  },
  { path: '/experiments', title: 'Experiments', nav: { section: 'analytics' }, icon: Cpu, manualBlurb: 'Experiment log and probes.' },
  { path: '/rlhf', title: 'RLHF Loop', nav: { section: 'training' }, icon: Zap, manualBlurb: 'Rate outputs for dataset-style feedback.' },
  { path: '/datasets', title: 'Datasets', nav: { section: 'training' }, icon: Database, manualBlurb: 'Local dataset records from exports.' },
  { path: '/training', title: 'Training', nav: { section: 'training' }, icon: Cpu, manualBlurb: 'Training run log (objectives and status).' },
  { path: '/playground', title: 'Playground', nav: { section: 'training' }, icon: Zap, manualBlurb: 'Sequential single-prompt module pass in the browser.' },
  { path: '/scheduler', title: 'Scheduler', nav: { section: 'footer' }, icon: Clock, manualBlurb: 'Deferred tasks (pipeline, dreams, extraction, etc.).' },
  { path: '/settings', title: 'Settings', nav: { section: 'footer' }, icon: Settings, manualBlurb: 'Runtime prompts, LLM prefs, automation toggles. Probabilistic features (embeddings, adaptive temperature, multi-sample, stochastic policy, calibration) are configured in .env.' },
  { path: '/user-manual', title: 'User Manual', nav: { section: 'footer' }, icon: FileText, manualBlurb: 'This documentation view.' },
  { path: '/neural-network', title: 'Neural Network', manualBlurb: 'Visualization-only page (not in the main sidebar).' },
  { path: '/multi-mind', title: 'Multi-Mind (retired)', manualBlurb: 'Redirect: old advocate/skeptic flow removed; use Graph Pipeline or Playground.' },
];

/** Mobile header + tab title resolution (longest matching path wins after root). */
export function getAppNavTitle(pathname) {
  const p = pathname || '/';
  if (p === '/') {
    const root = APP_ROUTES.find((r) => r.path === '/');
    return root?.title ?? 'Dashboard';
  }
  const sorted = APP_ROUTES.filter((r) => r.path !== '/').sort((a, b) => b.path.length - a.path.length);
  for (const r of sorted) {
    if (p === r.path || p.startsWith(`${r.path}/`)) return r.title;
  }
  return 'MyBrain';
}

/** Sidebar groups with items in display order. */
export function getAppNavSidebarGroups() {
  const bySection = new Map();
  for (const sec of APP_NAV_SECTIONS) {
    bySection.set(sec.id, []);
  }
  for (const r of APP_ROUTES) {
    if (!r.nav || !r.icon) continue;
    const label = r.nav.label ?? r.title;
    bySection.get(r.nav.section).push({ path: r.path, label, icon: r.icon });
  }
  return APP_NAV_SECTIONS.map((sec) => ({
    id: sec.id,
    heading: sec.heading,
    items: bySection.get(sec.id) ?? [],
  })).filter((g) => g.items.length > 0);
}

/**
 * The 22-stage cognitive pipeline.
 *
 * Each stage is one small, focused call to the local LLM. A stage only ever
 * sees the original stimulus plus the specific prior outputs it "depends on"
 * (its `deps`) — not the full transcript — so prompts stay short enough for
 * a 1B-3B model's context window and each stage stays interpretable as one
 * step of a cognitive architecture (loosely modeled on Global Workspace /
 * LIDA style pipelines: perception -> memory -> affect -> deliberation ->
 * action -> reflection -> broadcast).
 */

export interface MindStageContext {
  stimulus: string;
  deps: Record<string, string>;
}

export interface MindStage {
  id: string;
  order: number;
  phase: string;
  title: string;
  /** One-line explanation of what real cognitive process this stage models. */
  blurb: string;
  /** ids of earlier stages whose output is fed in as context */
  deps: string[];
  systemPrompt: string;
  buildUserPrompt: (ctx: MindStageContext) => string;
}

function depBlock(ctx: MindStageContext, deps: string[], labels: Record<string, string>): string {
  return deps
    .map((id) => `${labels[id] ?? id}:\n${ctx.deps[id] ?? "(none yet)"}`)
    .join("\n\n");
}

const LABELS: Record<string, string> = {
  perception: "Raw percept",
  attention: "Attended content",
  patternRecognition: "Recognized pattern",
  percept: "Interpreted percept",
  workingMemory: "Working memory buffer",
  longTermMemory: "Retrieved memory",
  emotion: "Emotional appraisal",
  salience: "Salience assessment",
  context: "Situational context",
  selfModel: "Self-model check",
  values: "Value alignment",
  theoryOfMind: "Theory of mind",
  imagination: "Imagined trajectories",
  goals: "Goals",
  impulseCheck: "Impulse / inhibition check",
  reasoning: "Deliberation",
  decision: "Decision",
  planning: "Plan",
  metacognition: "Metacognitive reflection",
  narrative: "Self-narrative",
  language: "Inner speech",
  consciousOutput: "Conscious broadcast",
};

export const PHASES = [
  "Perception",
  "Memory",
  "Affect & Salience",
  "Self & Social Cognition",
  "Imagination & Goals",
  "Reasoning & Decision",
  "Integration",
] as const;

export const MIND_CHAIN: MindStage[] = [
  {
    id: "perception",
    order: 1,
    phase: "Perception",
    title: "Sensory Input",
    blurb: "Raw intake of the stimulus, stripped of interpretation — what a sense organ would register.",
    deps: [],
    systemPrompt:
      "You are the raw sensory-input stage of a mind. Only restate what is literally present in the stimulus, with no interpretation, judgment, or inference. Be brief.",
    buildUserPrompt: (ctx) =>
      `Stimulus:\n${ctx.stimulus}\n\nRestate only the literal sensory content of this stimulus, stripped of any meaning or interpretation.`,
  },
  {
    id: "attention",
    order: 2,
    phase: "Perception",
    title: "Attention Gate",
    blurb: "Filters the raw percept down to what is salient enough to enter conscious processing.",
    deps: ["perception"],
    systemPrompt:
      "You are the attention-gating stage of a mind. Decide what part of the raw percept is salient enough to pass through to conscious processing, and what gets filtered out as background noise. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["perception"], LABELS)}\n\nWhat, specifically, is salient here and deserves attention? What is safely ignored?`,
  },
  {
    id: "patternRecognition",
    order: 3,
    phase: "Perception",
    title: "Pattern Recognition",
    blurb: "Matches the attended content against known categories and patterns.",
    deps: ["attention"],
    systemPrompt:
      "You are the pattern-recognition stage of a mind. Match the attended content against familiar categories, schemas, or patterns. Name what this resembles. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["attention"], LABELS)}\n\nWhat familiar pattern, category, or schema does this match?`,
  },
  {
    id: "percept",
    order: 4,
    phase: "Perception",
    title: "Perceptual Interpretation",
    blurb: "Fuses attention and pattern recognition into one coherent interpreted object.",
    deps: ["attention", "patternRecognition"],
    systemPrompt:
      "You are the perceptual-interpretation stage of a mind. Fuse the attended content and recognized pattern into a single, coherent interpretation of what this is. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["attention", "patternRecognition"], LABELS)}\n\nState one coherent interpretation of what is happening.`,
  },
  {
    id: "workingMemory",
    order: 5,
    phase: "Memory",
    title: "Working Memory",
    blurb: "Holds the key facts of the percept active for ongoing processing.",
    deps: ["percept"],
    systemPrompt:
      "You are the working-memory stage of a mind. Hold the key facts of the current percept active, as a short bullet list, for use by later processing. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["percept"], LABELS)}\n\nList the key facts to keep active in working memory (3-5 bullets, terse).`,
  },
  {
    id: "longTermMemory",
    order: 6,
    phase: "Memory",
    title: "Long-Term Memory Retrieval",
    blurb: "Simulates recall of related past knowledge or experience triggered by this percept.",
    deps: ["workingMemory"],
    systemPrompt:
      "You are the long-term-memory-retrieval stage of a mind. Simulate what related past knowledge, experience, or association this content evokes. Be brief and speak in first person as recalled memory.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["workingMemory"], LABELS)}\n\nWhat related memory, experience, or prior knowledge does this evoke?`,
  },
  {
    id: "emotion",
    order: 7,
    phase: "Affect & Salience",
    title: "Emotional Appraisal",
    blurb: "Primary affective reaction: valence, arousal, and a named feeling.",
    deps: ["percept", "longTermMemory"],
    systemPrompt:
      "You are the emotional-appraisal stage of a mind. Give the primary affective reaction: valence (positive/negative), arousal (calm/intense), and name the feeling. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["percept", "longTermMemory"], LABELS)}\n\nWhat is the primary emotional reaction — valence, arousal, and named feeling?`,
  },
  {
    id: "salience",
    order: 8,
    phase: "Affect & Salience",
    title: "Threat / Reward Salience",
    blurb: "Judges how urgent, dangerous, or beneficial this is right now.",
    deps: ["emotion", "percept"],
    systemPrompt:
      "You are the salience-detection stage of a mind. Judge how urgent, threatening, or rewarding this is right now, and why. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["emotion", "percept"], LABELS)}\n\nHow urgent, threatening, or rewarding is this, and why?`,
  },
  {
    id: "context",
    order: 9,
    phase: "Affect & Salience",
    title: "Contextual Framing",
    blurb: "Situates the percept within the broader situational and social setting.",
    deps: ["percept", "longTermMemory"],
    systemPrompt:
      "You are the contextual-framing stage of a mind. Situate this percept within the broader situational and social context it is likely happening in. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["percept", "longTermMemory"], LABELS)}\n\nWhat is the broader situational/social context here?`,
  },
  {
    id: "selfModel",
    order: 10,
    phase: "Self & Social Cognition",
    title: "Self-Model Check",
    blurb: "Checks how this event relates to one's own identity and self-concept.",
    deps: ["context", "emotion"],
    systemPrompt:
      "You are the self-model stage of a mind. Check how this situation relates to one's own identity, role, or self-concept — speak in first person. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["context", "emotion"], LABELS)}\n\nHow does this relate to who 'I' am, or my role in this situation?`,
  },
  {
    id: "values",
    order: 11,
    phase: "Self & Social Cognition",
    title: "Value & Belief Alignment",
    blurb: "Checks whether the situation sits in tension with, or confirms, core values and beliefs.",
    deps: ["selfModel", "emotion"],
    systemPrompt:
      "You are the value-alignment stage of a mind. Check whether this situation aligns with or conflicts with core values and beliefs. Name the specific value at stake. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["selfModel", "emotion"], LABELS)}\n\nWhich values or beliefs are at stake, and is there alignment or tension?`,
  },
  {
    id: "theoryOfMind",
    order: 12,
    phase: "Self & Social Cognition",
    title: "Theory of Mind",
    blurb: "Models what other people involved might be thinking, feeling, or intending.",
    deps: ["context"],
    systemPrompt:
      "You are the theory-of-mind stage of a mind. Model what other people involved might be thinking, feeling, or intending. If no other people are involved, say so briefly.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["context"], LABELS)}\n\nWhat might other people involved be thinking, feeling, or intending?`,
  },
  {
    id: "imagination",
    order: 13,
    phase: "Imagination & Goals",
    title: "Imagination / Simulation",
    blurb: "Runs a few forward simulations of how this could unfold (episodic future thinking).",
    deps: ["context", "theoryOfMind", "values"],
    systemPrompt:
      "You are the imagination stage of a mind. Simulate 2-3 plausible ways this situation could unfold from here. Be brief, one line per possibility.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["context", "theoryOfMind", "values"], LABELS)}\n\nSketch 2-3 plausible ways this could unfold next.`,
  },
  {
    id: "goals",
    order: 14,
    phase: "Imagination & Goals",
    title: "Goal Formation",
    blurb: "Forms a concrete first-person goal given values, imagined outcomes, and salience.",
    deps: ["values", "imagination", "salience"],
    systemPrompt:
      "You are the goal-formation stage of a mind. Form one or two concrete first-person goals for this situation. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["values", "imagination", "salience"], LABELS)}\n\nWhat do 'I' want to happen here? State concrete goal(s).`,
  },
  {
    id: "impulseCheck",
    order: 15,
    phase: "Imagination & Goals",
    title: "Impulse / Inhibition Check",
    blurb: "Surfaces competing urges and flags which ones should be inhibited.",
    deps: ["emotion", "goals"],
    systemPrompt:
      "You are the impulse-control stage of a mind. Surface any competing urges or impulses (including ones in tension with the stated goal), and note which should be inhibited and why. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["emotion", "goals"], LABELS)}\n\nWhat competing impulses exist, and which should be held back?`,
  },
  {
    id: "reasoning",
    order: 16,
    phase: "Reasoning & Decision",
    title: "Deliberate Reasoning",
    blurb: "Weighs the options explicitly, trading off goals, imagined outcomes, and impulses.",
    deps: ["goals", "imagination", "impulseCheck"],
    systemPrompt:
      "You are the deliberate-reasoning stage of a mind. Weigh the realistic options explicitly, with tradeoffs. Be brief but show the reasoning, not just a conclusion.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["goals", "imagination", "impulseCheck"], LABELS)}\n\nWeigh the realistic options and their tradeoffs.`,
  },
  {
    id: "decision",
    order: 17,
    phase: "Reasoning & Decision",
    title: "Decision",
    blurb: "Commits to a single course of action based on the deliberation above.",
    deps: ["reasoning"],
    systemPrompt:
      "You are the decision stage of a mind. Commit to exactly one course of action based on the reasoning given. State it as a single clear decision. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["reasoning"], LABELS)}\n\nState the single decision being committed to.`,
  },
  {
    id: "planning",
    order: 18,
    phase: "Reasoning & Decision",
    title: "Planning",
    blurb: "Breaks the decision into concrete next steps.",
    deps: ["decision"],
    systemPrompt:
      "You are the planning stage of a mind. Break the decision into concrete, ordered next steps. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["decision"], LABELS)}\n\nWhat are the concrete next steps to carry this out?`,
  },
  {
    id: "metacognition",
    order: 19,
    phase: "Reasoning & Decision",
    title: "Metacognitive Reflection",
    blurb: "Steps back to assess confidence, blind spots, and biases in the reasoning just performed.",
    deps: ["reasoning", "decision"],
    systemPrompt:
      "You are the metacognition stage of a mind. Reflect on the reasoning and decision just made: how confident is this, what could be a blind spot or bias here? Be brief and honest.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["reasoning", "decision"], LABELS)}\n\nHow confident is this decision, and what blind spot or bias might be present?`,
  },
  {
    id: "narrative",
    order: 20,
    phase: "Integration",
    title: "Narrative Integration",
    blurb: "Weaves the episode into an ongoing first-person self-story.",
    deps: ["decision", "metacognition", "selfModel"],
    systemPrompt:
      "You are the narrative-integration stage of a mind. Weave this episode into an ongoing first-person self-story, in one short paragraph. Be brief.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["decision", "metacognition", "selfModel"], LABELS)}\n\nWeave this into one short paragraph of ongoing self-narrative.`,
  },
  {
    id: "language",
    order: 21,
    phase: "Integration",
    title: "Language Formulation",
    blurb: "Puts the integrated thought into natural first-person inner speech.",
    deps: ["narrative", "decision"],
    systemPrompt:
      "You are the language-formulation stage of a mind. Put the integrated thought into natural, first-person inner speech — as if thinking it silently. Be brief, one or two sentences.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["narrative", "decision"], LABELS)}\n\nPhrase this as one or two sentences of natural inner speech.`,
  },
  {
    id: "consciousOutput",
    order: 22,
    phase: "Integration",
    title: "Conscious Broadcast",
    blurb: "The Global-Workspace-style broadcast: the single unified thought that surfaces to awareness.",
    deps: ["language", "narrative", "decision", "emotion"],
    systemPrompt:
      "You are the conscious-broadcast stage of a mind — the final integration point where everything below the surface becomes one unified conscious thought. Synthesize it into the single thing that surfaces to awareness right now: what the mind actually notices, feels, and is about to say or do. Speak in first person, 2-4 sentences.",
    buildUserPrompt: (ctx) =>
      `${depBlock(ctx, ["language", "narrative", "decision", "emotion"], LABELS)}\n\nSynthesize all of this into the single unified thought that reaches conscious awareness right now.`,
  },
];

export const STAGE_LABELS = LABELS;

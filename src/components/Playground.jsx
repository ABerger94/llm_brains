import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownRight, GitBranch, Loader2, MessagesSquare, Sparkles, Trash2 } from 'lucide-react';
import GraphPipelineExecutionPanel from './pipeline/GraphPipelineExecutionPanel';
import GraphPipelineStreamResumeBanners from './pipeline/GraphPipelineStreamResumeBanners';
import { Button, Textarea, toast } from './ui';
import {
  rehydrateGraphPipelineSessionStores,
  resetPlaygroundDualGraphStoresAfterLeavingWorkspace,
} from '../lib/graphPipelineSessionHydrate';
import { cn } from '../lib/utils';
import { ConversationMessage, MirrorConversationMessage } from '../lib/data';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import {
  beginPlaygroundDualOrchestration,
  endPlaygroundDualOrchestration,
  PLAYGROUND_DUAL_TURNS_PER_BLOCK,
  PLAYGROUND_GRAPH_SESSION_A,
  PLAYGROUND_GRAPH_SESSION_B,
  runPlaygroundDualTurn,
  runPlaygroundSystemAOnly,
  runPlaygroundSystemBOnly,
  suggestRandomPlaygroundTopic,
} from '../lib/playgroundDualGraphRunner';
import {
  lastBaVoiceAForContinue,
  lastSystemBVoiceForPeer,
  lastVoiceAForPeer,
  lastVoiceAFromAbDialogue,
  latestAssistantVoiceTextForGraphSession,
  persistPlaygroundComposerAsPeerSyntheticVoice,
  PLAYGROUND_SYSTEM_LABEL_A,
  PLAYGROUND_SYSTEM_LABEL_B,
  threadHumanAnchorAb,
  threadHumanAnchorBa,
} from '../lib/playgroundDualMind';
import { getGraphPipelineSessionId, subscribeGraphPipelineSessionId } from '../lib/graphPipelineSessionScope';
import { getRuntimeSettings } from '../lib/runtimeSettings';
import { isCooperativePauseAllExternalHoldActive } from '../lib/cooperativePauseAllExternalHold';

/**
 * @typedef {{
 *   id: string,
 *   target: 'A' | 'B',
 *   userLine: string,
 *   voiceA: string,
 *   voiceB: string,
 *   ok: boolean,
 *   errorLabel?: string,
 *   dualChain?: boolean,
 * }} PlaygroundDialogueTurn
 */

export default function Playground() {
  const [systemAText, setSystemAText] = useState('');
  const [inputTarget, setInputTarget] = useState(
    /** @type {'A' | 'B'} */ ('A')
  );
  const [busy, setBusy] = useState(false);
  /** LLM topic generation only (composer stays editable before Run). */
  const [randomBusy, setRandomBusy] = useState(false);
  /** Pipeline run from the Run button (for spinner). */
  const [busySource, setBusySource] = useState(
    /** @type {'run' | null} */ (null)
  );
  const [dialogueTurns, setDialogueTurns] = useState(
    /** @type {PlaygroundDialogueTurn[]} */ ([])
  );
  /** Always-latest transcript for click handlers (avoids stale state when resolving peer B). */
  const dialogueTurnsRef = useRef(dialogueTurns);
  dialogueTurnsRef.current = dialogueTurns;
  /**
   * Last Voice lines persisted for playground graph sessions (Voice hub reads these too).
   * In-panel {@link dialogueTurns} only updates when you Run dual blocks here; mirror/primary DB rows
   * update for every pipeline leg, so we merge for “From B’s last Voice”.
   */
  const [persistedPeerVoices, setPersistedPeerVoices] = useState(
    /** @type {{ mirrorVoiceB: string, primaryVoiceA: string }} */ ({
      mirrorVoiceB: '',
      primaryVoiceA: '',
    })
  );

  const loadPersistedPeerVoices = useCallback(async () => {
    try {
      const [mirrorVoiceB, primaryVoiceA] = await Promise.all([
        latestAssistantVoiceTextForGraphSession(MirrorConversationMessage, PLAYGROUND_GRAPH_SESSION_B),
        latestAssistantVoiceTextForGraphSession(ConversationMessage, PLAYGROUND_GRAPH_SESSION_A),
      ]);
      const next = { mirrorVoiceB, primaryVoiceA };
      setPersistedPeerVoices(next);
      return next;
    } catch (e) {
      console.warn('[Playground] loadPersistedPeerVoices', e);
      const empty = { mirrorVoiceB: '', primaryVoiceA: '' };
      setPersistedPeerVoices(empty);
      return empty;
    }
  }, []);

  useEffect(() => {
    void loadPersistedPeerVoices();
  }, [loadPersistedPeerVoices]);

  useMindStorageRefresh(loadPersistedPeerVoices);

  /** Shown after a full block completes; Continue depends on {@link continueMode}. */
  const [dualBlockComplete, setDualBlockComplete] = useState(false);
  /** Which chain type finished: A→B… (`ab`) or B→A… (`ba`). */
  const [continueMode, setContinueMode] = useState(/** @type {'ab' | 'ba' | null} */ (null));
  /** Blocks completed in current auto-continue session. */
  const [autoContinueBlocksDone, setAutoContinueBlocksDone] = useState(0);
  /** True while waiting for the auto-continue delay before starting the next block. */
  const [autoContinueWaiting, setAutoContinueWaiting] = useState(false);
  /** Set to true to abort auto-continue mid-wait. */
  const autoContinueCancelledRef = useRef(false);
  /** During a dual block: 1..N of N. */
  const [dualProgress, setDualProgress] = useState(
    /** @type {{ current: number, total: number } | null} */ (null)
  );
  const dialogueEndRef = useRef(null);

  const graphSessionIdForPipeline = useSyncExternalStore(
    subscribeGraphPipelineSessionId,
    getGraphPipelineSessionId,
    getGraphPipelineSessionId
  );
  const resumeBannerSessionId = graphSessionIdForPipeline || PLAYGROUND_GRAPH_SESSION_A;

  useLayoutEffect(() => {
    rehydrateGraphPipelineSessionStores(PLAYGROUND_GRAPH_SESSION_A);
    return () => {
      resetPlaygroundDualGraphStoresAfterLeavingWorkspace();
    };
  }, []);

  useEffect(() => {
    try {
      dialogueEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {
      /* hidden tab / layout edge cases */
    }
  }, [dialogueTurns.length]);

  const clearDialogue = () => {
    setDialogueTurns([]);
    setDualBlockComplete(false);
    setContinueMode(null);
    setAutoContinueBlocksDone(0);
    autoContinueCancelledRef.current = true;
    setAutoContinueWaiting(false);
  };

  /**
   * Runs {@link PLAYGROUND_DUAL_TURNS_PER_BLOCK} dual turns: turn 1 uses `firstLineForA`;
   * later turns feed previous Voice B into System A. Chained turns prepend a DUAL_PEER_THREAD block so
   * System A retains the human seed and its own prior Voice to B.
   * @param {string} firstLineForA - Normal: opening line for A. With `startWithPeerB`: optional composer (human thread seed); peer line is B’s last Voice.
   * @param {{ isContinue?: boolean, startWithPeerB?: boolean }} [options]
   */
  const runDualBlock = async (firstLineForA, { isContinue = false, startWithPeerB = false } = {}) => {
    const rt = getRuntimeSettings();
    const n = Math.max(1, Math.min(20, Math.floor(Number(rt.playgroundTurnsPerBlock) || PLAYGROUND_DUAL_TURNS_PER_BLOCK)));
    /** @type {string} */
    let lineForA;
    /** @type {string} */
    let humanAnchorAb;
    /** @type {string} */
    let prevVoiceA;

    if (startWithPeerB) {
      /** Must claim orchestration before any await so leaving the page mid-flight cannot clear stores (see resetPlaygroundDualGraphStoresAfterLeavingWorkspace). */
      setBusy(true);
      setBusySource('run');
      setDualBlockComplete(false);
      setContinueMode(null);
      beginPlaygroundDualOrchestration();
      const { mirrorVoiceB, primaryVoiceA } = await loadPersistedPeerVoices();
      const peerB = lastSystemBVoiceForPeer(dialogueTurnsRef.current, mirrorVoiceB).trim();
      if (!peerB) {
        endPlaygroundDualOrchestration();
        setBusy(false);
        setBusySource(null);
        toast({
          title: 'No Voice B yet',
          description:
            'Run a dual block here, or complete a System B pipeline so mirror Voice exists. Saved mirror lines appear on the Dialogue (System B) transcript.',
          variant: 'destructive',
        });
        return;
      }
      lineForA = peerB;
      humanAnchorAb = String(firstLineForA || '').trim();
      prevVoiceA = lastVoiceAForPeer(dialogueTurnsRef.current, primaryVoiceA);
    } else {
      lineForA = String(firstLineForA || '').trim();
      if (!lineForA) return;
      humanAnchorAb = isContinue ? threadHumanAnchorAb(dialogueTurns) : lineForA;
      prevVoiceA = isContinue ? lastVoiceAFromAbDialogue(dialogueTurns) : '';
      setBusy(true);
      setBusySource('run');
      setDualBlockComplete(false);
      setContinueMode(null);
      beginPlaygroundDualOrchestration();
    }
    try {
      for (let i = 0; i < n; i += 1) {
        setDualProgress({ current: i + 1, total: n });
        const useChain =
          (startWithPeerB && i === 0) || (i > 0) || (isContinue && i === 0);
        const r = await runPlaygroundDualTurn(lineForA, useChain ? { chain: { humanOpening: humanAnchorAb, previousVoiceA: prevVoiceA } } : {});
        const userLineThis = lineForA;
        const turn = {
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 9)}`,
          target: /** @type {'A'} */ ('A'),
          userLine: userLineThis,
          voiceA: String(r.voiceTextA ?? ''),
          voiceB: String(r.voiceTextB ?? ''),
          ok: Boolean(r.ok),
          errorLabel: r.ok ? undefined : `${r.phase ?? '?'}: ${r.reason ?? 'unknown'}`,
          dualChain: i > 0 || (startWithPeerB && i === 0),
        };
        setDialogueTurns((prev) => [...prev, turn]);

        if (!r.ok) {
          toast({
            title: 'Dual turn stopped',
            description: turn.errorLabel,
            variant: 'destructive',
          });
          return;
        }
        const nextA = String(r.voiceTextB ?? '').trim();
        if (!nextA) {
          toast({
            title: 'Dual block stopped',
            description: 'Voice B was empty — cannot chain the next turn.',
            variant: 'destructive',
          });
          return;
        }
        prevVoiceA = String(r.voiceTextA ?? '').trim();
        lineForA = nextA;
      }

      setDualBlockComplete(true);
      setContinueMode('ab');
      setAutoContinueBlocksDone((c) => c + 1);
      toast({
        title: 'Round complete',
        description: `${n} dual turns finished. Continue for ${n} more, or type a new opening below.`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDialogueTurns((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          target: 'A',
          userLine: lineForA,
          voiceA: '',
          voiceB: '',
          ok: false,
          errorLabel: msg,
        },
      ]);
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    } finally {
      endPlaygroundDualOrchestration();
      setDualProgress(null);
      setBusy(false);
      setBusySource(null);
      void loadPersistedPeerVoices();
    }
  };

  /**
   * Configurable cycles of B → A, chaining Voice A into the next B.
   * @param {string} firstLineForB
   * @param {{ isContinue?: boolean, startWithPeerA?: boolean }} [options]
   */
  const runDualBlockFromB = async (firstLineForB, { isContinue = false, startWithPeerA = false } = {}) => {
    const rt = getRuntimeSettings();
    const n = Math.max(1, Math.min(20, Math.floor(Number(rt.playgroundTurnsPerBlock) || PLAYGROUND_DUAL_TURNS_PER_BLOCK)));
    let lineForB;
    let humanAnchorBa;
    let prevVoiceAForChain = '';

    if (startWithPeerA) {
      setBusy(true);
      setBusySource('run');
      setDualBlockComplete(false);
      setContinueMode(null);
      beginPlaygroundDualOrchestration();
      const { primaryVoiceA } = await loadPersistedPeerVoices();
      const peerA = lastVoiceAForPeer(dialogueTurnsRef.current, primaryVoiceA).trim();
      if (!peerA) {
        endPlaygroundDualOrchestration();
        setBusy(false);
        setBusySource(null);
        toast({
          title: 'No Voice A yet',
          description:
            'Run a dual block from System A, or complete a System A pipeline so primary Voice exists. Saved primary lines appear on the Dialogue (System A) transcript.',
          variant: 'destructive',
        });
        return;
      }
      lineForB = peerA;
      prevVoiceAForChain = peerA;
      humanAnchorBa = String(firstLineForB || '').trim();
    } else {
      lineForB = String(firstLineForB || '').trim();
      if (!lineForB) return;
      humanAnchorBa = isContinue ? threadHumanAnchorBa(dialogueTurns) : lineForB;
      setBusy(true);
      setBusySource('run');
      setDualBlockComplete(false);
      setContinueMode(null);
      beginPlaygroundDualOrchestration();
    }

    let prevVoiceA = '';
    try {
      for (let i = 0; i < n; i += 1) {
        setDualProgress({ current: i + 1, total: n });
        const userLineThis = lineForB;
        const rB = await runPlaygroundSystemBOnly(lineForB);
        if (!rB.ok) {
          const turn = {
            id: `${Date.now()}-${i}-b-${Math.random().toString(36).slice(2, 9)}`,
            target: /** @type {'B'} */ ('B'),
            userLine: userLineThis,
            voiceA: '',
            voiceB: String(rB.voiceTextB ?? ''),
            ok: false,
            errorLabel: `${rB.phase ?? '?'}: ${rB.reason ?? 'unknown'}`,
            dualChain: i > 0 || (startWithPeerA && i === 0),
          };
          setDialogueTurns((prev) => [...prev, turn]);
          toast({
            title: 'B→A turn stopped',
            description: turn.errorLabel,
            variant: 'destructive',
          });
          return;
        }
        const vb = String(rB.voiceTextB ?? '').trim();
        if (!vb) {
          toast({
            title: 'B→A block stopped',
            description: 'Voice B was empty — cannot chain System A.',
            variant: 'destructive',
          });
          return;
        }
        const useChainA =
          (startWithPeerA && i === 0) ||
          (i > 0) ||
          (isContinue && i === 0) ||
          (i === 0 && Boolean(humanAnchorBa));
        const chainA = useChainA
          ? {
              humanOpening: humanAnchorBa,
              previousVoiceA:
                i > 0 ? prevVoiceA : startWithPeerA ? prevVoiceAForChain : isContinue ? userLineThis : '',
            }
          : null;
        const rA = await runPlaygroundSystemAOnly(vb, chainA ? { chain: chainA } : {});
        if (!rA.ok) {
          const turn = {
            id: `${Date.now()}-${i}-ba-${Math.random().toString(36).slice(2, 9)}`,
            target: /** @type {'B'} */ ('B'),
            userLine: userLineThis,
            voiceA: '',
            voiceB: vb,
            ok: false,
            errorLabel: `A: ${rA.phase ?? '?'}: ${rA.reason ?? 'unknown'}`,
            dualChain: i > 0 || (startWithPeerA && i === 0),
          };
          setDialogueTurns((prev) => [...prev, turn]);
          toast({
            title: 'B→A turn stopped',
            description: turn.errorLabel,
            variant: 'destructive',
          });
          return;
        }
        const va = String(rA.voiceTextA ?? '').trim();
        if (!va) {
          toast({
            title: 'B→A block stopped',
            description: 'Voice A was empty — cannot chain the next B.',
            variant: 'destructive',
          });
          return;
        }
        const turn = {
          id: `${Date.now()}-${i}-ba-${Math.random().toString(36).slice(2, 9)}`,
          target: /** @type {'B'} */ ('B'),
          userLine: userLineThis,
          voiceA: va,
          voiceB: vb,
          ok: true,
          dualChain: i > 0 || (startWithPeerA && i === 0),
        };
        setDialogueTurns((prev) => [...prev, turn]);
        prevVoiceA = va;
        lineForB = va;
      }

      setDualBlockComplete(true);
      setContinueMode('ba');
      setAutoContinueBlocksDone((c) => c + 1);
      toast({
        title: 'Round complete',
        description: `${n} B→A turns finished. Continue for ${n} more, or type a new opening below.`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDialogueTurns((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          target: 'B',
          userLine: lineForB,
          voiceA: '',
          voiceB: '',
          ok: false,
          errorLabel: msg,
        },
      ]);
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    } finally {
      endPlaygroundDualOrchestration();
      setDualProgress(null);
      setBusy(false);
      setBusySource(null);
      void loadPersistedPeerVoices();
    }
  };

  const onContinueChat = async () => {
    if (busy || randomBusy) return;
    if (continueMode === 'ab') {
      const { mirrorVoiceB } = await loadPersistedPeerVoices();
      const seed = lastSystemBVoiceForPeer(dialogueTurns, mirrorVoiceB);
      if (!seed) {
        toast({
          title: 'Nothing to continue',
          description: 'Need a completed A-started turn with Voice B.',
          variant: 'destructive',
        });
        return;
      }
      await runDualBlock(seed, { isContinue: true });
      return;
    }
    if (continueMode === 'ba') {
      const seed = lastBaVoiceAForContinue(dialogueTurns);
      if (!seed) {
        toast({
          title: 'Nothing to continue',
          description: 'Need a completed B→A turn with Voice A.',
          variant: 'destructive',
        });
        return;
      }
      await runDualBlockFromB(seed, { isContinue: true });
    }
  };

  useEffect(() => {
    if (!dualBlockComplete || !continueMode || busy) return;
    const rt = getRuntimeSettings();
    if (!rt.playgroundAutoContinue) return;
    if (isCooperativePauseAllExternalHoldActive()) return;
    const maxBlocks = Math.max(1, Math.min(100, Math.floor(Number(rt.playgroundAutoContinueMaxBlocks) || 10)));
    if (autoContinueBlocksDone >= maxBlocks) {
      toast({ title: 'Auto-continue limit reached', description: `${maxBlocks} blocks completed.` });
      return;
    }
    const delaySec = Math.max(1, Math.min(60, Math.floor(Number(rt.playgroundAutoContinueDelaySeconds) || 5)));
    autoContinueCancelledRef.current = false;
    setAutoContinueWaiting(true);
    const timer = setTimeout(() => {
      setAutoContinueWaiting(false);
      if (autoContinueCancelledRef.current) return;
      void onContinueChat();
    }, delaySec * 1000);
    return () => {
      clearTimeout(timer);
      setAutoContinueWaiting(false);
    };
  }, [dualBlockComplete, continueMode, busy, autoContinueBlocksDone]);

  const stopAutoContinue = () => {
    autoContinueCancelledRef.current = true;
    setAutoContinueWaiting(false);
  };

  const onRandom = async () => {
    if (busy || randomBusy) return;
    setRandomBusy(true);
    try {
      const t = await suggestRandomPlaygroundTopic();
      if (!t?.trim()) {
        toast({ title: 'No topic generated', variant: 'destructive' });
        return;
      }
      setSystemAText(t.trim());
      setInputTarget('B');
      toast({
        title: 'Topic ready for System B',
        description: 'Edit the composer if you like, then Run — the line is also saved as Voice on System A (primary).',
      });
    } catch (e) {
      toast({
        title: 'Random topic failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setRandomBusy(false);
    }
  };

  const onRun = async () => {
    if (!systemAText.trim() || busy) return;
    setAutoContinueBlocksDone(0);
    autoContinueCancelledRef.current = false;
    const userLine = systemAText.trim();
    try {
      await persistPlaygroundComposerAsPeerSyntheticVoice({ inputTarget, userLine });
    } catch (e) {
      toast({
        title: 'Could not save peer Voice seed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
      return;
    }
    const seedId = `peer-seed-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setDialogueTurns((prev) => [
      ...prev,
      {
        id: seedId,
        kind: 'peer_composer_seed',
        inputTarget,
        text: userLine,
        ok: true,
      },
    ]);
    if (inputTarget === 'A') {
      await runDualBlock(userLine);
      return;
    }
    await runDualBlockFromB(userLine);
  };

  return (
    <div className="flex w-full min-h-0 flex-1 flex-col bg-background">
      <header className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-bold text-foreground">System Chat</h1>
        <p className="text-xs text-muted-foreground">
          Dual full graph: System A uses your primary mind; System B uses an isolated mirror store. When you Run from the composer,
          the same line is also saved as a Voice line on the <span className="font-medium text-foreground/90">other</span> system’s
          transcript (peer “said” it before the first leg). System A starts {PLAYGROUND_DUAL_TURNS_PER_BLOCK} A→B turns; System B
          starts {PLAYGROUND_DUAL_TURNS_PER_BLOCK} B→A turns. Random topic fills the composer for System B — edit, then Run. Supervisor
          metacognition reruns (if triggered) chain in the same session before Voice; set max reruns ≥ 1 on the graph Metacognition
          limits row below if needed. Intermediate rerun lines are not mirrored in the live stream.
        </p>
        <nav className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Link className="text-primary underline-offset-4 hover:underline" to="/beliefs/mirror">
            System B beliefs
          </Link>
          <Link className="text-primary underline-offset-4 hover:underline" to="/memory/mirror">
            System B memory
          </Link>
        </nav>
      </header>

      {/*
        Single scroll: AppLayout <main> only — no nested overflow-auto + flex-1 here. That combo made the
        execution panel stretch to fill the flex column and left a huge blank band above the composer when scrolling.
      */}
      <div className="flex flex-col gap-3 p-4 sm:p-6">
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="playground-composer-input">
              Composer — choose which system receives the text below
            </label>
            <div
              className="flex shrink-0 rounded-md border border-border bg-muted/30 p-0.5"
              role="group"
              aria-label="Input target system"
            >
              <button
                type="button"
                disabled={busy || randomBusy}
                onClick={() => setInputTarget('A')}
                className={cn(
                  'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
                  inputTarget === 'A'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                System A
              </button>
              <button
                type="button"
                disabled={busy || randomBusy}
                onClick={() => setInputTarget('B')}
                className={cn(
                  'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
                  inputTarget === 'B'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                System B
              </button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {inputTarget === 'A'
              ? `Runs ${PLAYGROUND_DUAL_TURNS_PER_BLOCK} times: each turn is A → Voice A → B, then Voice B feeds the next A (turn 1 uses your composer line). Use “From B’s last Voice” to start turn 1 with B’s latest Voice as the peer line (composer optional context).`
              : `Runs ${PLAYGROUND_DUAL_TURNS_PER_BLOCK} times: each turn is B → Voice B → A → Voice A, then Voice A feeds the next B (turn 1 uses your composer line). Use “From A’s last Voice” to start turn 1 with A’s latest Voice as the peer line (composer optional thread seed).`}
          </p>
          <Textarea
            id="playground-composer-input"
            value={systemAText}
            onChange={(e) => setSystemAText(e.target.value)}
            className="min-h-[100px] text-sm"
            placeholder={
              inputTarget === 'A'
                ? `Opening line for turn 1 of ${PLAYGROUND_DUAL_TURNS_PER_BLOCK} (then the chat chains automatically).`
                : `Opening line for B in turn 1 of ${PLAYGROUND_DUAL_TURNS_PER_BLOCK} (then B→A chains automatically).`
            }
            disabled={busy || randomBusy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || randomBusy}
              onClick={() => void onRandom()}
            >
              {randomBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Sparkles className="h-3 w-3" aria-hidden />}
              Random topic → B
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || randomBusy || !systemAText.trim()}
              onClick={() => void onRun()}
            >
              {busy && busySource === 'run' ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <GitBranch className="h-3 w-3" aria-hidden />
              )}
              {inputTarget === 'A'
                ? `Run ${PLAYGROUND_DUAL_TURNS_PER_BLOCK} dual turns (A→B)`
                : `Run ${PLAYGROUND_DUAL_TURNS_PER_BLOCK} B→A turns`}
            </Button>
            {inputTarget === 'A' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busy ||
                  randomBusy ||
                  !String(lastSystemBVoiceForPeer(dialogueTurns, persistedPeerVoices.mirrorVoiceB) || '').trim()
                }
                onClick={() => void runDualBlock(systemAText.trim(), { startWithPeerB: true })}
                aria-label="Start next A block from System B’s last Voice; composer is optional human thread seed"
              >
                {busy && busySource === 'run' ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <CornerDownRight className="h-3 w-3" aria-hidden />
                )}
                From B’s last Voice
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busy ||
                  randomBusy ||
                  !String(lastVoiceAForPeer(dialogueTurns, persistedPeerVoices.primaryVoiceA) || '').trim()
                }
                onClick={() => void runDualBlockFromB(systemAText.trim(), { startWithPeerA: true })}
                aria-label="Start next B block from System A’s last Voice; composer is optional human thread seed"
              >
                {busy && busySource === 'run' ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <CornerDownRight className="h-3 w-3" aria-hidden />
                )}
                From A’s last Voice
              </Button>
            )}
          </div>
          {dualProgress ? (
            <p className="text-[11px] text-muted-foreground" aria-live="polite">
              Block turn {dualProgress.current} of {dualProgress.total}…
            </p>
          ) : null}
          {dualBlockComplete && continueMode ? (
            <div className="rounded-md border border-primary/35 bg-primary/5 px-3 py-2.5">
              <p className="text-xs font-medium text-foreground">Round complete</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {continueMode === 'ab'
                  ? `${PLAYGROUND_DUAL_TURNS_PER_BLOCK} A→B turns finished. Continue the same thread, or type a new opening above for a fresh round.`
                  : `${PLAYGROUND_DUAL_TURNS_PER_BLOCK} B→A turns finished. Continue the same thread, or type a new opening above for a fresh round.`}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || randomBusy}
                  onClick={() => void onContinueChat()}
                >
                  {busy && busySource === 'run' ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <MessagesSquare className="h-3 w-3" aria-hidden />
                  )}
                  Continue chat
                </Button>
                {autoContinueWaiting ? (
                  <Button type="button" size="sm" variant="destructive" onClick={stopAutoContinue}>
                    Stop auto-continue
                  </Button>
                ) : null}
                {autoContinueWaiting ? (
                  <span className="text-[11px] text-muted-foreground">
                    Auto-continuing shortly… (block {autoContinueBlocksDone + 1})
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <section
          className="flex min-h-0 flex-col rounded-lg border border-border bg-card/40"
          aria-label="System Chat Voice history"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
            <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Voice
            </h2>
            <Link
              to={`/graph-pipeline/${encodeURIComponent(PLAYGROUND_GRAPH_SESSION_B)}`}
              className="hidden text-[10px] text-primary underline-offset-2 hover:underline sm:inline"
            >
              System B workspace
            </Link>
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
              {dialogueTurns.length} turn{dialogueTurns.length === 1 ? '' : 's'}
            </span>
            {dialogueTurns.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[10px] text-muted-foreground"
                onClick={clearDialogue}
              >
                <Trash2 className="h-3 w-3" aria-hidden />
                Clear
              </Button>
            ) : null}
          </div>
          <div className="max-h-[min(280px,40svh)] min-h-[5rem] overflow-y-auto overscroll-contain px-3 py-2">
            {dialogueTurns.length === 0 ? (
              <div className="space-y-3 py-4 text-center text-xs text-muted-foreground">
                <p>
                  Each Run saves your composer line as peer Voice on the other system, then adds {PLAYGROUND_DUAL_TURNS_PER_BLOCK}{' '}
                  chained turns (A→B… or B→A…). Random topic targets B — edit, then Run.
                </p>
                <p>
                  This list only shows dual runs started <span className="font-medium text-foreground/90">from this page</span>. The{' '}
                  <Link to={`/graph-pipeline/${encodeURIComponent(PLAYGROUND_GRAPH_SESSION_A)}`} className="text-primary underline-offset-2 hover:underline">
                    primary
                  </Link>{' '}
                  and{' '}
                  <Link to={`/graph-pipeline/${encodeURIComponent(PLAYGROUND_GRAPH_SESSION_B)}`} className="text-primary underline-offset-2 hover:underline">
                    System B (mirror)
                  </Link>{' '}
                  graph workspaces store every saved Voice line — “From B’s last Voice” can use the latest mirror Voice from there even when this panel is empty.
                </p>
              </div>
            ) : (
              <ul className="space-y-4">
                {dialogueTurns.map((turn) => {
                  if (turn.kind === 'peer_composer_seed') {
                    const peerLabel =
                      turn.inputTarget === 'A' ? PLAYGROUND_SYSTEM_LABEL_B : PLAYGROUND_SYSTEM_LABEL_A;
                    return (
                      <li
                        key={turn.id}
                        className="rounded-md border border-dashed border-border/70 bg-muted/25 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground"
                      >
                        <p className="font-medium text-foreground/85">Saved as peer Voice (composer)</p>
                        <p className="mt-1">
                          Stored on <span className="text-foreground/90">{peerLabel}</span>’s graph transcript as assistant Voice
                          (as if the peer had said this before your run).
                        </p>
                        <p className="mt-2 whitespace-pre-wrap break-words text-foreground/90">{turn.text || '—'}</p>
                      </li>
                    );
                  }
                  const target = turn.target ?? 'A';
                  return (
                  <li
                    key={turn.id}
                    className="rounded-md border border-border/80 bg-muted/15 px-3 py-2.5 text-xs leading-relaxed text-foreground shadow-sm"
                  >
                    {!turn.ok ? (
                      <p className="mb-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                        {turn.errorLabel || 'Turn failed'}
                      </p>
                    ) : null}
                    <div className="space-y-2">
                      <div>
                        <span className="font-medium text-muted-foreground">
                          {target === 'A'
                            ? turn.dualChain
                              ? 'Peer (B) → A'
                              : 'You → A'
                            : turn.dualChain
                              ? 'Peer (A) → B'
                              : 'You → B'}
                        </span>
                        <p className="mt-0.5 whitespace-pre-wrap break-words">{turn.userLine || '—'}</p>
                      </div>
                      {target === 'A' ? (
                        <>
                          <div className="border-l-2 border-blue-500/55 pl-2">
                            <span className="font-medium text-blue-700 dark:text-blue-400">Voice A</span>
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/95">
                              {String(turn.voiceA || '').trim() || '—'}
                            </p>
                          </div>
                          <div className="border-l-2 border-red-500/55 pl-2">
                            <span className="font-medium text-red-700 dark:text-red-400">Voice B</span>
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/95">
                              {String(turn.voiceB || '').trim() || '—'}
                            </p>
                          </div>
                        </>
                      ) : String(turn.voiceA || '').trim() ? (
                        <>
                          <div className="border-l-2 border-red-500/55 pl-2">
                            <span className="font-medium text-red-700 dark:text-red-400">Voice B</span>
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/95">
                              {String(turn.voiceB || '').trim() || '—'}
                            </p>
                          </div>
                          <div className="border-l-2 border-blue-500/55 pl-2">
                            <span className="font-medium text-blue-700 dark:text-blue-400">Voice A</span>
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/95">
                              {String(turn.voiceA || '').trim() || '—'}
                            </p>
                          </div>
                        </>
                      ) : (
                        <div className="border-l-2 border-red-500/55 pl-2">
                          <span className="font-medium text-red-700 dark:text-red-400">Voice B</span>
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/95">
                            {String(turn.voiceB || '').trim() || '—'}
                          </p>
                        </div>
                      )}
                    </div>
                  </li>
                );
                })}
                <li ref={dialogueEndRef} aria-hidden className="h-0 list-none p-0" />
              </ul>
            )}
          </div>
        </section>

        <div className="flex flex-col border-t border-border">
          <div className="shrink-0 border-b border-border/60 bg-background">
            <GraphPipelineStreamResumeBanners graphSessionId={resumeBannerSessionId} />
          </div>
          <div className="min-h-0 w-full">
            <GraphPipelineExecutionPanel systemChatTurnCount={dialogueTurns.length} />
          </div>
        </div>
      </div>
    </div>
  );
}

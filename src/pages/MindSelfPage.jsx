import { useCallback, useEffect, useState } from 'react';
import moment from 'moment';
import { Link } from 'react-router-dom';
import { Brain, Loader2, Moon, RefreshCw, Sparkles } from 'lucide-react';
import { Button, Textarea } from '../components/ui';
import {
  ConsolidationDigest,
  PipelineRun,
  SelfLedgerRevision,
  UserModelSnapshot,
  WorldModel,
} from '../lib/data';
import { runConsolidationPass } from '../lib/mindPersistence';
import { humanizeUnityRationaleForDisplay, normalizeWorldModelCategory } from '../lib/worldModelSchema';
import { useMindStorageRefresh } from '../lib/mindStorageEvents';
import { getRuntimeSettings } from '../lib/runtimeSettings';
import { cn } from '../lib/utils';

function Panel({ className, children }) {
  return <div className={cn('rounded-2xl border border-border bg-card p-4', className)}>{children}</div>;
}

export default function MindSelfPage() {
  const [ledger, setLedger] = useState([]);
  const [digests, setDigests] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [consolidating, setConsolidating] = useState(false);
  const [userModelPreview, setUserModelPreview] = useState(null);
  const [structuralSelf, setStructuralSelf] = useState([]);
  const [lastPhenomenal, setLastPhenomenal] = useState(null);
  const [lastGlobalWorkspace, setLastGlobalWorkspace] = useState(null);
  const [personality, setPersonality] = useState(() => getRuntimeSettings().personalityProfile || null);

  const load = useCallback(async () => {
    setLoading(true);
    const [l, d, s, wm, runs] = await Promise.all([
      SelfLedgerRevision.list('-created_date', 80),
      ConsolidationDigest.list('-created_date', 30),
      UserModelSnapshot.list('-created_date', 25),
      WorldModel.list('-updated_date', 80),
      PipelineRun.list('-created_date', 12),
    ]);
    setLedger(l);
    setDigests(d);
    setSnapshots(s);
    setUserModelPreview(getRuntimeSettings().userModel || null);
    setStructuralSelf(
      wm.filter(
        (row) => normalizeWorldModelCategory(row.category) === 'self' && !row.archived
      )
    );
    const pn = runs.find((r) => r.shared_memory?.phenomenalNow?.line);
    setLastPhenomenal(pn?.shared_memory?.phenomenalNow || null);
    const gwr = runs.find(
      (r) => r.shared_memory?.globalWorkspace && typeof r.shared_memory.globalWorkspace === 'object'
    );
    setLastGlobalWorkspace(gwr?.shared_memory?.globalWorkspace || null);
    setPersonality(snapshotPersonality());
    setLoading(false);
  }, []);

  function snapshotPersonality() {
    const p = getRuntimeSettings().personalityProfile;
    return p && typeof p === 'object' ? p : { version: 0, facets: [], relationalStance: null, systemTreatmentNotes: '' };
  }

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const onConsolidate = async () => {
    setConsolidating(true);
    try {
      await runConsolidationPass({ maxTokens: 1000 });
      await load();
    } catch (e) {
      console.error(e);
      alert(e?.message || 'Consolidation failed');
    } finally {
      setConsolidating(false);
    }
  };

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <Brain className="h-7 w-7 text-primary" />
            Self, rhythm & consolidation
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Append-only self-ledger from pipeline identity passes, default-mode (DMN) reflections, offline consolidation
            digests, and versioned snapshots of the user model (Theory of Mind). Recent runs may also surface{' '}
            <span className="font-mono text-[11px] text-foreground/80">globalWorkspace</span> (integration stance, broadcast
            winners, hypotheses) for continuity checks. This page is part of a{' '}
            <span className="text-foreground/90">cognitive lab</span> for continuity and self-modeling—not a claim that the LLM
            is conscious. Run consolidation after sleep-phase sessions or a burst of streams.
          </p>
        </div>

        <Panel className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Moon className="h-4 w-4 text-amber-400" />
            <span>Compress recent runs, chat, and memories into world-model hints + identity notes.</span>
          </div>
          <Button type="button" className="gap-2" disabled={consolidating} onClick={onConsolidate}>
            {consolidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Run consolidation
          </Button>
        </Panel>

        {userModelPreview ? (
          <Panel>
            <div className="text-sm font-semibold">Current user model (Settings)</div>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted/30 p-3 text-[11px] text-muted-foreground">
              {JSON.stringify(userModelPreview, null, 2)}
            </pre>
          </Panel>
        ) : null}

        <Panel>
          <div className="text-sm font-semibold">Personality traits (TRAIT_DELTA)</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Merged from Identity after each pipeline run. Facets steer Voice/Narrative tone; distinct from structural self rows
            in World Model. The model proposes updates with evidence each run.{' '}
            <Link to="/personality" className="font-medium text-primary underline-offset-2 hover:underline">
              Edit strengths, confidence, and facets on the Personality page
            </Link>
            .
          </p>
          {personality && Array.isArray(personality.facets) && personality.facets.length ? (
            <div className="mt-3 space-y-2">
              {personality.facets.map((f) => (
                <div
                  key={String(f.id || f.label)}
                  className="rounded-lg border border-border/80 bg-muted/10 p-3 text-xs"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <span className="font-medium text-foreground">{f.label || f.id}</span>
                      {typeof f.strength === 'number' ? (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          strength {Math.round(f.strength * 100)}%
                        </span>
                      ) : null}
                      {f.trigger ? (
                        <span className="ml-2 text-[10px] text-muted-foreground">via {String(f.trigger)}</span>
                      ) : null}
                      {f.updatedAt ? (
                        <span className="ml-2 text-[10px] text-muted-foreground">{moment(f.updatedAt).fromNow()}</span>
                      ) : null}
                    </div>
                  </div>
                  {f.evidence ? (
                    <p className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap">{f.evidence}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No facets stored yet — Identity will emit TRAIT_DELTA when the run completes.</p>
          )}
          {personality?.relationalStance && typeof personality.relationalStance === 'object' ? (
            <div className="mt-3 rounded-lg border border-dashed border-border/60 p-2 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">Relational stance: </span>
              {personality.relationalStance.towardUser || '—'}
              {personality.relationalStance.notes ? ` — ${personality.relationalStance.notes}` : ''}
            </div>
          ) : null}
          {personality?.systemTreatmentNotes ? (
            <p className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap">{personality.systemTreatmentNotes}</p>
          ) : null}
        </Panel>

        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-primary/40" />
          </div>
        ) : (
          <>
            <Panel>
              <div className="text-sm font-semibold">Structural self (world model, category self)</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Slow-updating constraints injected into Identity, Reasoning, Language, Narrative, and Voice on each pipeline
                run.
              </p>
              <div className="mt-3 space-y-2">
                {structuralSelf.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No structural self rows yet — add under World Model or via SELF_MODEL_DELTA.</p>
                ) : (
                  structuralSelf.map((row) => (
                    <div key={row.id} className="rounded-lg border border-border/80 bg-muted/10 p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="font-medium text-foreground">{row.label || row.name || '(untitled)'}</span>
                        {typeof row.confidence === 'number' ? (
                          <span>{Math.round(row.confidence * 100)}% conf</span>
                        ) : null}
                      </div>
                      {row.description ? (
                        <p className="mt-2 whitespace-pre-wrap text-foreground/90">
                          {humanizeUnityRationaleForDisplay(row.description)}
                        </p>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </Panel>

            <Panel>
              <div className="text-sm font-semibold">Global workspace snapshot (latest run)</div>
              <p className="mt-1 text-xs text-muted-foreground">
                From the Integration module&apos;s <span className="font-mono text-[10px]">INTEGRATION_JSON</span> on the most
                recent pipeline run that saved shared memory: what won broadcast access this turn (GWT), plus an
                IIT-inspired unity label—not literal Φ.
              </p>
              {lastGlobalWorkspace ? (
                <div className="mt-3 space-y-2 rounded-lg border border-border/80 bg-muted/10 p-3 text-xs">
                  <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                    {lastGlobalWorkspace.phenomenalUnity ? (
                      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-medium text-violet-200/90">
                        unity: {String(lastGlobalWorkspace.phenomenalUnity)}
                      </span>
                    ) : null}
                    {typeof lastGlobalWorkspace.integrationConfidence === 'number' ? (
                      <span>integration conf. {Math.round(lastGlobalWorkspace.integrationConfidence * 100)}%</span>
                    ) : null}
                  </div>
                  {Array.isArray(lastGlobalWorkspace.broadcastWinners) && lastGlobalWorkspace.broadcastWinners.length ? (
                    <div>
                      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Broadcast winners
                      </div>
                      <ul className="mt-1 list-inside list-disc text-foreground/90">
                        {lastGlobalWorkspace.broadcastWinners.slice(0, 4).map((w, i) => (
                          <li key={i}>{String(w)}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {lastGlobalWorkspace.unityRationale ? (
                    <p className="text-[11px] text-muted-foreground">
                      {humanizeUnityRationaleForDisplay(lastGlobalWorkspace.unityRationale)}
                    </p>
                  ) : null}
                  {lastGlobalWorkspace.provisionalStance ? (
                    <p className="mt-1 whitespace-pre-wrap text-foreground/85">{String(lastGlobalWorkspace.provisionalStance)}</p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  No saved global workspace yet — run Graph Pipeline and ensure the run is recorded locally.
                </p>
              )}
            </Panel>

            <Panel>
              <div className="text-sm font-semibold">Default mode &amp; embodied moment</div>
              <p className="mt-1 text-xs text-muted-foreground">
                The default mode network shapes internal narrative when attention is not fixed on a single external task;
                interoception (scalar signals in the pipeline) plays an insula-like role, anchoring the story in a felt sense
                of processing load, curiosity, and uncertainty. Together they approximate the blend of autobiographical story
                and embodied presence.
              </p>
              <div className="mt-3 rounded-lg border border-border/80 bg-muted/10 p-3 text-xs">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Latest phenomenal now (last pipeline run with a line)
                </div>
                {lastPhenomenal?.line ? (
                  <>
                    <p className="mt-2 text-sm text-foreground">{lastPhenomenal.line}</p>
                    {lastPhenomenal.rationale ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">{lastPhenomenal.rationale}</p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No phenomenal-now line stored yet — run Graph Pipeline or Stream.</p>
                )}
              </div>
              <div className="mt-3 space-y-2">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Recent DMN reflections (scheduled or manual)
                </div>
                {ledger.filter((r) => r.reason === 'dmn_internal_narrative').length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None yet. Queue <span className="font-mono text-foreground/80">dmn_reflection</span> under Scheduler → Self
                    &amp; identity.
                  </p>
                ) : (
                  ledger
                    .filter((r) => r.reason === 'dmn_internal_narrative')
                    .slice(0, 4)
                    .map((row) => (
                      <div key={row.id} className="rounded-lg border border-border/80 bg-muted/10 p-3 text-xs">
                        <div className="text-[10px] text-muted-foreground">
                          {row.created_date ? moment(row.created_date).fromNow() : ''} · {row.phase || 'drift'}
                        </div>
                        {row.summary ? <p className="mt-2 font-medium text-foreground">{row.summary}</p> : null}
                        {row.identity_excerpt ? (
                          <Textarea
                            readOnly
                            value={row.identity_excerpt}
                            className="mt-2 min-h-[80px] resize-none text-[11px]"
                          />
                        ) : null}
                      </div>
                    ))
                )}
              </div>
            </Panel>

            <Panel>
              <div className="text-sm font-semibold">Narrative self — ledger & consolidation</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Timeline of identity excerpts and digest summaries (autobiographical continuity). Each pipeline pass can append
                a ledger row: identity excerpt, phase, and latest metacognition calibration.
              </p>
              <div className="mt-4 space-y-3">
                {ledger.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No ledger entries yet — run Graph Pipeline or Stream.</p>
                ) : (
                  ledger.map((row) => (
                    <div key={row.id} className="rounded-lg border border-border/80 bg-muted/10 p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-primary">{row.reason}</span>
                        <span>{row.phase || '—'}</span>
                        <span className="ml-auto">{row.created_date ? moment(row.created_date).fromNow() : ''}</span>
                      </div>
                      {row.summary ? <p className="mt-2 font-medium text-foreground">{row.summary}</p> : null}
                      {row.identity_excerpt ? (
                        <Textarea readOnly value={row.identity_excerpt} className="mt-2 min-h-[72px] resize-none text-[11px]" />
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </Panel>

            <Panel>
              <div className="text-sm font-semibold">Consolidation digests</div>
              <p className="mt-1 text-xs text-muted-foreground">What changed while you were not watching.</p>
              <div className="mt-4 space-y-4">
                {digests.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No digests yet.</p>
                ) : (
                  digests.map((d) => (
                    <div key={d.id} className="rounded-lg border border-border/80 p-3">
                      <div className="text-[10px] text-muted-foreground">
                        {d.created_date ? moment(d.created_date).fromNow() : ''}
                        {d.model_used ? ` · ${d.model_used}` : ''}
                      </div>
                      {d.digest_summary ? (
                        <p className="mt-2 text-sm text-foreground/90">{d.digest_summary}</p>
                      ) : null}
                      <Textarea readOnly value={d.digest_text || ''} className="mt-2 min-h-[100px] resize-none text-[11px]" />
                    </div>
                  ))
                )}
              </div>
            </Panel>

            <Panel>
              <div className="text-sm font-semibold">User model snapshots</div>
              <div className="mt-3 space-y-2">
                {snapshots.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No snapshots — Theory of Mind will create these over time.</p>
                ) : (
                  snapshots.map((s) => (
                    <details key={s.id} className="rounded-lg border border-border/80 p-2">
                      <summary className="cursor-pointer text-xs font-medium">
                        v{s.version} · {s.created_date ? moment(s.created_date).fromNow() : ''}
                      </summary>
                      <pre className="mt-2 overflow-auto text-[10px] text-muted-foreground">
                        {JSON.stringify(s.model, null, 2)}
                      </pre>
                    </details>
                  ))
                )}
              </div>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

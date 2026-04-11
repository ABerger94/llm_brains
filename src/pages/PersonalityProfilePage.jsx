import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Fingerprint, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Label, Slider, Textarea } from '../components/ui';
import { getRuntimeSettings, saveRuntimeSettings } from '../lib/runtimeSettings';
import { cn } from '../lib/utils';

const MAX_FACETS = 24;
const TRIGGERS = ['user_tone', 'user_content', 'self_reflection', 'constitution_tension'];

function emptyProfile() {
  return {
    version: 0,
    facets: [],
    relationalStance: null,
    systemTreatmentNotes: '',
  };
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return emptyProfile();
  return {
    version: Number(raw.version) || 0,
    facets: Array.isArray(raw.facets) ? raw.facets.map((f) => ({ ...f })) : [],
    relationalStance:
      raw.relationalStance && typeof raw.relationalStance === 'object'
        ? { ...raw.relationalStance }
        : null,
    systemTreatmentNotes: String(raw.systemTreatmentNotes || ''),
    suppressBundledPersonalityDefaults: raw.suppressBundledPersonalityDefaults === true,
  };
}

function clamp01(v, fallback = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** UUID when `crypto.randomUUID` exists (secure context); fallback for HTTP / older mobile. */
function newManualFacetId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `manual_${crypto.randomUUID()}`;
    }
  } catch {
    /* ignore */
  }
  return `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

function Panel({ className, children }) {
  return <div className={cn('rounded-2xl border border-border bg-card p-4', className)}>{children}</div>;
}

export default function PersonalityProfilePage() {
  const [profile, setProfile] = useState(() => normalizeProfile(getRuntimeSettings().personalityProfile));
  const pendingScrollFacetIdRef = useRef(null);

  useEffect(() => {
    function syncFromStorage() {
      setProfile(normalizeProfile(getRuntimeSettings().personalityProfile));
    }
    syncFromStorage();
    const onPageShow = (e) => {
      if (e.persisted) syncFromStorage();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const commit = useCallback((next) => {
    const merged = {
      ...next,
      version: (Number(next.version) || 0) + 1,
    };
    saveRuntimeSettings({ personalityProfile: merged });
    setProfile(merged);
  }, []);

  const updateFacets = useCallback(
    (facets) => {
      commit({ ...profile, facets });
    },
    [profile, commit]
  );

  const patchFacet = useCallback(
    (index, patch) => {
      const facets = [...(profile.facets || [])];
      if (!facets[index]) return;
      facets[index] = { ...facets[index], ...patch };
      updateFacets(facets);
    },
    [profile.facets, updateFacets]
  );

  const removeFacet = useCallback(
    (index) => {
      const facets = (profile.facets || []).filter((_, i) => i !== index);
      const next = { ...profile, facets };
      if (facets.length === 0) next.suppressBundledPersonalityDefaults = true;
      commit(next);
    },
    [profile, commit]
  );

  const addFacet = useCallback(() => {
    setProfile((prev) => {
      const facets = [...(prev.facets || [])];
      if (facets.length >= MAX_FACETS) return prev;
      const id = newManualFacetId();
      pendingScrollFacetIdRef.current = id;
      facets.unshift({
        id,
        label: 'New trait',
        strength: 0.5,
        confidence: 0.5,
        evidence: '',
        trigger: 'self_reflection',
        updatedAt: new Date().toISOString(),
      });
      const next = {
        ...prev,
        facets,
        version: (Number(prev.version) || 0) + 1,
      };
      saveRuntimeSettings({ personalityProfile: next });
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const id = pendingScrollFacetIdRef.current;
    if (!id) return;
    pendingScrollFacetIdRef.current = null;
    const el = document.getElementById(`facet-card-${id}`);
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth', inline: 'nearest' });
    }
  }, [profile.facets]);

  const relational = profile.relationalStance && typeof profile.relationalStance === 'object' ? profile.relationalStance : {};

  const setRelational = useCallback(
    (patch) => {
      commit({
        ...profile,
        relationalStance: {
          towardUser: relational.towardUser ?? '',
          notes: relational.notes ?? '',
          confidence: relational.confidence,
          ...patch,
        },
      });
    },
    [profile, relational, commit]
  );

  const setSystemNotes = useCallback(
    (systemTreatmentNotes) => {
      commit({ ...profile, systemTreatmentNotes });
    },
    [profile, commit]
  );

  const resetAll = useCallback(() => {
    if (!window.confirm('Clear all personality facets, relational stance, and notes? This cannot be undone.')) return;
    const cleared = emptyProfile();
    saveRuntimeSettings({ personalityProfile: cleared });
    setProfile(cleared);
  }, []);

  const facetCount = profile.facets?.length ?? 0;

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <Fingerprint className="h-7 w-7 text-primary" />
            Personality profile
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manual facets and strengths feed{' '}
            <span className="font-mono text-[11px] text-foreground/80">PERSONALITY_PROFILE_JSON</span> in pipeline prompts
            (Identity, Integration, Language, Narrative, Voice, Metacognition, Workspace Metacognition). Structural self stays in World Model (
            <span className="font-mono text-[11px]">SELF_MODEL_DELTA</span>). Each graph/stream run, Identity can merge a{' '}
            <span className="font-mono text-[11px]">TRAIT_DELTA</span> on top of what you set here.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/mind-self"
            className={cn(
              'inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            )}
          >
            Self & consolidation
          </Link>
          <Button type="button" variant="destructive" size="sm" onClick={resetAll}>
            Reset entire profile
          </Button>
        </div>

        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold">Traits ({facetCount} / {MAX_FACETS})</div>
            <Button type="button" size="sm" className="gap-1" onClick={addFacet} disabled={facetCount >= MAX_FACETS}>
              <Plus className="h-3.5 w-3.5" />
              Add facet
            </Button>
          </div>
          {facetCount === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No facets yet — add one or run the pipeline so Identity emits TRAIT_DELTA.</p>
          ) : (
            <ul className="mt-4 space-y-6">
              {(profile.facets || []).map((f, i) => (
                <li
                  id={f.id ? `facet-card-${f.id}` : undefined}
                  key={String(f.id || i)}
                  className="rounded-xl border border-border/80 bg-muted/10 p-4 scroll-mt-24 md:scroll-mt-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="grid w-full min-w-0 gap-3 sm:max-w-md">
                      <div>
                        <Label className="text-xs text-muted-foreground">Label</Label>
                        <Input
                          className="mt-1"
                          value={String(f.label ?? '')}
                          onChange={(e) => patchFacet(i, { label: e.target.value.slice(0, 80), updatedAt: new Date().toISOString() })}
                        />
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => removeFacet(i)}
                      aria-label="Remove trait"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-xs text-muted-foreground">Strength (0–1)</Label>
                        <span className="font-mono text-xs text-foreground">{clamp01(f.strength, 0.5).toFixed(2)}</span>
                      </div>
                      <Slider
                        className="mt-2 accent-primary"
                        min={0}
                        max={1}
                        step={0.01}
                        value={clamp01(f.strength, 0.5)}
                        onChange={(vals) => patchFacet(i, { strength: clamp01(vals[0], 0.5), updatedAt: new Date().toISOString() })}
                      />
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        className="mt-2 font-mono text-xs"
                        value={clamp01(f.strength, 0.5)}
                        onChange={(e) =>
                          patchFacet(i, { strength: clamp01(e.target.value, 0.5), updatedAt: new Date().toISOString() })
                        }
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-xs text-muted-foreground">Confidence (0–1)</Label>
                        <span className="font-mono text-xs text-foreground">{clamp01(f.confidence, 0.5).toFixed(2)}</span>
                      </div>
                      <Slider
                        className="mt-2 accent-primary"
                        min={0}
                        max={1}
                        step={0.01}
                        value={clamp01(f.confidence, 0.5)}
                        onChange={(vals) => patchFacet(i, { confidence: clamp01(vals[0], 0.5), updatedAt: new Date().toISOString() })}
                      />
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        className="mt-2 font-mono text-xs"
                        value={clamp01(f.confidence, 0.5)}
                        onChange={(e) =>
                          patchFacet(i, { confidence: clamp01(e.target.value, 0.5), updatedAt: new Date().toISOString() })
                        }
                      />
                    </div>
                  </div>

                  <div className="mt-4">
                    <Label className="text-xs text-muted-foreground">Trigger</Label>
                    <select
                      className="mt-1 flex h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
                      value={TRIGGERS.includes(String(f.trigger)) ? String(f.trigger) : 'self_reflection'}
                      onChange={(e) => patchFacet(i, { trigger: e.target.value, updatedAt: new Date().toISOString() })}
                    >
                      {TRIGGERS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-4">
                    <Label className="text-xs text-muted-foreground">Evidence</Label>
                    <Textarea
                      className="mt-1 min-h-[72px] text-sm"
                      value={String(f.evidence ?? '')}
                      onChange={(e) => patchFacet(i, { evidence: e.target.value.slice(0, 400), updatedAt: new Date().toISOString() })}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <div className="text-sm font-semibold">Relational stance</div>
          <p className="mt-1 text-xs text-muted-foreground">Optional notes on how this mind relates to you (the user).</p>
          <div className="mt-4 grid gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">Toward user</Label>
              <Input
                className="mt-1"
                value={String(relational.towardUser ?? '')}
                onChange={(e) => setRelational({ towardUser: e.target.value.slice(0, 120) })}
                placeholder="e.g. cautious_warmth"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Notes</Label>
              <Textarea
                className="mt-1 text-sm"
                value={String(relational.notes ?? '')}
                onChange={(e) => setRelational({ notes: e.target.value.slice(0, 400) })}
              />
            </div>
            <div>
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs text-muted-foreground">Confidence (0–1)</Label>
                <span className="font-mono text-xs">
                  {relational.confidence != null && Number.isFinite(relational.confidence)
                    ? clamp01(relational.confidence).toFixed(2)
                    : '—'}
                </span>
              </div>
              <Slider
                className="mt-2 accent-primary"
                min={0}
                max={1}
                step={0.01}
                value={relational.confidence != null && Number.isFinite(relational.confidence) ? clamp01(relational.confidence) : 0.5}
                onChange={(vals) => setRelational({ confidence: clamp01(vals[0], 0.5) })}
              />
            </div>
          </div>
        </Panel>

        <Panel>
          <div className="text-sm font-semibold">System treatment notes</div>
          <p className="mt-1 text-xs text-muted-foreground">Bounded notes on how recent tone from the user landed (optional).</p>
          <Textarea
            className="mt-3 min-h-[88px] text-sm"
            value={String(profile.systemTreatmentNotes ?? '')}
            onChange={(e) => setSystemNotes(e.target.value.slice(0, 800))}
          />
        </Panel>

        <p className="text-center text-xs text-muted-foreground">Profile version {profile.version}</p>
      </div>
    </div>
  );
}

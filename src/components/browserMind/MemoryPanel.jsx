import { useState } from 'react';
import { timeAgo } from '../../lib/browserMindMemory';

export default function MemoryPanel({ identityNarrative, episodes, onForget }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);

  const hasMemory = identityNarrative.length > 0 || episodes.length > 0;
  const recent = [...episodes].reverse();
  const visible = expanded ? recent : recent.slice(0, 3);
  const nextSessionNumber = episodes.length + 1;

  function handleForgetClick() {
    if (confirmingForget) {
      onForget();
      setConfirmingForget(false);
    } else {
      setConfirmingForget(true);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Persistent memory · Session #{nextSessionNumber}
        </h2>
        {hasMemory && (
          <button
            type="button"
            onClick={handleForgetClick}
            onBlur={() => setConfirmingForget(false)}
            className="text-[11px] text-muted-foreground hover:text-destructive"
          >
            {confirmingForget ? 'Click again to forget everything' : 'Forget everything'}
          </button>
        )}
      </div>

      {!hasMemory ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No memory yet — this mind hasn't experienced anything. Run the pipeline below and it
          will start accumulating an identity narrative and episodic memory that persists across
          sessions in this browser's IndexedDB.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {identityNarrative && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-violet-400">Identity</div>
              <p className="mt-1 text-sm leading-relaxed text-foreground/90">{identityNarrative}</p>
            </div>
          )}

          {episodes.length > 0 && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Episodic memory ({episodes.length})
              </div>
              <ul className="mt-1 flex flex-col gap-2">
                {visible.map((ep) => (
                  <li key={ep.id} className="rounded-lg border border-border/60 bg-background/40 p-2 text-xs">
                    <div className="text-muted-foreground">
                      Session #{ep.sessionNumber} · {timeAgo(ep.timestamp)}
                    </div>
                    <div className="mt-0.5 text-foreground/80">
                      <span className="text-muted-foreground">Faced:</span> {ep.stimulus}
                    </div>
                    <div className="mt-0.5 text-foreground/80">
                      <span className="text-muted-foreground">Concluded:</span> {ep.reasoning}
                    </div>
                  </li>
                ))}
              </ul>
              {episodes.length > 3 && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {expanded ? 'Show less' : `Show all ${episodes.length}`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

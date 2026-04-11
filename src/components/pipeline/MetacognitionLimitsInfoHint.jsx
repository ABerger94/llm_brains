import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Compact info icon; full text in a panel on hover (desktop) or tap (touch), with click-outside to dismiss.
 */
export default function MetacognitionLimitsInfoHint({ children, className = '' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative inline-flex shrink-0 items-end self-end pb-0.5',
        /* Full-width row on narrow screens so the panel can center under the row, not only under the icon. */
        'max-md:basis-full max-md:justify-center',
        className
      )}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="rounded-full p-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-label="About supervisor rerun limits"
        onMouseEnter={() => setOpen(true)}
        onClick={() => setOpen((v) => !v)}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open ? (
        <div
          className={cn(
            'absolute z-[60] w-[min(100vw-2rem,20rem)]',
            /* Mobile / collapsed layout: open upward so reruns + delay inputs stay visible. */
            'max-md:bottom-full max-md:top-auto max-md:pb-1 max-md:pt-0',
            /* md+: below the icon, bridge padding for hover path to panel. */
            'md:top-full md:bottom-auto md:pt-1 md:pb-0',
            /* Mobile: centered in row; md+: align to icon on the right. */
            'left-1/2 -translate-x-1/2 md:left-auto md:right-0 md:translate-x-0'
          )}
          role="tooltip"
          onMouseEnter={() => setOpen(true)}
        >
          <div className="rounded-md border border-border bg-background p-2.5 text-[10px] leading-relaxed text-foreground shadow-md">
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}

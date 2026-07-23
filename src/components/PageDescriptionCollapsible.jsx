import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Page intro text: collapsed to two lines with a dashboard-style control when content overflows.
 */
export default function PageDescriptionCollapsible({ children, className, maxWidthClass = 'max-w-2xl' }) {
  const [open, setOpen] = useState(false);
  const [needsToggle, setNeedsToggle] = useState(false);
  const contentRef = useRef(null);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const run = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      if (open) {
        setNeedsToggle(el.scrollHeight > lh * 2 + 2);
      } else {
        setNeedsToggle(el.scrollHeight > el.clientHeight + 1);
      }
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children, open]);

  if (children == null || children === false) return null;

  return (
    <div className={cn(maxWidthClass, 'min-w-0', className)}>
      <div
        ref={contentRef}
        className={cn('text-sm text-muted-foreground leading-relaxed', !open && 'line-clamp-2')}
      >
        {children}
      </div>
      {needsToggle ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="mt-1.5 flex w-full max-w-full items-start gap-2 rounded-md py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground sm:items-center"
        >
          <ChevronDown
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 transition-transform duration-200 sm:mt-0',
              open && 'rotate-180'
            )}
            aria-hidden
          />
          <span>{open ? 'Hide description' : 'Show full description'}</span>
        </button>
      ) : null}
    </div>
  );
}

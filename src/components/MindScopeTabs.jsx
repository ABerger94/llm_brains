import { Link, useLocation } from 'react-router-dom';
import { cn } from '../lib/utils';
import { mirrorToPrimaryPath, pathnameHasMindMirror, primaryToMirrorPath } from '../lib/mindScopePaths';

/**
 * Primary | System B tabs for mind pages. Paths must follow /section/mirror(/...)? convention.
 */
export default function MindScopeTabs({ className }) {
  const { pathname } = useLocation();
  const isMirror = pathnameHasMindMirror(pathname);
  const primaryPath = mirrorToPrimaryPath(pathname);
  const mirrorPath = primaryToMirrorPath(pathname);

  return (
    <div
      className={cn(
        'inline-flex max-w-full min-w-0 rounded-lg border border-border bg-muted/30 p-0.5 text-xs font-medium',
        className
      )}
      role="tablist"
      aria-label="Mind scope"
    >
      <Link
        to={primaryPath}
        role="tab"
        aria-selected={!isMirror}
        className={cn(
          'rounded-md px-3 py-1.5 transition-colors',
          !isMirror ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        Primary
      </Link>
      <Link
        to={mirrorPath}
        role="tab"
        aria-selected={isMirror}
        className={cn(
          'rounded-md px-3 py-1.5 transition-colors',
          isMirror ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        System B
      </Link>
    </div>
  );
}

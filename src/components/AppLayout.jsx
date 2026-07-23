import { Component, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Brain, Menu, X } from 'lucide-react';
import { getAppNavSidebarGroups, getAppNavTitle } from '../lib/appSiteMap';
import { DASHBOARD_HEADING, PRODUCT_NAME } from '../lib/productBranding';
import { MindScopeProvider } from '../context/MindScopeContext';
import { cn } from '../lib/utils';
import { startScheduledTaskRunner } from '../lib/scheduledTaskRunner';
import { startReconnectRecoveryLoop } from '../lib/reconnectRecovery';
import { installCooperativePauseBroadcastListener } from '../lib/pipelinePauseBroadcast';
import { startMindSnapshotAutoPush } from '../lib/mindSnapshotAutoPush';
import { startMindSnapshotRemotePoll } from '../lib/mindSnapshotRemotePoll';

/** Catches render errors from route pages so the shell (sidebar) stays visible. */
class OutletErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="p-6 text-foreground">
          <p className="font-medium text-destructive">This page failed to render.</p>
          <pre className="mt-3 max-h-[40svh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            {String(error?.message || error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * The backend-free Vercel build (see vite.config.js / vercel.json) has no Express
 * server, so nothing below that talks to /api/* (scheduler polling, reconnect
 * probes, mind-snapshot sync, cross-tab pause broadcast) can do anything useful
 * there — skip mounting them entirely rather than let them fail/retry forever.
 */
const BROWSER_ONLY = import.meta.env.VITE_BROWSER_ONLY === '1';

export default function AppLayout() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mainScrollRef = useRef(null);
  const prevPathnameRef = useRef(location.pathname);

  useEffect(() => {
    if (BROWSER_ONLY) return;
    startScheduledTaskRunner();
    startReconnectRecoveryLoop();
  }, []);

  /** Auto-push mind snapshot every 10m when Dashboard sync token is set (tab must stay open). */
  useEffect(() => {
    if (BROWSER_ONLY) return undefined;
    return startMindSnapshotAutoPush();
  }, []);

  /** Poll server snapshot; auto-pull + reload when another device pushed a newer blob. */
  useEffect(() => {
    if (BROWSER_ONLY) return undefined;
    return startMindSnapshotRemotePoll();
  }, []);

  /** Cross-tab “Pause & save all”: other windows POST pause tokens when they receive the broadcast. */
  useEffect(() => {
    if (BROWSER_ONLY) return undefined;
    const uninstall = installCooperativePauseBroadcastListener();
    return uninstall;
  }, []);

  useEffect(() => {
    const page = getAppNavTitle(location.pathname);
    const suffix = location.pathname === '/' ? DASHBOARD_HEADING : PRODUCT_NAME;
    document.title = `${page} · ${suffix}`;
  }, [location.pathname]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  /** Keep scroll inside <main>; only reset when switching routes (not on clicks / search / hash). */
  useLayoutEffect(() => {
    if (prevPathnameRef.current !== location.pathname) {
      prevPathnameRef.current = location.pathname;
      const el = mainScrollRef.current;
      if (el) el.scrollTop = 0;
    }
  }, [location.pathname]);

  const groups = getAppNavSidebarGroups();

  const navBody = (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15">
          <Brain className="h-5 w-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 font-semibold leading-tight text-foreground">{PRODUCT_NAME}</div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Main">
        {groups.map((group) => (
          <div key={group.id} className="mb-4">
            {group.heading ? (
              <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.heading}
              </div>
            ) : null}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      end={item.path === '/'}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                        )
                      }
                    >
                      <Icon className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
                      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                        <span className="truncate">{item.label}</span>
                      </span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-background md:hidden">
        <div className="flex h-14 items-center gap-2 px-3">
          <button
            type="button"
            className="inline-flex h-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground touch-manipulation"
            onClick={() => setMobileOpen((o) => !o)}
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {getAppNavTitle(location.pathname)}
          </span>
        </div>
      </header>

      {mobileOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'fixed bottom-0 left-0 top-14 flex w-[min(100%,16rem)] flex-col border-r border-border bg-card md:static md:z-0 md:top-auto md:h-full md:min-h-0 md:w-56 md:shrink-0 lg:w-64',
          /* Open drawer above scrim; closed below <main> so scroll content paints */
          mobileOpen ? 'z-50' : 'z-10',
          /* Closed: opacity-0 avoids fixed layer compositing over <main> */
          'transform transition-[transform,opacity] duration-200 ease-out md:translate-x-0 md:opacity-100',
          mobileOpen ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0 md:translate-x-0',
          /* Offscreen drawer should not intercept taps */
          !mobileOpen && 'pointer-events-none md:pointer-events-auto'
        )}
      >
        {navBody}
      </aside>

      <main
        ref={mainScrollRef}
        className={cn(
          /* min-h-0: flex scrollport — without it overflow-y breaks on mobile WebKit */
          'relative isolate z-20 flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-y-contain bg-background pb-[env(safe-area-inset-bottom,0px)] [-webkit-overflow-scrolling:touch]',
          'text-foreground'
        )}
      >
        <MindScopeProvider>
          {/*
            flex-1 + min-h-0 on <main> lets this column fill the scrollport inside the shell (#root).
          */}
          <div className="relative isolate flex w-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
            <OutletErrorBoundary key={location.pathname}>
              <Outlet />
            </OutletErrorBoundary>
          </div>
        </MindScopeProvider>
      </main>
    </div>
  );
}

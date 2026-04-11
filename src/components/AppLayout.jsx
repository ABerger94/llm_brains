import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Brain, Menu, X } from 'lucide-react';
import { getAppNavSidebarGroups, getAppNavTitle } from '../lib/appSiteMap';
import { cn } from '../lib/utils';

export default function AppLayout() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.title = `${getAppNavTitle(location.pathname)} · YourBrain`;
  }, [location.pathname]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const groups = getAppNavSidebarGroups();

  const navBody = (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15">
          <Brain className="h-5 w-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 font-semibold leading-tight text-foreground">YourBrain</div>
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
                      <span className="truncate">{item.label}</span>
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
    <div className="flex min-h-screen flex-col md:flex-row">
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-background/95 backdrop-blur md:hidden pt-[env(safe-area-inset-top,0px)]">
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
          'fixed bottom-0 left-0 top-[calc(3.5rem+env(safe-area-inset-top,0px))] z-50 flex w-[min(100%,16rem)] flex-col border-r border-border bg-card md:static md:z-0 md:top-auto md:h-auto md:min-h-screen md:w-56 md:shrink-0 lg:w-64',
          'transform transition-transform duration-200 ease-out md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        {navBody}
      </aside>

      <main className="min-h-0 min-w-0 flex-1 bg-background">
        <Outlet />
      </main>
    </div>
  );
}

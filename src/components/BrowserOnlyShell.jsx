import { Laptop } from 'lucide-react';
import { PRODUCT_NAME } from '../lib/productBranding';

/**
 * Minimal chrome for the browser-only (Vercel) build — deliberately skips
 * AppLayout: that component's effects (scheduledTaskRunner, reconnectRecovery,
 * mindSnapshotAutoPush/RemotePoll, pipelinePauseBroadcast) all call /api/*
 * endpoints served by this app's Express backend, which doesn't exist on a
 * static, backend-free deployment. See App.jsx's VITE_BROWSER_ONLY branch.
 */
export default function BrowserOnlyShell({ children }) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15">
          <Laptop className="h-5 w-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 font-semibold leading-tight text-foreground">{PRODUCT_NAME} · Browser Mind</div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

import { Link } from 'react-router-dom';
import { FlaskConical, GitBranch } from 'lucide-react';
import { cn } from '../lib/utils';
import PageDescriptionCollapsible from '../components/PageDescriptionCollapsible';

const linkBtn =
  'inline-flex w-full items-center gap-3 rounded-md px-4 py-4 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/**
 * Legacy `/multi-mind` URL: the advocate/skeptic/synthesizer page was removed.
 * Send people to structured graph runs vs ad-hoc module play.
 */
export default function MultiMindRedirectPage() {
  return (
    <div className="flex w-full min-h-0 flex-1 flex-col bg-background p-4 sm:p-6">
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-bold text-foreground">Multi-Mind is retired</h1>
        <PageDescriptionCollapsible className="mt-3" maxWidthClass="max-w-none">
          This app no longer runs the separate advocate / skeptic / synthesizer flow. Use Graph Pipeline for full pipeline
          runs, or System Chat for ad-hoc modules. For a complete list of URLs (including this legacy path), open{' '}
          <Link to="/user-manual" className="text-primary underline-offset-2 hover:underline">
            User Manual
          </Link>{' '}
          → Site index.
        </PageDescriptionCollapsible>
        <div className="mt-8 flex flex-col gap-3">
          <Link
            to="/graph-pipeline"
            className={cn(linkBtn, 'bg-primary text-primary-foreground hover:bg-primary/90')}
          >
            <GitBranch className="h-5 w-5 shrink-0 opacity-95" />
            <span className="text-left">
              <span className="block font-semibold">Graph Pipeline</span>
              <span className="mt-0.5 block text-xs font-normal opacity-90">
                Full six-layer graph: Metacognition / Workspace Metacognition, Integration (GWT), SSE transcript
              </span>
            </span>
          </Link>
          <Link
            to="/playground"
            className={cn(
              linkBtn,
              'border border-input bg-background hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <FlaskConical className="h-5 w-5 shrink-0 text-primary" />
            <span className="text-left">
              <span className="block font-semibold">System Chat</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                Dual sequential graph pipelines (primary + mirror mind), not the old single-prompt module loop
              </span>
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}

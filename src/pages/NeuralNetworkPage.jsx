import { Brain } from 'lucide-react';
import PageShell from '../components/PageShell';
import NeuralNetworkViz from '../components/NeuralNetworkViz';

export default function NeuralNetworkPage() {
  return (
    <PageShell
      icon={Brain}
      title="Neural Network"
      description="Visualization of the cognitive module ring (same component as the Dashboard)."
    >
      <div className="min-h-[min(70svh,520px)] rounded-2xl border border-border bg-card/30 p-4">
        <NeuralNetworkViz className="h-full min-h-[400px] w-full" />
      </div>
    </PageShell>
  );
}

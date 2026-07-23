import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '../ui';
import { prepareNewGraphPipelineSession } from '../../lib/graphPipelineSessionRegistry';
import { setGraphWorkspaceMindSessionStorage } from '../../lib/graphSessionMindProfile';
import {
  MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
  MIND_STORAGE_PROFILE_PRIMARY,
} from '../../lib/mindEntityContext';
import { PLAYGROUND_SYSTEM_LABEL_A, PLAYGROUND_SYSTEM_LABEL_B } from '../../lib/playgroundDualMind';
import { cn } from '../../lib/utils';

/**
 * Mind picker + navigate to a new `/graph-pipeline/:id` workspace (primary vs mirror store).
 */
export default function NewGraphWorkspaceControl({ className }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(MIND_STORAGE_PROFILE_PRIMARY);

  const go = () => {
    const id = prepareNewGraphPipelineSession({ mindStorageProfile: profile });
    setGraphWorkspaceMindSessionStorage(id, profile);
    const enc = encodeURIComponent(id);
    navigate(
      profile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR
        ? `/graph-pipeline/mirror/${enc}`
        : `/graph-pipeline/${enc}`
    );
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="whitespace-nowrap font-medium text-foreground/90">Mind</span>
        <select
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          className="h-9 max-w-[min(100%,14rem)] rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground"
          aria-label="Mind store for new workspace"
        >
          <option value={MIND_STORAGE_PROFILE_PRIMARY}>{PLAYGROUND_SYSTEM_LABEL_A}</option>
          <option value={MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}>{PLAYGROUND_SYSTEM_LABEL_B}</option>
        </select>
      </label>
      <Button type="button" className="h-9 gap-2" onClick={go}>
        <Plus className="h-4 w-4" aria-hidden />
        New workspace
      </Button>
    </div>
  );
}

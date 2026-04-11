import { useState } from 'react';
import { Paperclip, X, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { prepareFilesForUpload } from '../../lib/imageUploadPrep';

/**
 * Local attach control: any file types; images are resized client-side. Upload runs when the pipeline runs.
 */
export default function FileAttachButton({
  pendingFiles = [],
  onPendingFilesChange,
  attachments = [],
  onRemoveAttachment,
  disabled = false,
  className,
}) {
  const [preparing, setPreparing] = useState(false);

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <label
        title={preparing ? 'Preparing files…' : 'Attach files'}
        aria-label={preparing ? 'Preparing files' : 'Attach files'}
        className={cn(
          'inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-muted/30 text-foreground transition-colors hover:bg-muted/50',
          (disabled || preparing) && 'pointer-events-none opacity-50'
        )}
      >
        {preparing ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <Paperclip className="h-4 w-4 text-muted-foreground" aria-hidden />
        )}
        <input
          type="file"
          multiple
          className="hidden"
          disabled={disabled || preparing}
          onChange={async (e) => {
            const raw = Array.from(e.target.files || []);
            e.target.value = '';
            if (!raw.length) return;
            setPreparing(true);
            try {
              const prepared = await prepareFilesForUpload(raw);
              onPendingFilesChange?.([...pendingFiles, ...prepared]);
            } finally {
              setPreparing(false);
            }
          }}
        />
      </label>
      {pendingFiles.map((f, idx) => (
        <span
          key={`${f.name}-${f.lastModified}-${idx}`}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-muted/20 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {f.name}
          {onPendingFilesChange ? (
            <button
              type="button"
              disabled={disabled || preparing}
              className="rounded p-0.5 hover:bg-muted"
              onClick={() => onPendingFilesChange(pendingFiles.filter((_, i) => i !== idx))}
              aria-label={`Remove ${f.name} from pending`}
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      ))}
      {attachments.map((a) => (
        <span
          key={a.id}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {a.filename}
          {onRemoveAttachment ? (
            <button
              type="button"
              disabled={disabled}
              className="rounded p-0.5 hover:bg-muted"
              onClick={() => onRemoveAttachment(a.id)}
              aria-label={`Remove ${a.filename}`}
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

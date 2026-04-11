/**
 * Opens an idle pursuit pipeline slot so per-run metacognition limits can be set before Pursue.
 */
export default function PursuitPipelinePrepSelect({
  idPrefix,
  label,
  helperText,
  candidates,
  formatOption,
  onPick,
  disabled,
}) {
  const list = Array.isArray(candidates) ? candidates : [];
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-primary/35 bg-muted/10 px-3 py-2.5">
      <p className="text-[11px] leading-snug text-muted-foreground">{helperText}</p>
      <label className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground" htmlFor={`${idPrefix}-prep-select`}>
        {label}
      </label>
      <select
        id={`${idPrefix}-prep-select`}
        className="w-full max-w-lg rounded-md border border-input bg-background px-2 py-2 text-xs text-foreground shadow-sm"
        value=""
        disabled={disabled || list.length === 0}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const picked = list.find((x) => String(x.id) === v);
          if (picked) onPick(picked);
          e.target.value = '';
        }}
      >
        <option value="">{list.length === 0 ? 'No open items' : 'Select…'}</option>
        {list.map((item) => (
          <option key={item.id} value={String(item.id)}>
            {formatOption(item)}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function RerunLog({ events }) {
  if (events.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-500">Rerun activity</div>
      <ul className="flex flex-col gap-1.5">
        {events.map((event, i) => (
          <li key={i} className="text-xs text-amber-600 dark:text-amber-200/90">
            <span className="text-amber-500">
              {event.type === 'contradiction' ? 'Contradiction Engine — ' : 'Metacognition — '}
            </span>
            {event.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

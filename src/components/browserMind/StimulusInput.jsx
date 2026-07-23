import { useState } from 'react';
import { Button, Textarea } from '../ui';

const EXAMPLES = [
  'Your phone buzzes with a text from your boss at 11pm: "We need to talk tomorrow."',
  'You find a wallet full of cash on the sidewalk with no ID inside.',
  'A close friend cancels plans with you for the third time this month.',
];

export default function StimulusInput({ disabled, isRunning, onRun, onStop }) {
  const [text, setText] = useState('');

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Stimulus
      </label>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Describe something the mind perceives — an event, a message, a scene…"
        rows={3}
        className="resize-none text-sm"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setText(ex)}
            className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
          >
            {ex.length > 40 ? ex.slice(0, 40) + '…' : ex}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {!isRunning ? (
          <Button
            type="button"
            disabled={disabled || text.trim().length === 0}
            onClick={() => onRun(text.trim())}
          >
            Run 22-module pipeline
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onStop}>
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

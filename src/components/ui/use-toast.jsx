import React from 'react';
import { cn } from '../../lib/utils';

let toastCallbacks = [];

const addToastListener = (callback) => {
  toastCallbacks.push(callback);
  return () => {
    toastCallbacks = toastCallbacks.filter((cb) => cb !== callback);
  };
};

export const toast = ({ title, description, variant = 'default' }) => {
  const id = Math.random().toString(36);
  const toastData = { id, title, description, variant };
  toastCallbacks.forEach((cb) => cb(toastData));

  setTimeout(() => {
    toastCallbacks.forEach((cb) => cb({ id, remove: true }));
  }, variant === 'destructive' ? 8000 : 4000);
};

export const useToast = () => {
  const [toasts, setToasts] = React.useState([]);

  React.useEffect(() => {
    return addToastListener((toastData) => {
      if (toastData.remove) {
        setToasts((prev) => prev.filter((t) => t.id !== toastData.id));
      } else {
        setToasts((prev) => [...prev, toastData]);
      }
    });
  }, []);

  return { toasts, toast };
};

/** Mount once under the app root so {@link toast} calls actually render. */
export function ToastViewport() {
  const { toasts } = useToast();
  return (
    <div
      className="pointer-events-none fixed bottom-0 right-0 z-[200] flex w-max max-w-[min(28rem,calc(100vw-2rem))] flex-col items-end gap-2 p-4 sm:p-6"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto rounded-lg border px-3 py-2.5 text-sm shadow-md backdrop-blur-sm',
            t.variant === 'destructive'
              ? 'border-destructive/50 bg-destructive/15 text-destructive'
              : 'border-border bg-card/95 text-foreground'
          )}
        >
          <div className="font-semibold leading-snug">{t.title}</div>
          {t.description ? (
            <div className="mt-1 text-xs leading-relaxed opacity-90">{t.description}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { flushKvWrites, openAndMigrateBrowserStorage } from './lib/browserStorage';

async function boot() {
  try {
    await openAndMigrateBrowserStorage();
  } catch (e) {
    console.error('IndexedDB bootstrap failed:', e);
  }

  const { default: App } = await import('./App.jsx');

  window.addEventListener('pagehide', () => {
    void flushKvWrites();
  });

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  // Defer priority backfill until after first paint to avoid jank on cold start.
  const schedule = typeof requestIdleCallback === 'function' ? requestIdleCallback : (fn) => setTimeout(fn, 200);
  schedule(async () => {
    try {
      const { runPriorityQueueBackfillOnce } = await import('./lib/priorityBackfill.js');
      await runPriorityQueueBackfillOnce();
    } catch (e) {
      console.warn('Priority queue backfill skipped:', e);
    }
  });
}

void boot();

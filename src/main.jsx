import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { flushKvWrites, openAndMigrateBrowserStorage } from './lib/browserStorage';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const r of regs) r.unregister();
  });
}

const STORAGE_BOOT_TIMEOUT_MS = 5000;

async function boot() {
  const storageBoot = openAndMigrateBrowserStorage().catch((e) => {
    console.error('IndexedDB bootstrap failed:', e);
  });
  await Promise.race([
    storageBoot,
    new Promise((resolve) => setTimeout(resolve, STORAGE_BOOT_TIMEOUT_MS)),
  ]);
  try {
    await storageBoot;
  } catch {
    /* logged above */
  }
  try {
    const { rehydrateLocalMindUiAfterKvBoot } = await import('./lib/rehydrateLocalMindUiAfterKvBoot.js');
    await rehydrateLocalMindUiAfterKvBoot();
  } catch (e) {
    console.warn('Local UI rehydrate after KV boot failed:', e);
  }

  window.addEventListener('pagehide', () => {
    void flushKvWrites();
  });

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  const schedule = typeof requestIdleCallback === 'function' ? requestIdleCallback : (fn) => setTimeout(fn, 200);
  schedule(async () => {
    try {
      const { runPriorityQueueBackfillOnce } = await import('./lib/priorityBackfill.js');
      await runPriorityQueueBackfillOnce();
    } catch (e) {
      console.warn('Priority queue backfill skipped:', e);
    }
    try {
      const { promoteAllPendingMindUpdates } = await import('./lib/pendingMindUpdates.js');
      await promoteAllPendingMindUpdates();
    } catch (e) {
      console.warn('Legacy pending mind updates flush skipped:', e);
    }
  });
}

void boot();

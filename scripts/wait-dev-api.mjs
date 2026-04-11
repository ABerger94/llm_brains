/**
 * Waits until the local API answers /api/health (and optionally a port file exists).
 * Lets Vite start after the backend has bound (avoids proxy pointing at a stale port).
 *
 * Default: `.dev-backend-port` + health on that port.
 * `WAIT_DEV_API_BASE_URL=http://127.0.0.1:8790` — poll that URL only (dual dev stack).
 * `WAIT_DEV_API_PORT_FILE=.dev-backend-port.hf` — read port from this file (repo-relative or absolute).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = Date.now() + 60_000;

const waitBaseRaw = String(process.env.WAIT_DEV_API_BASE_URL || '').trim().replace(/\/$/, '');
const altPortFileRaw = String(process.env.WAIT_DEV_API_PORT_FILE || '').trim();

const defaultPortFile = path.join(repoRoot, '.dev-backend-port');
const portFile =
  altPortFileRaw.length > 0
    ? path.isAbsolute(altPortFileRaw)
      ? altPortFileRaw
      : path.join(repoRoot, altPortFileRaw)
    : defaultPortFile;

async function healthOkAt(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    if (data?.ok !== true || !Array.isArray(data?.llm?.providerIds)) {
      console.warn(
        `[wait-dev-api] ${baseUrl} answered /api/health but payload is not this app’s API (missing ok + llm.providerIds).`
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

while (Date.now() < deadline) {
  if (waitBaseRaw) {
    if (await healthOkAt(waitBaseRaw)) process.exit(0);
  } else if (fs.existsSync(portFile)) {
    const port = Number(fs.readFileSync(portFile, 'utf8').trim());
    if (Number.isFinite(port) && port > 0) {
      if (await healthOkAt(`http://127.0.0.1:${port}`)) process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, 200));
}

const hint = waitBaseRaw
  ? `${waitBaseRaw}/api/health`
  : `${path.basename(portFile)} + /api/health`;
console.error(`Timed out waiting for API (${hint}). Is the backend starting?`);
process.exit(1);

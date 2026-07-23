/**
 * Quick checks for dev access from iPhone over Tailscale (run on the PC).
 * Usage: node scripts/tailscale-dev-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

function readEnvDevLanHost() {
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const m = raw.match(/^DEV_LAN_HOST=(.+)$/m);
    return m ? m[1].trim() : '(not set)';
  } catch {
    return '(no .env)';
  }
}

function tailscaleIPv4() {
  const r = spawnSync('tailscale', ['ip', '-4'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const line = r.stdout.trim().split(/\r?\n/)[0]?.trim();
  return line || null;
}

console.log('--- MetaSelf-CognitiveStack + Tailscale (PC checks) ---\n');

const tsIp = tailscaleIPv4();
if (tsIp) {
  console.log(`tailscale ip -4:  ${tsIp}`);
  console.log(`iPhone URL (IP):    http://${tsIp}:5174   (npm run dev — Hugging Face stack; use :3000 for dev:local)`);
} else {
  console.log('tailscale CLI:      not found or failed (install Tailscale on Windows; ensure `tailscale` is on PATH)');
}

const devLan = readEnvDevLanHost();
console.log(`DEV_LAN_HOST in .env: ${devLan}`);
if (tsIp && devLan !== tsIp && !devLan.includes('not set') && !devLan.includes('no .env')) {
  console.warn('\n[!] DEV_LAN_HOST should match the host you open in Safari (same IP or same *.ts.net name) for HMR.');
}

console.log('\n--- Manual checks ---');
console.log('1. Admin → Machines: PC + iPhone both online, same tailnet.');
console.log('2. PC: tailscale ping <iphone-100.x>  (must succeed).');
console.log('3. Windows Firewall: inbound TCP 5174 (Vite, default dev) or 3000 (dev:local), all profiles; or allow node.exe.');
  console.log('4. iPhone: Tailscale connected; exit node off; try Wi‑Fi and cellular.');
  console.log('5. If http://100.x:5174 fails but tailscale ping works: see TAILSCALE-IPHONE.md (ACLs, DNS blockers).');
console.log('6. MagicDNS / Serve URL: use https://… from Tailscale admin (Vite allows .ts.net hosts).');
console.log('\nFull guide: TAILSCALE-IPHONE.md\n');

# Tailscale + iPhone access to YourBrain (dev)

The app runs on your **PC** (`npm run dev` — Hugging Face–first, Vite on **5174**; **`npm run dev:local`** uses **3000**). The iPhone only opens the **Vite** URL; the Express API on the PC handles LLM calls.

## Quick URL

- **By Tailscale IP:** `http://<PC-tailscale-IP>:5174` (default **`npm run dev`**; use **:3000** if you run **`npm run dev:local`**)  
  Get the IP on the PC: `tailscale ip -4`
- **By MagicDNS / Serve:** use the `https://…` URL Tailscale shows (Vite is configured to allow `*.ts.net` hosts).

Set **`DEV_LAN_HOST`** in `.env` to the **same host** you type in the browser (the Tailscale IP or the `*.ts.net` name), then restart `npm run dev` so HMR WebSockets match.

Run on the PC:

```bash
node scripts/tailscale-dev-check.mjs
```

---

## Checklist (most issues are here)

### A. Same tailnet

1. [Tailscale admin → Machines](https://login.tailscale.com/admin/machines): **PC** and **iPhone** both listed and recently active.
2. Same Tailscale **account** (or same org) on both devices.
3. On the **PC**: `tailscale ping <iphone-100.x-address>` must **succeed** (`tailscale status` shows the iPhone IP).

If ping fails, fix Tailscale login / reinstall app on the phone before changing firewall or Vite.

### B. Windows Firewall

- Inbound **TCP 5174** (default dev) or **3000** (`dev:local`): Allow, **Domain + Private + Public** (Tailscale is often treated as Public).
- Optionally allow **`node.exe`** for Private + Public.
- **Scope:** remote IP should be **Any** (not “local subnet only”), or `100.64.0.0/10` is not always classified as “local” the way you expect.

Temporary test: turn firewall **off** for one load from the iPhone. If it still fails, the blocker is usually **not** Windows Firewall alone.

### C. Vite is listening

- Only **one** `npm run dev`; port **5174** (`strictPort` — no silent port change). For **`npm run dev:local`**, port **3000**.
- On PC, `http://127.0.0.1:5174` and `http://<tailscale-ip>:5174` should both work in a desktop browser (or **:3000** for `dev:local`).

### D. iPhone

- **Tailscale** app: Connected (VPN indicator on).
- **Exit node:** off while testing direct device-to-device access.
- URL: **`http://`**, correct IP, port **`5174`** (or **`3000`** for `dev:local`).
- Disable other **VPNs** temporarily.
- **Settings → Tailscale:** enable **Local Network** if shown.
- Turn off **iCloud Private Relay** / **Limit IP Address Tracking** for a quick test.
- Disable **AdGuard / NextDNS / DNS-only VPN** briefly (they can break `*.ts.net`).

### E. Tailscale ACLs

[Access controls](https://login.tailscale.com/admin/acls): default policy allows members to reach each other. Restrictive custom ACLs can show devices as “connected” but **block** traffic to the PC. Restore a permissive rule or explicitly allow your phone → PC.

### F. Tailscale Serve (HTTPS on the tailnet)

If raw `http://100.x:5174` is flaky, use **Serve** on the PC machine in the admin UI to forward to `http://127.0.0.1:5174` and open the **`https://…`** link on the iPhone. This repo allows **`Host: *.ts.net`** in Vite so you should not get Vite’s “Blocked request” 403 for those hostnames.

### G. Isolation test (not Tailscale)

From the PC, run **`ngrok http 5174`** (or **`ngrok http 3000`** for `dev:local`) and open the **https ngrok URL** on the iPhone.

- **Works** → phone/browser OK; problem is **Tailscale path or ACLs** between phone and PC.
- **Fails** → look at **phone network / DNS / blocking**, not the app.

---

## This repo’s Vite settings (reference)

- `server.host: true` — listen on all interfaces (includes Tailscale).
- `DEV_LAN_HOST` — HMR WebSocket host when you open the app by IP or hostname.
- `server.allowedHosts: ['.ts.net']` — allows Tailscale **MagicDNS / Serve** hostnames (plain `100.x` IPs were already allowed by Vite).

---

## Still stuck

Collect: `tailscale status` output, result of **`tailscale ping` to the iPhone**, whether **ngrok** works from the iPhone, and your **ACL** snippet (if custom). Tailscale support can use that to diagnose mesh issues.

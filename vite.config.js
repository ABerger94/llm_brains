import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import httpProxy from 'http-proxy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Match server `MYBRAIN_DEV_PORT_FILE` (e.g. `.dev-backend-port.hf` for dev:hf) when VITE_API_PROXY is unset. */
function readDevBackendTargetUrl(env) {
  const fileName =
    String(env.MYBRAIN_DEV_PORT_FILE || process.env.MYBRAIN_DEV_PORT_FILE || '.dev-backend-port').trim() ||
    '.dev-backend-port';
  const portFile = path.isAbsolute(fileName) ? fileName : path.join(__dirname, fileName);
  try {
    const raw = fs.readFileSync(portFile, 'utf8').trim();
    const port = Number(raw);
    if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`;
  } catch {
    /* no file yet */
  }
  return 'http://127.0.0.1:8787';
}

/**
 * Proxies /api on every request using the current .dev-backend-port file.
 * Avoids sending traffic to a stale process on 8787 when this repo’s backend bound a higher port.
 */
function dynamicApiProxyPlugin(env) {
  const fixedTarget = (
    env.API_PROXY_TARGET ||
    env.VITE_API_PROXY ||
    process.env.VITE_API_PROXY ||
    process.env.API_PROXY_TARGET ||
    ''
  ).trim();
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    xfwd: true,
    ws: true,
    /** Long graph pipeline runs (many LLM calls over SSE) must not hit a proxy idle timeout. */
    proxyTimeout: 0,
    timeout: 0,
  });
  proxy.on('proxyRes', (proxyRes, _req, res) => {
    const ct = String(proxyRes.headers['content-type'] || '');
    if (ct.includes('text/event-stream') && typeof res.setHeader === 'function') {
      res.setHeader('X-Accel-Buffering', 'no');
    }
  });
  proxy.on('error', (err, _req, res) => {
    console.error('[vite] API proxy error:', err?.message || err);
    if (res && !res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad gateway: backend unreachable. Run `npm run dev` or check .dev-backend-port.');
    }
  });

  function mount(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/api')) return next();
      try {
        req.setTimeout(0);
        res.setTimeout(0);
      } catch {
        /* ignore */
      }
      const target = fixedTarget || readDevBackendTargetUrl(env);
      proxy.web(req, res, { target, proxyTimeout: 0, timeout: 0 });
    });
  }

  return {
    name: 'dynamic-api-proxy',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

/** Default dev UI port (HF router stack). Override with VITE_DEV_PORT. strictPort true: fail if busy (match package.json --strictPort). */
const DEV_PORT = Number(process.env.VITE_DEV_PORT) || 5174;
const PREVIEW_PORT = Number(process.env.VITE_PREVIEW_PORT) || 3001;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const lanHost = String(env.DEV_LAN_HOST || '').trim();
  /**
   * Default stack: `npm run dev` — Hugging Face–first, Vite on **5174** (see package.json). `dev:local` uses 3000 for the alternate UI.
   * HMR: omit clientPort so it tracks the bound port; on LAN open the URL Vite prints.
   */
  const viteStrictPort = true;
  /** Tailscale/LAN: HMR WebSocket host must not be localhost when the phone uses the tailnet IP. */
  const hmr = lanHost.length > 0 ? { host: lanHost, protocol: 'ws' } : undefined;
  /**
   * Do not set `server.origin` when using DEV_LAN_HOST: it rewrites script/module URLs to the LAN host,
   * which breaks opening the same dev server at http://localhost:5174 (blank app / failed loads).
   * HMR above is enough for phones/Tailscale; assets stay same-origin with whatever host you use in the browser.
   */

  return {
    plugins: [react(), dynamicApiProxyPlugin(env)],
    server: {
      port: DEV_PORT,
      strictPort: viteStrictPort,
      host: true,
      open: true,
      /** Dev: allow any Host (localhost, LAN IP, machine name, *.ts.net, etc.). Vite’s default check otherwise returns 403 for many network URLs. */
      allowedHosts: true,
      ...(hmr ? { hmr } : {}),
    },
    preview: {
      port: PREVIEW_PORT,
      strictPort: false,
      host: true,
      allowedHosts: true,
    },
  };
});

/**
 * In-pipeline web fetch: parse WEB_REQUEST from module outputs, fulfill with SSRF checks,
 * optional Brave Search, append to sharedMemory.webFindings.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

/** Pipeline modules that may emit WEB_REQUEST and trigger outbound fetch. */
const WEB_REQUEST_HOOK_ALLOWLIST = new Set([
  'Deliberation',
  'Beliefs',
  'ExecutiveGate',
  'Motivation',
  'Integration',
  'IntegrationFinalize',
  'ContextMemory',
  // Legacy names (env WEB_HOOK_MODULES / stored configs)
  'Planning',
  'Reasoning',
  'Belief Store',
  'Metacognition',
  'Curiosity',
  'Memory',
  'Goal Generation',
]);

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function truthyDisabled(name) {
  const v = String(process.env[name] || '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes';
}

export function getWebFetchMaxPerRun() {
  return envInt('WEB_FETCH_MAX_PER_RUN', 8);
}

export function getWebFetchTimeoutMs() {
  return envInt('WEB_FETCH_TIMEOUT_MS', 12_000);
}

export function getWebFetchMaxBytes() {
  return envInt('WEB_FETCH_MAX_BYTES', 500_000);
}

export function getWebContextMaxEntryChars() {
  return envInt('WEB_CONTEXT_MAX_ENTRY_CHARS', 8000);
}

export function parseWebHookModuleSet() {
  const raw = String(process.env.WEB_HOOK_MODULES || '').trim();
  const candidates = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...WEB_REQUEST_HOOK_ALLOWLIST];
  return new Set(candidates.filter((name) => WEB_REQUEST_HOOK_ALLOWLIST.has(name)));
}

export function ensureWebFieldsInit(sm) {
  if (typeof sm.webFindings !== 'string') sm.webFindings = '';
  if (!Array.isArray(sm.webFetchLog)) sm.webFetchLog = [];
  if (!Number.isFinite(sm.webFetchesUsed)) sm.webFetchesUsed = 0;
  if (typeof sm.webFetchSuppressedForRun !== 'boolean') sm.webFetchSuppressedForRun = false;
  if (typeof sm.webFetchSuppressReason !== 'string') sm.webFetchSuppressReason = '';
  if (!(sm.webFetchSuppressedTargets instanceof Set)) sm.webFetchSuppressedTargets = new Set();
}

/**
 * After a failed outbound web attempt, suppress only the specific target that failed (not the entire run).
 * @param {object} sm sharedMemory
 * @param {string} target  The URL or search query that failed
 * @param {string} reason
 */
function markWebFetchSuppressedForTarget(sm, target, reason) {
  ensureWebFieldsInit(sm);
  const key = String(target || '').slice(0, 500).toLowerCase().trim();
  if (!key || sm.webFetchSuppressedTargets.has(key)) return;
  sm.webFetchSuppressedTargets.add(key);
  sm.webFetchSuppressReason = String(reason || 'web request failed').slice(0, 500);
  const stamp = new Date().toISOString();
  const note = `[${stamp}] Pipeline: suppressed further fetches for target "${key}" (${sm.webFetchSuppressReason}).`;
  sm.webFindings = [sm.webFindings, note].filter(Boolean).join('\n').trim();
}

function parseIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1, 5).map((x) => Number(x));
  if (o.some((n) => n > 255)) return null;
  return o;
}

function isPrivateOrBlockedIpv4(octets) {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; /* CGNAT */
  return false;
}

function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    const o = parseIpv4(v4);
    if (o && isPrivateOrBlockedIpv4(o)) return true;
  }
  return false;
}

function blockedHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal') return true;
  if (h === '169.254.169.254') return true;
  return false;
}

/**
 * @param {string} urlString
 * @returns {{ ok: boolean, error?: string, url?: URL }}
 */
export async function assertUrlSafeForFetch(urlString) {
  let u;
  try {
    u = new URL(urlString.trim());
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Only http/https allowed' };
  }
  const host = u.hostname;
  if (blockedHostname(host)) return { ok: false, error: 'Hostname blocked' };

  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    const o = parseIpv4(host);
    if (!o || isPrivateOrBlockedIpv4(o)) return { ok: false, error: 'IPv4 address blocked' };
    return { ok: true, url: u };
  }
  if (ipVer === 6) {
    if (isBlockedIpv6(host)) return { ok: false, error: 'IPv6 address blocked' };
    return { ok: true, url: u };
  }

  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      const v = net.isIP(r.address);
      if (v === 4) {
        const o = parseIpv4(r.address);
        if (o && isPrivateOrBlockedIpv4(o)) return { ok: false, error: 'DNS resolves to private IPv4' };
      } else if (v === 6 && isBlockedIpv6(r.address)) {
        return { ok: false, error: 'DNS resolves to blocked IPv6' };
      }
    }
  } catch (e) {
    return { ok: false, error: `DNS failed: ${e?.message || e}` };
  }

  return { ok: true, url: u };
}

export function htmlToPlainText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

async function readBodyLimited(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text().catch(() => '');
    return t.slice(0, maxBytes);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      const take = Math.min(value.length, maxBytes - total);
      chunks.push(Buffer.from(value.subarray(0, take)));
      total += take;
      if (total >= maxBytes) break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Re-check final URL after redirects.
 */
export async function fetchUrlText(urlString) {
  const first = await assertUrlSafeForFetch(urlString);
  if (!first.ok) return { ok: false, error: first.error, text: '' };

  const timeoutMs = getWebFetchTimeoutMs();
  const maxBytes = getWebFetchMaxBytes();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(first.url.toString(), {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'MetaSelf-CognitiveStack-Pipeline/1.0 (local research; +https://github.com)',
        Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
      },
    });
    const finalUrl = res.url || first.url.toString();
    const finalCheck = await assertUrlSafeForFetch(finalUrl);
    if (!finalCheck.ok) return { ok: false, error: `Redirect to unsafe URL: ${finalCheck.error}`, text: '' };

    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const raw = await readBodyLimited(res, maxBytes);
    let text = raw;
    if (ct.includes('html') || /<html[\s>]/i.test(raw.slice(0, 500))) {
      text = htmlToPlainText(raw);
    }
    const maxEntry = getWebContextMaxEntryChars();
    if (text.length > maxEntry) text = `${text.slice(0, maxEntry)}\n[...truncated...]`;
    return { ok: res.ok, error: res.ok ? '' : `HTTP ${res.status}`, text, finalUrl };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'Fetch timeout' : e?.message || String(e);
    return { ok: false, error: msg, text: '' };
  } finally {
    clearTimeout(t);
  }
}

export async function braveWebSearch(query) {
  const key = String(process.env.BRAVE_SEARCH_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'BRAVE_SEARCH_API_KEY not set', text: '' };

  const q = String(query || '').trim().slice(0, 400);
  if (!q) return { ok: false, error: 'Empty search query', text: '' };

  const timeoutMs = getWebFetchTimeoutMs();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`;
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'X-Subscription-Token': key,
        Accept: 'application/json',
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = json?.message || json?.error || `HTTP ${res.status}`;
      return { ok: false, error: String(errMsg), text: '' };
    }
    const results = json?.web?.results || json?.results || [];
    const lines = [];
    for (const r of results.slice(0, 8)) {
      const title = r.title || r.name || '';
      const desc = r.description || r.snippet || '';
      const u = r.url || r.link || '';
      if (title || desc) lines.push(`- ${title} ${u ? `(${u})` : ''}: ${desc}`.trim());
    }
    let text = lines.join('\n');
    const maxEntry = getWebContextMaxEntryChars();
    if (text.length > maxEntry) text = `${text.slice(0, maxEntry)}\n[...truncated...]`;
    return { ok: true, error: '', text: text || '(no results)' };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'Brave API timeout' : e?.message || String(e);
    return { ok: false, error: msg, text: '' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} text module output
 * @returns {{ kind: 'SEARCH' | 'URL', target: string, reason: string } | null}
 */
export function parseWebRequestFromOutput(text) {
  const s = String(text || '');
  const m = /\bWEB_REQUEST\s*:/i.exec(s);
  if (!m) return null;
  const after = s.slice(m.index + m[0].length);
  const lines = after.split(/\r?\n/);
  let kind = '';
  let target = '';
  let reason = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const km = /^KIND\s*:\s*(SEARCH|URL)\s*$/i.exec(t);
    if (km) {
      kind = km[1].toUpperCase();
      continue;
    }
    const tm = /^TARGET\s*:\s*(.+)$/i.exec(t);
    if (tm) {
      target = tm[1].trim();
      continue;
    }
    const rm = /^REASON\s*:\s*(.+)$/i.exec(t);
    if (rm) {
      reason = rm[1].trim();
      continue;
    }
    /* stop at next major section */
    if (/^[A-Z][A-Z_]{2,20}\s*:/.test(t) && !/^REASON\s*:/i.test(t) && !/^TARGET\s*:/i.test(t) && !/^KIND\s*:/i.test(t)) {
      break;
    }
  }
  if (!kind || !target) return null;
  return { kind, target, reason: reason || '(no reason given)' };
}

export async function fulfillWebRequest(req) {
  try {
    if (req.kind === 'SEARCH') {
      const r = await braveWebSearch(req.target);
      return {
        ok: r.ok,
        summary: r.text,
        error: r.error,
        label: `SEARCH: ${req.target.slice(0, 120)}`,
      };
    }
    if (req.kind === 'URL') {
      const r = await fetchUrlText(req.target);
      return {
        ok: r.ok,
        summary: r.text,
        error: r.error || (r.ok ? '' : 'fetch failed'),
        label: `URL: ${req.target.slice(0, 200)}`,
      };
    }
    return { ok: false, summary: '', error: 'Unknown KIND', label: '' };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[fulfillWebRequest]', e);
    return {
      ok: false,
      summary: '',
      error: msg.slice(0, 500),
      label: req?.kind === 'URL' ? `URL: ${String(req.target || '').slice(0, 120)}` : `SEARCH: ${String(req?.target || '').slice(0, 120)}`,
    };
  }
}

/**
 * @param {object} sharedMemory
 * @param {string} moduleName
 * @param {{ emit?: (e: object) => void }} ctx
 */
function safeEmit(ctx, payload) {
  try {
    ctx.emit?.(payload);
  } catch (e) {
    console.warn('[web_fetch emit]', e);
  }
}

export async function maybeFulfillWebRequests(sharedMemory, moduleName, ctx = {}) {
  if (truthyDisabled('WEB_FETCH_DISABLED')) return;

  try {
    const hooks = parseWebHookModuleSet();
    if (!hooks.has(moduleName)) return;

    ensureWebFieldsInit(sharedMemory);

    const maxRun = getWebFetchMaxPerRun();
    if (sharedMemory.webFetchesUsed >= maxRun) return;

    const output = sharedMemory.moduleOutputs?.[moduleName];
    const parsed = parseWebRequestFromOutput(String(output || ''));
    if (!parsed) return;

    const targetKey = String(parsed.target || '').slice(0, 500).toLowerCase().trim();
    if (targetKey && sharedMemory.webFetchSuppressedTargets.has(targetKey)) return;

    /* SEARCH without Brave key: record once in findings, do not burn WEB_FETCH_MAX_PER_RUN budget. */
    if (parsed.kind === 'SEARCH' && !String(process.env.BRAVE_SEARCH_API_KEY || '').trim()) {
      const stamp = new Date().toISOString();
      const msg =
        'Web search was requested but BRAVE_SEARCH_API_KEY is not set on the API server. Add it to .env and restart the backend, or use KIND: URL with a public https link instead.';
      const block = `[${stamp}] via ${moduleName} — SEARCH (not configured)\n${msg}\n`;
      sharedMemory.webFindings = [sharedMemory.webFindings, block].filter(Boolean).join('\n').trim();
      const preview = msg.replace(/\s+/g, ' ').trim().slice(0, 280);
      sharedMemory.webFetchLog.push({
        at: stamp,
        module: moduleName,
        kind: 'SEARCH',
        target: parsed.target.slice(0, 500),
        ok: false,
        preview,
        skipped: true,
      });
      sharedMemory.webFetchLog = sharedMemory.webFetchLog.slice(-20);
      safeEmit(ctx, {
        type: 'web_fetch',
        moduleName,
        kind: 'SEARCH',
        ok: false,
        preview,
        error: 'BRAVE_SEARCH_API_KEY not set',
        skipped: true,
      });
      return;
    }

    const entry = await fulfillWebRequest(parsed);
    sharedMemory.webFetchesUsed += 1;

    const stamp = new Date().toISOString();
    const header = `[${stamp}] via ${moduleName} — ${entry.label}`;
    const body = entry.ok
      ? entry.summary
      : `(failed) ${entry.error || 'unknown error'}`;
    const block = `${header}\n${body}\n`;
    sharedMemory.webFindings = [sharedMemory.webFindings, block].filter(Boolean).join('\n').trim();
    const preview = String(body).replace(/\s+/g, ' ').trim().slice(0, 280);

    sharedMemory.webFetchLog.push({
      at: stamp,
      module: moduleName,
      kind: parsed.kind,
      target: parsed.target.slice(0, 500),
      ok: entry.ok,
      preview,
    });
    sharedMemory.webFetchLog = sharedMemory.webFetchLog.slice(-20);

    safeEmit(ctx, {
      type: 'web_fetch',
      moduleName,
      kind: parsed.kind,
      ok: entry.ok,
      preview,
      error: entry.ok ? undefined : String(entry.error || '').slice(0, 200),
    });

    if (!entry.ok) {
      markWebFetchSuppressedForTarget(sharedMemory, parsed.target, entry.error || 'fetch or search failed');
    }
  } catch (err) {
    console.error('[maybeFulfillWebRequests] non-fatal', moduleName, err);
    try {
      ensureWebFieldsInit(sharedMemory);
      markWebFetchSuppressedForTarget(sharedMemory, '', err?.message || String(err));
      sharedMemory.webFetchesUsed += 1;
      const stamp = new Date().toISOString();
      const safeMsg = String(err?.message || err).slice(0, 600);
      const block = `[${stamp}] via ${moduleName} — WEB_FETCH (internal error)\n(failed) ${safeMsg}\n`;
      sharedMemory.webFindings = [sharedMemory.webFindings, block].filter(Boolean).join('\n').trim();
      sharedMemory.webFetchLog.push({
        at: stamp,
        module: moduleName,
        kind: 'ERROR',
        target: '',
        ok: false,
        preview: safeMsg.slice(0, 280),
      });
      sharedMemory.webFetchLog = sharedMemory.webFetchLog.slice(-20);
      safeEmit(ctx, {
        type: 'web_fetch',
        moduleName,
        kind: 'ERROR',
        ok: false,
        preview: safeMsg.slice(0, 200),
        error: safeMsg.slice(0, 200),
      });
    } catch (e2) {
      console.error('[maybeFulfillWebRequests] recovery failed', e2);
    }
  }
}

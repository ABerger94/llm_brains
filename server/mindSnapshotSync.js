/**
 * Single-user mind snapshot store: PUT/GET raw archive bytes (same format as Dashboard export).
 * Protected by MIND_SNAPSHOT_SYNC_TOKEN (Bearer).
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SUBDIR = 'mind-snapshot';
const BLOB_FILE = 'latest.bin';
const META_FILE = 'meta.json';

/**
 * @param {string} dataDir
 */
function snapshotPaths(dataDir) {
  const base = path.join(dataDir, SUBDIR);
  return {
    dir: base,
    blob: path.join(base, BLOB_FILE),
    meta: path.join(base, META_FILE),
  };
}

function readMetaJson(paths) {
  if (!fs.existsSync(paths.meta)) return null;
  try {
    const raw = fs.readFileSync(paths.meta, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('express').Application} app
 * @param {{ dataDir: string, syncToken: string }} opts
 */
export function mountMindSnapshotSync(app, opts) {
  const { dataDir, syncToken } = opts;
  const paths = snapshotPaths(dataDir);

  function ensureSnapshotDir() {
    fs.mkdirSync(paths.dir, { recursive: true });
  }

  function auth(req, res, next) {
    const t = String(syncToken || '').trim();
    if (!t) {
      res.status(503).json({ error: 'Mind snapshot sync is not configured (set MIND_SNAPSHOT_SYNC_TOKEN in .env).' });
      return;
    }
    const authHeader = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)/i.exec(authHeader);
    const token = m ? m[1].trim() : '';
    if (token !== t) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  /**
   * Large uploads only on this route — do not use global express.json for this body.
   * Default 1gb; override e.g. MIND_SNAPSHOT_UPLOAD_LIMIT=512mb. If you proxy with nginx/Caddy, raise
   * client_max_body_size / request body limit to match or pushes return 413 from the proxy, not Express.
   */
  const uploadLimit = String(process.env.MIND_SNAPSHOT_UPLOAD_LIMIT || '1gb').trim() || '1gb';
  const rawBody = express.raw({ limit: uploadLimit });

  app.get('/api/mind-snapshot/meta', auth, (req, res) => {
    try {
      if (!fs.existsSync(paths.blob)) {
        return res.json({ exists: false, updatedAt: null, sizeBytes: 0 });
      }
      const stat = fs.statSync(paths.blob);
      const meta = readMetaJson(paths);
      const updatedAt =
        (meta && typeof meta.updatedAt === 'string' && meta.updatedAt) || new Date(stat.mtimeMs).toISOString();
      const sizeBytes = typeof meta?.sizeBytes === 'number' ? meta.sizeBytes : stat.size;
      res.json({
        exists: true,
        updatedAt,
        sizeBytes,
        contentSha256: typeof meta?.contentSha256 === 'string' ? meta.contentSha256 : undefined,
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.put('/api/mind-snapshot', auth, rawBody, (req, res) => {
    try {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'Expected non-empty raw body (mind archive bytes).' });
        return;
      }
      ensureSnapshotDir();
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      fs.writeFileSync(paths.blob, body);
      const meta = {
        updatedAt: new Date().toISOString(),
        sizeBytes: body.length,
        contentSha256: sha256,
      };
      fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2), 'utf8');
      res.json({ ok: true, updatedAt: meta.updatedAt, sizeBytes: meta.sizeBytes });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/mind-snapshot', auth, (req, res) => {
    try {
      if (!fs.existsSync(paths.blob)) {
        res.status(404).json({ error: 'No snapshot on server' });
        return;
      }
      const buf = fs.readFileSync(paths.blob);
      const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
      res.setHeader('Content-Type', isGzip ? 'application/gzip' : 'application/json; charset=utf-8');
      res.send(buf);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

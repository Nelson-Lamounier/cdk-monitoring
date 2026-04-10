/* eslint-disable no-undef, no-console */
/**
 * Production HTTP server for TanStack Start (Admin).
 *
 * Why this file is patched from cdk-monitoring:
 *   The original server.js in frontend-portfolio was a thin SSR-only adapter —
 *   it delegated every request to TanStack Start's fetch handler but did NOT
 *   serve static files from dist/client/.  Because the app is built with
 *   ROUTER_BASEPATH="admin", Vite-hashed assets are requested by the browser
 *   at /admin/assets/<hash>.js|css — paths the SSR handler has no route for,
 *   resulting in 404s for all CSS and JS chunks (no styles, broken JS).
 *
 *   This patched version adds a fast-path static-file handler (tryServeStatic)
 *   that maps /admin/assets/* → dist/client/assets/* before any request
 *   reaches the SSR handler.
 *
 * Build-time injection (deploy-frontend.yml build-admin step):
 *   COPY .github/patches/start-admin-server.js /app/server.js
 */
import { createServer } from 'http';
import { createReadStream, statSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import serverExport from './dist/server/server.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const port = process.env.PORT || 5001;

// ---------------------------------------------------------------------------
// Static asset config
// ---------------------------------------------------------------------------
// Assets are output to dist/client/ by Vite.  The app is compiled with
// ROUTER_BASEPATH="admin" so the browser requests /admin/assets/<file>.
// Strip the basepath prefix before resolving against dist/client/.
const CLIENT_DIR = join(__dirname, 'dist', 'client');

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.webp':  'image/webp',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.json':  'application/json',
};

/**
 * Try to serve a static file from dist/client/.
 * Returns true if the response was sent, false to fall through to SSR.
 *
 * URL mapping:
 *   /admin/assets/styles-BaHLhT7v.css  →  dist/client/assets/styles-BaHLhT7v.css
 *   /admin/assets/main-BPTnT1y8.js     →  dist/client/assets/main-BPTnT1y8.js
 *
 * @param {string} urlPath  - pathname portion of the request URL (no query string)
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
function tryServeStatic(urlPath, res) {
  // Strip the "/admin" basepath prefix so we resolve relative to dist/client/.
  const stripped = urlPath.startsWith('/admin') ? urlPath.slice(6) : urlPath;

  // Guard against path-traversal: resolved path must remain inside CLIENT_DIR.
  const filePath = join(CLIENT_DIR, stripped);
  if (!filePath.startsWith(CLIENT_DIR)) return false;

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return false; // file not found — fall through to SSR
  }
  if (!stat.isFile()) return false;

  const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type':   mime,
    'Content-Length': stat.size,
    // Vite content-hashes every asset filename — safe to cache immutably.
    'Cache-Control':  'public, max-age=31536000, immutable',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// SSR handler (TanStack Start)
// ---------------------------------------------------------------------------
const serverHandler = serverExport.default?.fetch ?? serverExport.fetch;

if (!serverHandler) {
  console.error("Failed to find 'fetch' handler in dist/server/server.js");
  process.exit(1);
}

const httpServer = createServer(async (req, res) => {
  try {
    const urlPath = req.url?.split('?')[0] ?? '/';

    // 1. Fast-path: serve Vite-built static assets directly from disk.
    //    Only GET/HEAD can match — everything else goes straight to SSR.
    if ((req.method === 'GET' || req.method === 'HEAD') && tryServeStatic(urlPath, res)) {
      return;
    }

    // 2. SSR: convert Node.js request to Web Request and delegate to TanStack Start.
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }

    /** @type {RequestInit & { duplex?: string }} */
    const init = {
      method: req.method,
      headers,
      // Node 22 native fetch compatibility
      duplex: 'half',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      init.body = Buffer.concat(chunks);
    }

    const webReq = new Request(url, init);
    const webRes = await serverHandler(webReq);

    res.statusCode = webRes.status;
    res.statusMessage = webRes.statusText;
    webRes.headers.forEach((value, name) => res.setHeader(name, value));

    if (webRes.body) {
      const reader = webRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }

    res.end();
  } catch (error) {
    console.error('Server error:', error);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
});

httpServer.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`🚀 Production server listening at http://${process.env.HOST || '0.0.0.0'}:${port}`);
});

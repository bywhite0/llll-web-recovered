import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { buildLocalApiIndex } from './build-local-api-index.mjs';

const root = process.cwd();
const portArgIndex = process.argv.findIndex((x) => x === '--port');
const port = portArgIndex > -1 ? Number(process.argv[portArgIndex + 1]) : Number(process.env.PORT || 4173);
const reportsRootArgIndex = process.argv.findIndex((x) => x === '--reports-root');
const reportsRoot = reportsRootArgIndex > -1 ? String(process.argv[reportsRootArgIndex + 1]) : path.join(root, 'reports');
const apiContentDirArgIndex = process.argv.findIndex((x) => x === '--api-content-dir');
const apiContentDir = apiContentDirArgIndex > -1 ? String(process.argv[apiContentDirArgIndex + 1]) : undefined;
const selectCardIndexPathArgIndex = process.argv.findIndex((x) => x === '--select-card-index-path');
const selectCardIndexPath = selectCardIndexPathArgIndex > -1
  ? String(process.argv[selectCardIndexPathArgIndex + 1])
  : (process.env.LOCAL_API_SELECT_CARD_INDEX || path.join(root, 'reports', 'api_overlay', 'select-card-list-index.json'));

const apiIndex = buildLocalApiIndex({
  cwd: root,
  reportsRoot,
  apiContentDir,
  selectCardIndexPath,
});

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(base, target) {
  const p = path.resolve(base, target);
  if (!p.startsWith(path.resolve(base))) return null;
  return p;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function localNotFound(message) {
  return {
    error_code: 'LOCAL_NOT_FOUND',
    title: 'Local Route Error',
    message,
  };
}

function localWriteBlocked(message) {
  return {
    error_code: 'LOCAL_WRITE_BLOCKED',
    title: 'Local Route Blocked',
    message,
  };
}

function handleApiRequest(req, res, parsed) {
  const pathname = parsed.pathname;
  const searchParams = parsed.searchParams;
  const blockedWritePaths = new Set(['/api/radio_form', '/api/contact', '/api/serial_code']);

  if (blockedWritePaths.has(pathname) && req.method === 'POST') {
    sendJson(res, 501, localWriteBlocked(`Blocked local write endpoint: ${pathname}`));
    return true;
  }

  if (pathname === '/api/weblive/id') {
    sendJson(res, 200, apiIndex.routes.singleton.webliveId);
    return true;
  }

  if (pathname === '/api/extra/news.json') {
    sendJson(res, 200, apiIndex.routes.singleton.extraNews);
    return true;
  }

  if (pathname === '/api/school_idol_connect_post/theme_list') {
    sendJson(res, 200, apiIndex.routes.singleton.schoolIdolConnectPostThemeList);
    return true;
  }

  if (pathname === '/api/gacha/detail') {
    const id = searchParams.get('gacha_series_id') ?? '';
    const payload = apiIndex.routes.gachaDetailById[id];
    if (!payload) {
      sendJson(res, 404, localNotFound(`No local gacha/detail snapshot for gacha_series_id=${id || '(empty)'}`));
      return true;
    }
    sendJson(res, 200, payload);
    return true;
  }

  if (pathname === '/api/shop/membership_perk_detail') {
    const id = searchParams.get('membership_id') ?? '';
    const payload = apiIndex.routes.membershipPerkDetailById[id];
    if (!payload) {
      sendJson(res, 404, localNotFound(`No local membership_perk_detail snapshot for membership_id=${id || '(empty)'}`));
      return true;
    }
    sendJson(res, 200, payload);
    return true;
  }

  if (pathname === '/api/gacha/select_card_list') {
    const id = searchParams.get('select_ticket_series_id') ?? '';
    const payload = apiIndex.routes.selectCardListById[id];
    if (!payload) {
      sendJson(res, 404, localNotFound(`No local select_card_list data for select_ticket_series_id=${id || '(empty)'}`));
      return true;
    }
    sendJson(res, 200, payload);
    return true;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, localNotFound(`Local overlay has no route for ${pathname}`));
    return true;
  }

  return false;
}

function resolveFile(rawPathname) {
  const pathname = decodeURIComponent(rawPathname);

  if (pathname === '/client.mjs') {
    const preferred = path.join(root, 'snapshots', 'current', 'client.mjs');
    if (fs.existsSync(preferred)) return preferred;
    return path.join(root, 'dist', 'client.mjs');
  }
  if (pathname === '/client.mjs.map') {
    const preferred = path.join(root, 'snapshots', 'current', 'client.mjs.map');
    if (fs.existsSync(preferred)) return preferred;
    return path.join(root, 'dist', 'client.mjs.map');
  }

  if (pathname.startsWith('/images/')) {
    return safeJoin(path.join(root, 'public'), pathname.slice(1));
  }

  if (pathname.startsWith('/external/')) {
    return safeJoin(path.join(root, 'public'), pathname.slice(1));
  }

  const primary = safeJoin(root, pathname.slice(1));
  if (primary && fs.existsSync(primary)) return primary;

  const fallbackPublic = safeJoin(path.join(root, 'public'), pathname.slice(1));
  if (fallbackPublic && fs.existsSync(fallbackPublic)) return fallbackPublic;

  return primary;
}

function sendFile(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  let finalPath = filePath;
  if (stat.isDirectory()) {
    finalPath = path.join(filePath, 'index.html');
    if (!fs.existsSync(finalPath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
  }

  const ext = path.extname(finalPath).toLowerCase();
  const contentType = mime[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(finalPath).pipe(res);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url ?? '/', 'http://localhost');
  if (handleApiRequest(req, res, parsed)) return;
  const filePath = resolveFile(parsed.pathname);

  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  sendFile(req, res, filePath);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Static mapped server running at http://127.0.0.1:${port}`);
  console.log(`Local API snapshot: ${apiIndex.meta.apiContentDir}`);
  console.log(`Select card index: ${apiIndex.meta.selectCardIndexPath}`);
  console.log('Try: /public/external/link-like-lovelive.app/contact/radio_mail/index.html');
});

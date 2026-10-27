import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { buildLocalApiIndex } from './scripts/build-local-api-index.mjs';

function pseudoStyleModulePlugin() {
  const marker = '\0pseudo-style-module:';

  function isPseudoStyleFile(filePath: string) {
    if (!/\.s?css$/.test(filePath)) return false;
    if (!filePath.includes(`${path.sep}src${path.sep}`)) return false;
    if (!fs.existsSync(filePath)) return false;

    const text = fs.readFileSync(filePath, 'utf8');
    return text.startsWith('export default `');
  }

  return {
    name: 'pseudo-style-module-loader',
    enforce: 'pre',

    resolveId(source: string, importer?: string) {
      if (!importer) return null;
      if (!source.endsWith('.scss') && !source.endsWith('.css')) return null;

      const resolved = path.resolve(path.dirname(importer), source);
      if (!isPseudoStyleFile(resolved)) return null;
      return marker + Buffer.from(resolved).toString('base64url');
    },

    load(id: string) {
      if (!id.startsWith(marker)) return null;
      const encodedPath = id.slice(marker.length);
      const filePath = Buffer.from(encodedPath, 'base64url').toString('utf8');
      if (!isPseudoStyleFile(filePath)) return null;
      return fs.readFileSync(filePath, 'utf8');
    },
  };
}

function localApiOverlayPlugin() {
  let apiIndex: ReturnType<typeof buildLocalApiIndex> | null = null;
  const blockedWritePaths = new Set(['/api/radio_form', '/api/contact', '/api/serial_code']);

  function getApiIndex() {
    if (apiIndex) return apiIndex;
    const root = process.cwd();
    const reportsRoot = process.env.LOCAL_API_REPORTS_ROOT || path.join(root, 'reports');
    const apiContentDir = process.env.LOCAL_API_CONTENT_DIR || undefined;
    const selectCardIndexPath = process.env.LOCAL_API_SELECT_CARD_INDEX || path.join(root, 'reports', 'api_overlay', 'select-card-list-index.json');

    apiIndex = buildLocalApiIndex({
      cwd: root,
      reportsRoot,
      apiContentDir,
      selectCardIndexPath,
    });
    return apiIndex;
  }

  function sendJson(res: any, status: number, payload: unknown) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function localNotFound(message: string) {
    return {
      error_code: 'LOCAL_NOT_FOUND',
      title: 'Local Route Error',
      message,
    };
  }

  function localWriteBlocked(message: string) {
    return {
      error_code: 'LOCAL_WRITE_BLOCKED',
      title: 'Local Route Blocked',
      message,
    };
  }

  function handleApi(req: any, res: any) {
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const pathname = parsed.pathname;
    const searchParams = parsed.searchParams;
    if (!pathname.startsWith('/api/')) return false;

    if (blockedWritePaths.has(pathname) && req.method === 'POST') {
      sendJson(res, 501, localWriteBlocked(`Blocked local write endpoint: ${pathname}`));
      return true;
    }

    const index = getApiIndex();
    if (pathname === '/api/weblive/id') {
      sendJson(res, 200, index.routes.singleton.webliveId);
      return true;
    }
    if (pathname === '/api/extra/news.json') {
      sendJson(res, 200, index.routes.singleton.extraNews);
      return true;
    }
    if (pathname === '/api/school_idol_connect_post/theme_list') {
      sendJson(res, 200, index.routes.singleton.schoolIdolConnectPostThemeList);
      return true;
    }
    if (pathname === '/api/gacha/detail') {
      const id = searchParams.get('gacha_series_id') ?? '';
      const payload = index.routes.gachaDetailById[id];
      if (!payload) {
        sendJson(res, 404, localNotFound(`No local gacha/detail snapshot for gacha_series_id=${id || '(empty)'}`));
        return true;
      }
      sendJson(res, 200, payload);
      return true;
    }
    if (pathname === '/api/shop/membership_perk_detail') {
      const id = searchParams.get('membership_id') ?? '';
      const payload = index.routes.membershipPerkDetailById[id];
      if (!payload) {
        sendJson(res, 404, localNotFound(`No local membership_perk_detail snapshot for membership_id=${id || '(empty)'}`));
        return true;
      }
      sendJson(res, 200, payload);
      return true;
    }
    if (pathname === '/api/gacha/select_card_list') {
      const id = searchParams.get('select_ticket_series_id') ?? '';
      const payload = index.routes.selectCardListById[id];
      if (!payload) {
        sendJson(res, 404, localNotFound(`No local select_card_list data for select_ticket_series_id=${id || '(empty)'}`));
        return true;
      }
      sendJson(res, 200, payload);
      return true;
    }

    sendJson(res, 404, localNotFound(`Local overlay has no route for ${pathname}`));
    return true;
  }

  function mount(middlewares: any) {
    middlewares.use((req: any, res: any, next: () => void) => {
      if (handleApi(req, res)) return;
      next();
    });
  }

  return {
    name: 'local-api-overlay',
    configureServer(server: any) {
      mount(server.middlewares);
      const index = getApiIndex();
      console.log(`[local-api-overlay] Loaded snapshot: ${index.meta.apiContentDir}`);
      console.log(`[local-api-overlay] Select card index: ${index.meta.selectCardIndexPath}`);
    },
    configurePreviewServer(server: any) {
      mount(server.middlewares);
      const index = getApiIndex();
      console.log(`[local-api-overlay] Loaded snapshot: ${index.meta.apiContentDir}`);
      console.log(`[local-api-overlay] Select card index: ${index.meta.selectCardIndexPath}`);
    },
  };
}

// Local debugging helper: session-gated pages (gacha rate/list, membership, radio_mail)
// bail out early when the `session` cookie is missing, which shows as a blank page in dev.
// The local API overlay does not verify auth, so seed a dummy session object on HTML navigations.
function localSessionCookiePlugin() {
  const dummySession = 'session=' + encodeURIComponent(JSON.stringify({ local: '1' })) + '; Path=/; SameSite=Lax';

  function middleware(req: any, res: any, next: () => void) {
    const url: string = req.url ?? '/';
    const acceptsHtml = String(req.headers?.accept ?? '').includes('text/html');
    const hasSession = String(req.headers?.cookie ?? '').includes('session=');
    if (acceptsHtml && !url.startsWith('/api/') && !hasSession) {
      res.setHeader('Set-Cookie', dummySession);
    }
    next();
  }

  return {
    name: 'local-session-cookie',
    configureServer(server: any) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [localSessionCookiePlugin(), localApiOverlayPlugin(), pseudoStyleModulePlugin(), react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
  },
});

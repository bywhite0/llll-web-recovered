import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://api.link-like-lovelive.app/v1';
const WEB_BASE = 'https://link-like-lovelive.app';
const USER_API_VERSION = '1.0.0';
const API_KEY = '4e769efa67d8f54be0b67e8f70ccb23d513a3c841191b6b2ba45ffc6fb498068';
const DEFAULT_RES_VERSION = 'R2604002';
const DEFAULT_CLIENT_VERSION = '5.0.1';
const DEFAULT_LOGIN_TYPE = 'android';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--') continue;
    if (!current.startsWith('--')) continue;
    const eqIndex = current.indexOf('=');
    if (eqIndex >= 0) {
      const key = current.slice(2, eqIndex);
      out[key] = current.slice(eqIndex + 1);
      continue;
    }
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next && next !== '--' && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function asBool(value) {
  if (value === true) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y' || normalized === 'on';
}

function printHelp() {
  console.log(`Usage:
  node scripts/fetch-api-content.mjs [options]

Options:
  --player-id <id>                  Player ID (or PLAYER_ID / config credential.player_id)
  --password <token>                Provider id_token for account/connect mode (or PLAYER_PASSWORD)
  --config-path <file>              Optional config JSON path (or LINKURA_CONFIG_PATH)
  --masterdata-dir <dir>            Masterdata directory (or MASTERDATA_DIR)
  --gacha-yaml <file>               Optional GachaSeries.yaml path (or GACHA_YAML)
  --out-dir <dir>                   Output directory (default: reports/api_content_<timestamp>)
  --res-version <ver>               Optional resource version override (or RES_VERSION)
  --client-version <ver>            Optional client version override (or CLIENT_VERSION)
  --login-type <android|ios>        Optional login type override (or LOGIN_TYPE)
  --auth-mode <connect|session>     Authentication mode (default: connect)
  --use-session-token               Shortcut for --auth-mode session
  --session-token <token>           Session token for session mode (or SESSION_TOKEN / config credential.session_token)
  --device-specific-id <id>         Device ID for session mode (or DEVICE_SPECIFIC_ID / config credential.device_specific_id)
  --help                            Show this help
`);
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function randomIdempotencyKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i += 1) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function sanitizeName(input) {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const parsed = safeJsonParse(text);
  return {
    ok: res.ok,
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text,
    json: parsed.ok ? parsed.value : null,
  };
}

function buildApiHeaders({ resVersion, clientVersion, loginType, deviceSpecificId, sessionToken, withIdempotency }) {
  const normalizedLoginType = String(loginType || 'android').toLowerCase() === 'ios' ? 'ios' : 'android';
  const uaPrefix = normalizedLoginType === 'ios' ? 'inspix-ios' : 'inspix-android';
  const headers = {
    'x-res-version': resVersion,
    'x-client-version': clientVersion,
    'x-device-type': normalizedLoginType,
    'inspix-user-api-version': USER_API_VERSION,
    accept: 'application/json',
    'x-api-key': API_KEY,
    'user-agent': `${uaPrefix}/${clientVersion}`,
    host: 'api.link-like-lovelive.app',
  };
  if (deviceSpecificId) headers['x-device-specific-id'] = deviceSpecificId;
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  if (withIdempotency) headers['x-idempotency-key'] = randomIdempotencyKey();
  return headers;
}

function buildWebHeaders({ resVersion, clientVersion, loginType, deviceSpecificId, sessionToken, playerId }) {
  const normalizedLoginType = String(loginType || 'android').toLowerCase() === 'ios' ? 'ios' : 'android';
  const uaPrefix = normalizedLoginType === 'ios' ? 'inspix-ios' : 'inspix-android';
  const headers = {
    'x-res-version': resVersion,
    'x-client-version': clientVersion,
    'x-device-type': normalizedLoginType,
    'inspix-user-api-version': USER_API_VERSION,
    accept: 'application/json',
    'x-api-key': API_KEY,
    'user-agent': `${uaPrefix}/${clientVersion}`,
    'x-device-specific-id': deviceSpecificId,
    authorization: `Bearer ${sessionToken}`,
    'x-llll-id': playerId,
  };
  return headers;
}

function extractGachaIdsFromYaml(yamlPath) {
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`GachaSeries yaml not found: ${yamlPath}`);
  }
  const text = fs.readFileSync(yamlPath, 'utf8');
  const ids = new Set();
  for (const m of text.matchAll(/^- Id:\s*(\d+)/gm)) {
    ids.add(m[1]);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

function extractMembershipIdsFromSource(membershipFilePath) {
  if (!fs.existsSync(membershipFilePath)) return ['3001', '3002', '3003', '3004'];
  const text = fs.readFileSync(membershipFilePath, 'utf8');
  const ids = new Set();
  for (const m of text.matchAll(/\b(300\d)\s*:/g)) ids.add(m[1]);
  if (!ids.size) return ['3001', '3002', '3003', '3004'];
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

function extractSelectTicketSeriesIdsFromMasterdata(masterdataDir) {
  const set = new Set();
  const seriesPath = path.join(masterdataDir, 'SelectTicketSeries.yaml');
  const exchangeRatePath = path.join(masterdataDir, 'SelectTicketExchangeRate.yaml');

  if (fs.existsSync(seriesPath)) {
    const text = fs.readFileSync(seriesPath, 'utf8');
    for (const m of text.matchAll(/^- Id:\s*(\d+)/gm)) {
      set.add(String(m[1]));
    }
  }

  if (fs.existsSync(exchangeRatePath)) {
    const text = fs.readFileSync(exchangeRatePath, 'utf8');
    for (const m of text.matchAll(/SelectTicketSeriesId:\s*(\d+)/g)) {
      set.add(String(m[1]));
    }
  }

  return [...set].sort((a, b) => Number(a) - Number(b));
}

async function fetchEndpoint({ url, headers, targetDir, targetBaseName, sourceTag }) {
  const record = {
    url,
    sourceTag,
    status: 0,
    ok: false,
    contentType: '',
    size: 0,
    outputFile: '',
    note: '',
  };

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30000),
    });

    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';
    const text = bytes.toString('utf8');
    const parsed = safeJsonParse(text);

    record.status = res.status;
    record.ok = res.ok;
    record.contentType = contentType;
    record.size = bytes.length;

    let ext = '.bin';
    let contentToWrite = bytes;
    if (contentType.includes('application/json') || parsed.ok) {
      ext = '.json';
      const jsonText = parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;
      contentToWrite = Buffer.from(jsonText, 'utf8');
    } else if (contentType.startsWith('text/')) {
      ext = '.txt';
      contentToWrite = Buffer.from(text, 'utf8');
    }

    const baseName = targetBaseName.toLowerCase().endsWith(ext) ? targetBaseName.slice(0, -ext.length) : targetBaseName;
    const outPath = path.join(targetDir, `${baseName}${ext}`);
    fs.writeFileSync(outPath, contentToWrite);
    record.outputFile = outPath;

    if (!res.ok) {
      record.note = `HTTP ${res.status}`;
    }
  } catch (error) {
    record.ok = false;
    record.status = 0;
    record.note = error instanceof Error ? error.message : String(error);
  }

  return record;
}

async function runPool(items, worker, concurrency = 6) {
  let index = 0;
  async function oneWorker() {
    while (index < items.length) {
      const i = index;
      index += 1;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => oneWorker()));
}

async function resolveSessionAuth({
  authMode,
  playerId,
  password,
  resVersion,
  clientVersion,
  loginType,
  sessionTokenInput,
  deviceSpecificIdInput,
}) {
  if (authMode === 'session') {
    if (!sessionTokenInput) {
      throw new Error(
        'Missing session token for session auth mode. ' +
        'Provide --session-token, set SESSION_TOKEN, or include credential.session_token in config.',
      );
    }
    if (!deviceSpecificIdInput) {
      throw new Error(
        'Missing device specific id for session auth mode. ' +
        'Provide --device-specific-id, set DEVICE_SPECIFIC_ID, or include credential.device_specific_id in config.',
      );
    }
    return {
      deviceSpecificId: deviceSpecificIdInput,
      sessionToken: sessionTokenInput,
      authSource: 'session-token',
    };
  }

  const loginBaseHeaders = buildApiHeaders({
    resVersion,
    clientVersion,
    loginType,
    withIdempotency: true,
  });

  const connectResp = await postJson(
    `${API_BASE}/account/connect`,
    loginBaseHeaders,
    {
      provider: 1,
      player_id: playerId,
      id_token: password,
      platform_type: 1,
    },
  );
  if (!connectResp.ok || !connectResp.json?.device_specific_id) {
    throw new Error(
      `account/connect failed: status=${connectResp.status}. ` +
      'If you already have a valid session token, retry with --use-session-token.',
    );
  }

  const deviceSpecificId = String(connectResp.json.device_specific_id);
  const loginHeaders = buildApiHeaders({
    resVersion,
    clientVersion,
    loginType,
    deviceSpecificId,
    withIdempotency: true,
  });

  const userLoginResp = await postJson(
    `${API_BASE}/user/login`,
    loginHeaders,
    {
      player_id: playerId,
      device_specific_id: deviceSpecificId,
      version: 1,
    },
  );
  if (!userLoginResp.ok || !userLoginResp.json?.session_token) {
    throw new Error(
      `user/login failed: status=${userLoginResp.status}. ` +
      'If you already have a valid session token, retry with --use-session-token.',
    );
  }

  return {
    deviceSpecificId,
    sessionToken: String(userLoginResp.json.session_token),
    authSource: 'connect-login',
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (asBool(args.help) || asBool(args.h)) {
    printHelp();
    return;
  }

  const root = process.cwd();

  const explicitConfigPath = args['config-path'] || process.env.LINKURA_CONFIG_PATH || '';
  const defaultConfigCandidates = [
    path.join(root, 'config', 'linkura-cli', 'config.json'),
    path.join(process.env.USERPROFILE || '', '.config', 'linkura-cli', 'config.json'),
  ];
  const configPath = explicitConfigPath || firstExistingPath(defaultConfigCandidates) || defaultConfigCandidates[0];

  const explicitMasterdataDir = args['masterdata-dir'] || process.env.MASTERDATA_DIR || '';
  const defaultMasterdataDirCandidates = [
    path.join(root, 'masterdata'),
    path.join(root, 'data', 'masterdata'),
  ];
  const masterdataDir = explicitMasterdataDir || firstExistingPath(defaultMasterdataDirCandidates) || defaultMasterdataDirCandidates[0];

  const gachaYamlPath = args['gacha-yaml'] || process.env.GACHA_YAML || path.join(masterdataDir, 'GachaSeries.yaml');
  const membershipSourcePath = path.join(root, 'src', 'page', 'explain', 'membership', 'membership.tsx');
  if (!fs.existsSync(masterdataDir)) {
    throw new Error(
      `Masterdata directory not found: ${masterdataDir}\n` +
      'Provide --masterdata-dir <path> or set MASTERDATA_DIR.',
    );
  }
  if (!fs.existsSync(gachaYamlPath)) {
    throw new Error(
      `GachaSeries YAML not found: ${gachaYamlPath}\n` +
      'Provide --gacha-yaml <path> or place GachaSeries.yaml under the selected masterdata directory.',
    );
  }

  const configExists = fs.existsSync(configPath);
  const cfg = configExists ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const loginTypeRaw = String(args['login-type'] || process.env.LOGIN_TYPE || cfg.login_type || DEFAULT_LOGIN_TYPE).toLowerCase();
  const loginType = loginTypeRaw === 'ios' ? 'ios' : 'android';
  const resVersion = String(args['res-version'] || process.env.RES_VERSION || cfg.credential?.res_version || DEFAULT_RES_VERSION);
  const clientVersion = String(args['client-version'] || process.env.CLIENT_VERSION || cfg.credential?.client_version || DEFAULT_CLIENT_VERSION);
  const configPlayerId = String(cfg.credential?.player_id || '');
  const configSessionToken = String(cfg.credential?.session_token || '');
  const configDeviceSpecificId = String(cfg.credential?.device_specific_id || '');

  const authModeRaw = String(args['auth-mode'] || '').trim().toLowerCase();
  const useSessionToken = asBool(args['use-session-token']);
  let authMode = 'connect';
  if (authModeRaw) {
    if (!['connect', 'session'].includes(authModeRaw)) {
      throw new Error(`Invalid --auth-mode value: ${authModeRaw}. Expected "connect" or "session".`);
    }
    authMode = authModeRaw;
  }
  if (useSessionToken) {
    authMode = 'session';
  }

  const playerId = String(args['player-id'] || process.env.PLAYER_ID || configPlayerId || '');
  const password = String(args.password || process.env.PLAYER_PASSWORD || '');
  const sessionTokenInput = String(args['session-token'] || process.env.SESSION_TOKEN || configSessionToken || '');
  const deviceSpecificIdInput = String(args['device-specific-id'] || process.env.DEVICE_SPECIFIC_ID || configDeviceSpecificId || '');

  if (!playerId) {
    throw new Error(
      'Missing player id: provide --player-id, set PLAYER_ID, or include credential.player_id in config.',
    );
  }
  if (authMode === 'connect' && !password) {
    throw new Error(
      'Missing credentials for connect auth mode: provide --password (or PLAYER_PASSWORD), ' +
      'or use --use-session-token with a valid session token.',
    );
  }

  if (!resVersion || !clientVersion) {
    throw new Error(
      'Missing version headers: provide --res-version/--client-version, set RES_VERSION/CLIENT_VERSION, ' +
      'or include them in config.',
    );
  }

  const outputRoot = args['out-dir'] || path.join(root, 'reports', `api_content_${nowStamp()}`);
  const responseDir = path.join(outputRoot, 'responses');
  ensureDir(responseDir);

  const auth = await resolveSessionAuth({
    authMode,
    playerId,
    password,
    resVersion,
    clientVersion,
    loginType,
    sessionTokenInput,
    deviceSpecificIdInput,
  });

  const webHeaders = buildWebHeaders({
    resVersion,
    clientVersion,
    loginType,
    deviceSpecificId: auth.deviceSpecificId,
    sessionToken: auth.sessionToken,
    playerId,
  });

  const gachaIds = extractGachaIdsFromYaml(gachaYamlPath);
  const membershipIds = extractMembershipIdsFromSource(membershipSourcePath);
  const selectTicketSeriesIdsFromMasterdata = extractSelectTicketSeriesIdsFromMasterdata(masterdataDir);

  const records = [];
  const skipped = [
    { endpoint: '/api/radio_form', reason: 'mutating_form_endpoint' },
    { endpoint: '/api/contact', reason: 'mutating_form_endpoint' },
    { endpoint: '/api/serial_code', reason: 'mutating_form_endpoint' },
  ];

  const singletonTasks = [
    { url: `${WEB_BASE}/api/weblive/id`, sourceTag: 'singleton' },
    { url: `${WEB_BASE}/api/extra/news.json`, sourceTag: 'singleton' },
    { url: `${WEB_BASE}/api/school_idol_connect_post/theme_list`, sourceTag: 'singleton' },
  ];
  for (const task of singletonTasks) {
    const name = sanitizeName(task.url.replace(WEB_BASE, '').replace(/^\/+/, ''));
    const rec = await fetchEndpoint({
      url: task.url,
      headers: webHeaders,
      targetDir: responseDir,
      targetBaseName: name,
      sourceTag: task.sourceTag,
    });
    records.push(rec);
  }

  const membershipTasks = membershipIds.map((id) => ({
    id,
    url: `${WEB_BASE}/api/shop/membership_perk_detail?membership_id=${encodeURIComponent(id)}`,
  }));

  await runPool(
    membershipTasks,
    async (task) => {
      const name = sanitizeName(`api_shop_membership_perk_detail_membership_id_${task.id}`);
      const rec = await fetchEndpoint({
        url: task.url,
        headers: webHeaders,
        targetDir: responseDir,
        targetBaseName: name,
        sourceTag: 'membership_id',
      });
      records.push(rec);
    },
    4,
  );

  const selectTicketIds = new Set();
  for (const rec of records.filter((r) => r.url.includes('/api/shop/membership_perk_detail'))) {
    if (!rec.outputFile || !fs.existsSync(rec.outputFile)) continue;
    if (!rec.outputFile.endsWith('.json')) continue;
    const text = fs.readFileSync(rec.outputFile, 'utf8');
    const parsed = safeJsonParse(text);
    if (!parsed.ok || !parsed.value) continue;
    const list = parsed.value.select_ticket_serieses;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && item.id !== undefined && item.id !== null) {
        selectTicketIds.add(String(item.id));
      }
    }
  }

  const gachaTasks = gachaIds.map((id) => ({
    id,
    url: `${WEB_BASE}/api/gacha/detail?gacha_series_id=${encodeURIComponent(id)}`,
  }));

  await runPool(
    gachaTasks,
    async (task) => {
      const name = sanitizeName(`api_gacha_detail_gacha_series_id_${task.id}`);
      const rec = await fetchEndpoint({
        url: task.url,
        headers: webHeaders,
        targetDir: responseDir,
        targetBaseName: name,
        sourceTag: 'gacha_series_id',
      });
      records.push(rec);
    },
    8,
  );

  const mergedSelectTicketIds = new Set([
    ...selectTicketSeriesIdsFromMasterdata,
    ...selectTicketIds,
  ]);

  const selectCardTasks = [...mergedSelectTicketIds].sort((a, b) => Number(a) - Number(b)).map((id) => ({
    id,
    url: `${WEB_BASE}/api/gacha/select_card_list?select_ticket_series_id=${encodeURIComponent(id)}`,
  }));

  await runPool(
    selectCardTasks,
    async (task) => {
      const name = sanitizeName(`api_gacha_select_card_list_select_ticket_series_id_${task.id}`);
      const rec = await fetchEndpoint({
        url: task.url,
        headers: webHeaders,
        targetDir: responseDir,
        targetBaseName: name,
        sourceTag: 'select_ticket_series_id',
      });
      records.push(rec);
    },
    6,
  );

  records.sort((a, b) => a.url.localeCompare(b.url));

  const failed = records.filter((r) => !r.ok);
  const summary = {
    generatedAt: new Date().toISOString(),
    outputDir: outputRoot,
    configPath,
    configExists,
    gachaIdCount: gachaIds.length,
    membershipIdCount: membershipIds.length,
    selectTicketSeriesIdCountMembershipApi: selectTicketIds.size,
    selectTicketSeriesIdCountMasterdata: selectTicketSeriesIdsFromMasterdata.length,
    selectTicketSeriesIdCountMerged: mergedSelectTicketIds.size,
    totalRequests: records.length,
    success: records.length - failed.length,
    failed: failed.length,
    skipped: skipped.length,
    skippedItems: skipped,
    login: {
      authMode,
      authSource: auth.authSource,
      playerId,
      loginType,
      resVersion,
      clientVersion,
      deviceSpecificIdSuffix: auth.deviceSpecificId.slice(-8),
    },
  };

  fs.writeFileSync(path.join(outputRoot, 'api-fetch-report.json'), JSON.stringify(records, null, 2), 'utf8');
  fs.writeFileSync(path.join(outputRoot, 'api-fetch-unresolved.json'), JSON.stringify(failed, null, 2), 'utf8');
  fs.writeFileSync(path.join(outputRoot, 'api-fetch-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`Output: ${outputRoot}`);
  console.log(`Gacha IDs: ${gachaIds.length}`);
  console.log(`Membership IDs: ${membershipIds.length}`);
  console.log(`Select ticket IDs from membership API: ${selectTicketIds.size}`);
  console.log(`Select ticket IDs from masterdata: ${selectTicketSeriesIdsFromMasterdata.length}`);
  console.log(`Select ticket IDs merged: ${mergedSelectTicketIds.size}`);
  console.log(`Auth mode: ${authMode} (${auth.authSource})`);
  console.log(`Requests: total=${records.length}, success=${records.length - failed.length}, failed=${failed.length}, skipped=${skipped.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

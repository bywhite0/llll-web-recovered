import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function findLatestApiContentDir(reportsRoot) {
  if (!fs.existsSync(reportsRoot)) {
    throw new Error(`Reports root not found: ${reportsRoot}`);
  }
  const dirs = fs
    .readdirSync(reportsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^api_content_\d{8}_\d{6}$/.test(d.name))
    .map((d) => d.name)
    .sort();

  if (!dirs.length) {
    throw new Error(`No api_content_* directory found under ${reportsRoot}`);
  }
  return path.join(reportsRoot, dirs[dirs.length - 1]);
}

function safeReadJson(filePath, fallbackValue = null) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSelectCardListPayload(payload) {
  if (!isPlainObject(payload)) return null;
  if (!Array.isArray(payload.select_ticket_list)) return null;

  const selectTicketList = payload.select_ticket_list.map((item) => {
    const entry = isPlainObject(item) ? item : {};
    const cardsRaw = Array.isArray(entry.cards) ? entry.cards : [];
    const cards = cardsRaw
      .map((card) => {
        if (!isPlainObject(card)) return null;
        const normalized = {
          rarity: String(card.rarity ?? '').trim(),
          name: String(card.name ?? '').trim(),
          description: String(card.description ?? '').trim(),
        };
        const limited = String(card.limited ?? '').trim();
        if (limited) normalized.limited = limited;
        return normalized;
      })
      .filter(Boolean);

    return {
      exchange_ticket_name: String(entry.exchange_ticket_name ?? '').trim(),
      cards,
    };
  });

  return { select_ticket_list: selectTicketList };
}

function loadSelectCardIndex(selectCardIndexPath) {
  if (!fs.existsSync(selectCardIndexPath)) {
    throw new Error(
      `Select card index not found: ${selectCardIndexPath}\n` +
      'Run `pnpm run build:select-card-index -- --masterdata-dir "<path-to-masterdata>"` first.',
    );
  }

  const parsed = safeReadJson(selectCardIndexPath, null);
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Invalid select card index JSON: ${selectCardIndexPath}\n` +
      'Failed to parse JSON. Rebuild it with `pnpm run build:select-card-index`.',
    );
  }

  const byIdRaw = parsed.selectCardListById;
  if (!isPlainObject(byIdRaw)) {
    throw new Error(
      `Invalid select card index schema: ${selectCardIndexPath}\n` +
      'Expected top-level `selectCardListById` object.',
    );
  }

  const byId = {};
  for (const [id, payload] of Object.entries(byIdRaw)) {
    const key = String(id).trim();
    if (!key) continue;
    const normalized = normalizeSelectCardListPayload(payload);
    if (!normalized) {
      throw new Error(
        `Invalid select card payload for id=${key} in ${selectCardIndexPath}\n` +
        'Each payload must have `select_ticket_list` array.',
      );
    }
    byId[key] = normalized;
  }

  return {
    generatedAt: String(parsed.generatedAt ?? ''),
    sourceMasterdataDir: String(parsed.sourceMasterdataDir ?? ''),
    selectCardListById: byId,
  };
}

function buildSelectCardListByIdFromSnapshots(apiContentDir) {
  const responsesDir = path.join(apiContentDir, 'responses');
  if (!fs.existsSync(responsesDir)) {
    throw new Error(`Responses directory not found: ${responsesDir}`);
  }

  const byId = {};
  const files = fs.readdirSync(responsesDir);
  for (const name of files) {
    const match = name.match(/^api_gacha_select_card_list_select_ticket_series_id_(\d+)\.json$/);
    if (!match) continue;
    const payload = safeReadJson(path.join(responsesDir, name), null);
    const normalized = normalizeSelectCardListPayload(payload);
    if (!normalized) continue;
    byId[match[1]] = normalized;
  }

  return byId;
}

function buildSnapshotIndex(apiContentDir) {
  const responsesDir = path.join(apiContentDir, 'responses');
  if (!fs.existsSync(responsesDir)) {
    throw new Error(`Responses directory not found: ${responsesDir}`);
  }

  const gachaDetailById = {};
  const membershipById = {};
  const selectCardListById = buildSelectCardListByIdFromSnapshots(apiContentDir);
  const files = fs.readdirSync(responsesDir);

  for (const name of files) {
    const gachaMatch = name.match(/^api_gacha_detail_gacha_series_id_(\d+)\.json$/);
    if (gachaMatch) {
      gachaDetailById[gachaMatch[1]] = safeReadJson(path.join(responsesDir, name), null);
      continue;
    }

    const membershipMatch = name.match(/^api_shop_membership_perk_detail_membership_id_(\d+)\.json$/);
    if (membershipMatch) {
      membershipById[membershipMatch[1]] = safeReadJson(path.join(responsesDir, name), null);
    }
  }

  return {
    gachaDetailById,
    membershipById,
    selectCardListById,
    singleton: {
      webliveId: safeReadJson(path.join(responsesDir, 'api_weblive_id.json'), { url: 'https://weblive.link-like-lovelive.app/live/' }),
      extraNews: safeReadJson(path.join(responsesDir, 'api_extra_news.json'), []),
      schoolIdolConnectPostThemeList: safeReadJson(path.join(responsesDir, 'api_school_idol_connect_post_theme_list.json'), []),
    },
  };
}

export function buildLocalApiIndex(options = {}) {
  const cwd = options.cwd || process.cwd();
  const reportsRoot = options.reportsRoot || path.join(cwd, 'reports');
  const apiContentDir = options.apiContentDir || findLatestApiContentDir(reportsRoot);
  const selectCardIndexPath = options.selectCardIndexPath || path.join(cwd, 'reports', 'api_overlay', 'select-card-list-index.json');

  const snapshotIndex = buildSnapshotIndex(apiContentDir);
  const selectCardIndex = loadSelectCardIndex(selectCardIndexPath);
  const selectCardListById = {
    ...selectCardIndex.selectCardListById,
    ...snapshotIndex.selectCardListById,
  };

  const selectCardSourceCounts = {
    jsonCount: Object.keys(selectCardIndex.selectCardListById).length,
    apiValidCount: Object.keys(snapshotIndex.selectCardListById).length,
    mergedCount: Object.keys(selectCardListById).length,
  };

  const index = {
    meta: {
      generatedAt: new Date().toISOString(),
      reportsRoot,
      apiContentDir,
      selectCardIndexPath,
      selectCardIndexGeneratedAt: selectCardIndex.generatedAt,
      selectCardIndexSourceMasterdataDir: selectCardIndex.sourceMasterdataDir,
      selectCardSourceCounts,
    },
    routes: {
      selectCardListById,
      gachaDetailById: snapshotIndex.gachaDetailById,
      membershipPerkDetailById: snapshotIndex.membershipById,
      singleton: snapshotIndex.singleton,
    },
  };

  return index;
}

function writeIndexArtifacts(index, outDir, writeData = false) {
  ensureDir(outDir);
  const summary = {
    ...index.meta,
    counts: {
      selectCardList: Object.keys(index.routes.selectCardListById).length,
      gachaDetail: Object.keys(index.routes.gachaDetailById).length,
      membershipPerkDetail: Object.keys(index.routes.membershipPerkDetailById).length,
      singleton: Object.keys(index.routes.singleton).length,
    },
  };
  fs.writeFileSync(path.join(outDir, 'index-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  if (writeData) {
    fs.writeFileSync(path.join(outDir, 'select-card-list-route-index.json'), JSON.stringify(index.routes.selectCardListById, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'gacha-detail-index.json'), JSON.stringify(index.routes.gachaDetailById, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'membership-perk-detail-index.json'), JSON.stringify(index.routes.membershipPerkDetailById, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'singleton-index.json'), JSON.stringify(index.routes.singleton, null, 2), 'utf8');
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const reportsRoot = args['reports-root'] || path.join(cwd, 'reports');
  const apiContentDir = args['api-content-dir'] || findLatestApiContentDir(reportsRoot);
  const selectCardIndexPath = args['select-card-index-path'] || path.join(cwd, 'reports', 'api_overlay', 'select-card-list-index.json');
  const outDir = args['out-dir'] || path.join(cwd, 'reports', 'api_overlay');
  const writeData = String(args['write-data'] || 'false').toLowerCase() === 'true';

  const index = buildLocalApiIndex({
    cwd,
    reportsRoot,
    apiContentDir,
    selectCardIndexPath,
  });
  const summary = writeIndexArtifacts(index, outDir, writeData);
  console.log(`Built local API index from: ${summary.apiContentDir}`);
  console.log(`Select card index: ${summary.selectCardIndexPath}`);
  console.log(`Output: ${outDir}`);
  console.log(`Counts: selectCardList=${summary.counts.selectCardList}, gachaDetail=${summary.counts.gachaDetail}, membershipPerkDetail=${summary.counts.membershipPerkDetail}`);
  console.log(
    `Select card sources: json=${summary.selectCardSourceCounts.jsonCount}, ` +
    `apiValid=${summary.selectCardSourceCounts.apiValidCount}, merged=${summary.selectCardSourceCounts.mergedCount}`,
  );
}

const isDirectRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

import fs from 'node:fs';
import path from 'node:path';

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

function unquote(input) {
  const s = String(input ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseSimpleYamlRecords(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`YAML not found: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const rows = [];
  let current = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('- ')) {
      if (current) rows.push(current);
      current = {};
      const rest = line.slice(2);
      const index = rest.indexOf(':');
      if (index > -1) {
        const key = rest.slice(0, index).trim();
        const value = unquote(rest.slice(index + 1));
        current[key] = value;
      }
      continue;
    }

    if (!current) continue;
    const index = line.indexOf(':');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = unquote(line.slice(index + 1));
    current[key] = value;
  }

  if (current) rows.push(current);
  return rows;
}

function numberOrZero(input) {
  const n = Number(input);
  return Number.isFinite(n) ? n : 0;
}

function buildSelectTicketSeriesMap(masterdataDir) {
  const filePath = path.join(masterdataDir, 'SelectTicketSeries.yaml');
  const rows = parseSimpleYamlRecords(filePath);
  const byId = {};
  for (const row of rows) {
    const id = String(row.Id || '').trim();
    if (!id) continue;
    byId[id] = {
      exchange_ticket_name: String(row.ExchangeTicketName || '').trim(),
    };
  }
  return byId;
}

function buildSelectTicketExchangeMap(masterdataDir) {
  const filePath = path.join(masterdataDir, 'SelectTicketExchangeRate.yaml');
  const rows = parseSimpleYamlRecords(filePath);
  const bySeriesId = {};

  for (const row of rows) {
    const seriesId = String(row.SelectTicketSeriesId || '').trim();
    if (!seriesId) continue;
    const exchangeItemType = numberOrZero(row.ExchangeItemType);
    if (exchangeItemType !== 2) continue;
    const exchangeItemId = String(row.ExchangeItemId || '').trim();
    if (!exchangeItemId) continue;
    if (!bySeriesId[seriesId]) bySeriesId[seriesId] = [];
    bySeriesId[seriesId].push(exchangeItemId);
  }

  for (const key of Object.keys(bySeriesId)) {
    bySeriesId[key] = [...new Set(bySeriesId[key])];
  }

  return bySeriesId;
}

function buildCardMap(masterdataDir) {
  const cardRows = parseSimpleYamlRecords(path.join(masterdataDir, 'CardDatas.yaml'));
  const rarityRows = parseSimpleYamlRecords(path.join(masterdataDir, 'CardRarities.yaml'));

  const rarityById = {};
  for (const row of rarityRows) {
    const id = String(row.Id || '').trim();
    if (!id) continue;
    rarityById[id] = String(row.RarityName || '').trim();
  }

  const cardsById = {};
  for (const row of cardRows) {
    const id = String(row.Id || '').trim();
    if (!id) continue;
    const rarityId = String(row.Rarity || '').trim();
    cardsById[id] = {
      rarity: rarityById[rarityId] || rarityId || 'R',
      name: String(row.Name || '').trim(),
      description: String(row.Description || '').trim(),
    };
  }
  return cardsById;
}

function buildSelectCardListById(masterdataDir) {
  const seriesById = buildSelectTicketSeriesMap(masterdataDir);
  const exchangesBySeriesId = buildSelectTicketExchangeMap(masterdataDir);
  const cardsById = buildCardMap(masterdataDir);

  const allSeriesIds = new Set([...Object.keys(seriesById), ...Object.keys(exchangesBySeriesId)]);
  const result = {};

  for (const seriesId of [...allSeriesIds].sort((a, b) => Number(a) - Number(b))) {
    const exchangeTicketName = seriesById[seriesId]?.exchange_ticket_name || `Select Ticket ${seriesId}`;
    const cardIds = exchangesBySeriesId[seriesId] || [];
    const cards = [];
    const dedupe = new Set();

    for (const cardId of cardIds) {
      const card = cardsById[cardId];
      if (!card) continue;
      const key = `${card.rarity}|${card.name}|${card.description}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      cards.push({
        rarity: card.rarity,
        name: card.name,
        description: card.description,
      });
    }

    result[seriesId] = {
      select_ticket_list: [
        {
          exchange_ticket_name: exchangeTicketName,
          cards,
        },
      ],
    };
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const masterdataDir = args['masterdata-dir'];
  const outFile = args['out-file'] || path.join(root, 'reports', 'api_overlay', 'select-card-list-index.json');

  if (!masterdataDir) {
    throw new Error('Missing required argument: --masterdata-dir "<path-to-masterdata>"');
  }

  const selectCardListById = buildSelectCardListById(masterdataDir);
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceMasterdataDir: path.resolve(masterdataDir),
    selectCardListById,
  };

  ensureDir(path.dirname(outFile));
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`Generated select card index: ${outFile}`);
  console.log(`Source masterdata: ${payload.sourceMasterdataDir}`);
  console.log(`Series count: ${Object.keys(selectCardListById).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CURRENT_BUNDLE_URL = 'https://link-like-lovelive.app/client.mjs';
const DEFAULT_CURRENT_MAP_URL = 'https://link-like-lovelive.app/client.mjs.map';

function parseArgs(argv) {
  const args = {};

  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;

    const eqIndex = current.indexOf('=');
    if (eqIndex >= 0) {
      const key = current.slice(2, eqIndex);
      const value = current.slice(eqIndex + 1);
      if (args[key] === undefined) {
        args[key] = value;
      } else if (Array.isArray(args[key])) {
        args[key].push(value);
      } else {
        args[key] = [args[key], value];
      }
      continue;
    }

    const key = current.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      if (args[key] === undefined) {
        args[key] = next;
      } else if (Array.isArray(args[key])) {
        args[key].push(next);
      } else {
        args[key] = [args[key], next];
      }
      i += 1;
    } else {
      args[key] = 'true';
    }
  }

  return args;
}

function asBool(value) {
  if (value === true) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y' || normalized === 'on';
}

function asList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
  }
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toPosixPath(inputPath) {
  return inputPath.replace(/\\/g, '/');
}

function printHelp() {
  console.log(`Usage:
  node scripts/sync-bundle-snapshots.mjs [options]

Options:
  --current-bundle-url <url>        Current bundle URL (default: ${DEFAULT_CURRENT_BUNDLE_URL})
  --current-map-url <url>           Current source-map URL (default: ${DEFAULT_CURRENT_MAP_URL})
  --current-dir <dir>               Output dir for current snapshot (default: snapshots/current)
  --legacy-dir <dir>                Output dir for legacy snapshot (default: snapshots/2026-01-07)
  --legacy-bundle-file <path>       Optional local legacy client.mjs source path
  --legacy-map-file <path>          Optional local legacy client.mjs.map source path (repeatable or comma-separated)
  --skip-legacy                     Skip legacy copy stage
  --overwrite                       Overwrite existing files
  --attempts <n>                    Download attempts for current bundle/map (default: 5)
  --timeout-ms <ms>                 Per-request timeout in ms (default: 30000)
  --help                            Show this help
`);
}

async function downloadToFile(url, filePath, attempts, timeoutMs, overwrite) {
  if (!overwrite && fs.existsSync(filePath)) {
    return {
      status: 'skipped-existing',
      bytes: fs.statSync(filePath).size,
      source: url,
    };
  }

  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'llll-web-snapshot-sync/2.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, bytes);
      return {
        status: 'downloaded',
        bytes: bytes.length,
        source: url,
      };
    } catch (error) {
      lastError = error;
      if (i < attempts) {
        await new Promise((resolve) => setTimeout(resolve, i * 1000));
      }
    }
  }

  return {
    status: 'failed',
    bytes: 0,
    source: url,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

function copyLocalFile(sourceCandidates, targetPath, overwrite) {
  if (!overwrite && fs.existsSync(targetPath)) {
    return {
      status: 'skipped-existing',
      bytes: fs.statSync(targetPath).size,
      source: '(existing)',
    };
  }

  for (const sourcePath of sourceCandidates) {
    if (!sourcePath) continue;
    if (!fs.existsSync(sourcePath)) continue;
    ensureDir(path.dirname(targetPath));
    const bytes = fs.readFileSync(sourcePath);
    fs.writeFileSync(targetPath, bytes);
    return {
      status: 'copied',
      bytes: bytes.length,
      source: sourcePath,
    };
  }

  return {
    status: 'missing-source',
    bytes: 0,
    source: sourceCandidates.join(', '),
  };
}

function summarizeCurrentResult(bundleResult, mapResult) {
  const hasFailure = bundleResult.status === 'failed' || mapResult.status === 'failed';
  return hasFailure ? 'failed' : 'ok';
}

async function main() {
  const args = parseArgs(process.argv);
  if (asBool(args.help) || asBool(args.h)) {
    printHelp();
    return;
  }

  const root = process.cwd();
  const snapshotsRoot = path.join(root, 'snapshots');
  const currentDir = path.resolve(root, String(args['current-dir'] || path.join('snapshots', 'current')));
  const legacyDir = path.resolve(root, String(args['legacy-dir'] || path.join('snapshots', '2026-01-07')));

  const currentBundleUrl = String(args['current-bundle-url'] || DEFAULT_CURRENT_BUNDLE_URL);
  const currentMapUrl = String(args['current-map-url'] || DEFAULT_CURRENT_MAP_URL);
  const attempts = Number.parseInt(String(args.attempts || '5'), 10);
  const timeoutMs = Number.parseInt(String(args['timeout-ms'] || '30000'), 10);
  const overwrite = asBool(args.overwrite);
  const skipLegacy = asBool(args['skip-legacy']);

  const legacyBundleCandidates = asList(args['legacy-bundle-file']);
  const legacyMapCandidates = asList(args['legacy-map-file']);

  ensureDir(snapshotsRoot);
  ensureDir(currentDir);
  ensureDir(legacyDir);

  const summary = {
    generatedAt: new Date().toISOString(),
    options: {
      currentBundleUrl,
      currentMapUrl,
      currentDir: toPosixPath(path.relative(root, currentDir)),
      legacyDir: toPosixPath(path.relative(root, legacyDir)),
      overwrite,
      attempts,
      timeoutMs,
      skipLegacy,
      legacyBundleCandidates: legacyBundleCandidates.map((item) => toPosixPath(item)),
      legacyMapCandidates: legacyMapCandidates.map((item) => toPosixPath(item)),
    },
    current: {},
    legacy: {},
  };

  const currentBundlePath = path.join(currentDir, 'client.mjs');
  const currentMapPath = path.join(currentDir, 'client.mjs.map');

  const currentBundleResult = await downloadToFile(
    currentBundleUrl,
    currentBundlePath,
    Math.max(1, attempts),
    Math.max(1000, timeoutMs),
    overwrite,
  );
  const currentMapResult = await downloadToFile(
    currentMapUrl,
    currentMapPath,
    Math.max(1, attempts),
    Math.max(1000, timeoutMs),
    overwrite,
  );

  summary.current.bundle = currentBundleResult;
  summary.current.map = currentMapResult;
  summary.current.status = summarizeCurrentResult(currentBundleResult, currentMapResult);

  if (skipLegacy) {
    summary.legacy.status = 'skipped';
    summary.legacy.note = '--skip-legacy is enabled';
  } else {
    const legacyBundlePath = path.join(legacyDir, 'client.mjs');
    const legacyMapPath = path.join(legacyDir, 'client.mjs.map');

    const hasLegacySources = legacyBundleCandidates.length > 0 || legacyMapCandidates.length > 0;
    if (!hasLegacySources) {
      summary.legacy.status = 'skipped';
      summary.legacy.note = 'No --legacy-bundle-file/--legacy-map-file provided.';
    } else {
      const legacyBundleResult = copyLocalFile(legacyBundleCandidates, legacyBundlePath, overwrite);
      const legacyMapResult = copyLocalFile(legacyMapCandidates, legacyMapPath, overwrite);
      summary.legacy.bundle = legacyBundleResult;
      summary.legacy.map = legacyMapResult;
      summary.legacy.status =
        legacyBundleResult.status === 'missing-source' || legacyMapResult.status === 'missing-source'
          ? 'partial'
          : 'ok';
    }
  }

  const reportsDir = path.join(root, 'reports');
  ensureDir(reportsDir);
  const reportPath = path.join(reportsDir, 'bundle-snapshots.json');
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('Synced bundle snapshots:');
  console.log(`- current bundle: ${summary.current.bundle.status}`);
  console.log(`- current map: ${summary.current.map.status}`);
  console.log(`- legacy stage: ${summary.legacy.status}`);
  console.log(`- report: ${toPosixPath(path.relative(root, reportPath))}`);

  if (summary.current.status === 'failed') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

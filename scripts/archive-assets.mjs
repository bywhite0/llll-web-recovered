#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  outRoot: path.join('snapshots', 'archive', 'current'),
  overwrite: false,
  concurrency: 12,
  timeoutMs: 30000,
  retries: 3,
  dryRun: false,
};

const BUNDLE_TARGETS = [
  { name: 'client.mjs', url: 'https://link-like-lovelive.app/client.mjs' },
  { name: 'client.mjs.map', url: 'https://link-like-lovelive.app/client.mjs.map' },
];

const ALLOWED_RULES = [
  { host: 'link-like-lovelive.app', pathnamePrefix: '/images/' },
  { host: 'assets.link-like-lovelive.app', pathnamePrefix: '/news/img/' },
];

const URL_PATTERN = /https?:\/\/[^"'`\s)<\\]+/g;
const IMAGE_PATH_PATTERN = /\/images\/[^"'`\s)<\\]+/g;
const NEWS_HOST_PATH_PATTERN = /\/assets\.link-like-lovelive\.app\/news\/img\/[^"'`\s)<\\]+/g;

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5',
  'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5',
  'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function printHelp() {
  console.log(`Usage:
  node scripts/archive-assets.mjs [options]

Options:
  --out-root=snapshots/archive/current   Output root directory
  --overwrite                            Overwrite existing files
  --concurrency=12                       Asset download concurrency
  --timeout=30000                        Request timeout (ms)
  --retries=3                            Retry count for failed requests
  --dry-run                              Plan mode (no files written)
  --help                                 Show this help
`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  function readValue(currentArg, index) {
    const eqIndex = currentArg.indexOf('=');
    if (eqIndex >= 0) return { value: currentArg.slice(eqIndex + 1), nextIndex: index };
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${currentArg}`);
    return { value: next, nextIndex: index + 1 };
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--overwrite') {
      options.overwrite = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith('--out-root')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      options.outRoot = value.trim();
      continue;
    }
    if (arg.startsWith('--concurrency')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --concurrency value: ${value}`);
      options.concurrency = parsed;
      continue;
    }
    if (arg.startsWith('--timeout')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --timeout value: ${value}`);
      options.timeoutMs = parsed;
      continue;
    }
    if (arg.startsWith('--retries')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid --retries value: ${value}`);
      options.retries = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function toPosixPath(p) {
  return p.split(path.sep).join('/');
}

function asErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function shortHash(value) {
  return sha256(Buffer.from(String(value), 'utf8')).slice(0, 8);
}

function sanitizeSegment(segment) {
  let value = String(segment ?? '');
  value = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  value = value.replace(/[. ]+$/g, '');
  if (!value) value = '_';
  if (value === '.' || value === '..') value = value.replace(/\./g, '_');
  if (WINDOWS_RESERVED_NAMES.has(value.toUpperCase())) value = `_${value}`;
  return value;
}

function appendSuffixToFileName(fileName, suffix) {
  const ext = path.posix.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${base}${suffix}${ext}`;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function mkdirIfNeeded(targetPath, dryRun) {
  if (dryRun) return;
  await fs.mkdir(targetPath, { recursive: true });
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(new Error(`Timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'llll-web-archive-orchestrator/2.0' },
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchBufferWithRetries(url, options) {
  let lastError = null;
  let lastStatusCode = null;
  let lastContentType = null;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options.timeoutMs);
      lastStatusCode = response.status;
      lastContentType = response.headers.get('content-type') ?? '';
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        error.statusCode = response.status;
        throw error;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        ok: true,
        bytes,
        statusCode: response.status,
        contentType: lastContentType,
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error;
      if (attempt < options.retries) await sleep(500 * 2 ** attempt);
    }
  }

  return {
    ok: false,
    bytes: null,
    statusCode: lastStatusCode,
    contentType: lastContentType,
    attempts: options.retries + 1,
    error: asErrorMessage(lastError),
  };
}

function extractCandidatesFromText(text) {
  const candidates = [];
  const patterns = [URL_PATTERN, IMAGE_PATH_PATTERN, NEWS_HOST_PATH_PATTERN];
  for (const pattern of patterns) {
    const matches = text.match(pattern) ?? [];
    candidates.push(...matches);
  }
  return candidates;
}

function cleanCandidate(raw) {
  let value = String(raw ?? '').trim();
  value = value.replace(/\\\//g, '/');
  value = value.replace(/\\u002F/gi, '/');
  value = value.replace(/[\\'"`]+$/g, '');
  value = value.replace(/[)>;,]+$/g, '');
  return value;
}

function isAllowedUrl(url) {
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;
  return ALLOWED_RULES.some((rule) => host === rule.host && pathname.startsWith(rule.pathnamePrefix));
}

function normalizeCandidateToUrl(rawCandidate) {
  const cleaned = cleanCandidate(rawCandidate);
  if (!cleaned) return null;

  let url;
  if (cleaned.startsWith('/images/')) {
    url = new URL(`https://link-like-lovelive.app${cleaned}`);
  } else if (cleaned.startsWith('/assets.link-like-lovelive.app/news/img/')) {
    const suffix = cleaned.slice('/assets.link-like-lovelive.app'.length);
    url = new URL(`https://assets.link-like-lovelive.app${suffix}`);
  } else if (/^https?:\/\//i.test(cleaned)) {
    url = new URL(cleaned);
  } else {
    return null;
  }

  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.protocol === 'http:') url.protocol = 'https:';
  url.hash = '';
  if (!isAllowedUrl(url)) return null;
  return url.toString();
}

function mapUrlToAssetRelativePath(urlString) {
  const url = new URL(urlString);
  const hostSegment = sanitizeSegment(url.hostname.toLowerCase());
  const pathSegments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));

  if (pathSegments.length === 0) pathSegments.push('index.bin');
  if (url.search) {
    const last = pathSegments[pathSegments.length - 1];
    pathSegments[pathSegments.length - 1] = appendSuffixToFileName(last, `__q_${shortHash(url.search)}`);
  }

  return path.posix.join('assets', hostSegment, ...pathSegments);
}

function buildAssetTasks(bundleText, mapText, outRootAbs) {
  const urlToSources = new Map();
  const scanStats = {
    bundleCandidates: 0,
    mapCandidates: 0,
    accepted: 0,
    rejected: 0,
    uniqueAccepted: 0,
    filteredMapOnlyLinkLikeImages: 0,
  };

  const sources = [
    { name: 'bundle', text: bundleText },
    { name: 'map', text: mapText },
  ];

  for (const source of sources) {
    const rawCandidates = extractCandidatesFromText(source.text);
    if (source.name === 'bundle') scanStats.bundleCandidates = rawCandidates.length;
    if (source.name === 'map') scanStats.mapCandidates = rawCandidates.length;

    for (const candidate of rawCandidates) {
      const normalized = normalizeCandidateToUrl(candidate);
      if (!normalized) {
        scanStats.rejected += 1;
        continue;
      }
      scanStats.accepted += 1;
      if (!urlToSources.has(normalized)) urlToSources.set(normalized, new Set());
      urlToSources.get(normalized).add(source.name);
    }
  }

  const tasks = [...urlToSources.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([url, sourceSet]) => {
      const parsed = new URL(url);
      const isLinkLikeImage = parsed.hostname === 'link-like-lovelive.app' && parsed.pathname.startsWith('/images/');
      if (isLinkLikeImage && !sourceSet.has('bundle')) {
        scanStats.filteredMapOnlyLinkLikeImages += 1;
        return [];
      }

      const targetPath = mapUrlToAssetRelativePath(url);
      return [{
        url,
        targetPath,
        targetAbsPath: path.join(outRootAbs, ...targetPath.split('/')),
        sourceTags: [...sourceSet].sort(),
      }];
    });

  scanStats.uniqueAccepted = tasks.length;
  return { tasks, scanStats };
}

async function runWithConcurrency(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  if (items.length === 0) return results;

  const workerCount = Math.min(concurrency, items.length);
  let nextIndex = 0;
  let done = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;

      const item = items[currentIndex];
      const result = await worker(item, currentIndex);
      results[currentIndex] = result;
      done += 1;
      if (onProgress) onProgress(done, items.length, item, result);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function prepareBundles(options, paths) {
  const entries = [];
  const texts = {};
  const failures = [];

  await mkdirIfNeeded(paths.bundleDir, options.dryRun);

  for (const target of BUNDLE_TARGETS) {
    const targetAbs = path.join(paths.bundleDir, target.name);
    const targetRel = toPosixPath(path.relative(paths.outRoot, targetAbs));
    const alreadyExists = await exists(targetAbs);

    const entry = {
      kind: 'bundle',
      name: target.name,
      url: target.url,
      targetPath: targetRel,
      status: '',
      statusCode: null,
      contentType: '',
      bytes: null,
      sha256: '',
      attempts: 0,
      note: '',
    };

    if (alreadyExists && !options.overwrite) {
      try {
        const existingBytes = await fs.readFile(targetAbs);
        texts[target.name] = existingBytes.toString('utf8');
        entry.bytes = existingBytes.byteLength;
        entry.sha256 = sha256(existingBytes);
        entry.status = options.dryRun ? 'planned-skip-existing' : 'skipped-existing';
        entry.note = 'using existing local file';
      } catch (error) {
        entry.status = 'failed';
        entry.note = `Failed to read existing file: ${asErrorMessage(error)}`;
        failures.push(entry);
      }
      entries.push(entry);
      continue;
    }

    const fetched = await fetchBufferWithRetries(target.url, options);
    entry.attempts = fetched.attempts;
    entry.statusCode = fetched.statusCode ?? null;
    entry.contentType = fetched.contentType ?? '';

    if (!fetched.ok || !fetched.bytes) {
      entry.status = 'failed';
      entry.note = fetched.error || 'Download failed';
      failures.push(entry);
      entries.push(entry);
      continue;
    }

    entry.bytes = fetched.bytes.byteLength;
    entry.sha256 = sha256(fetched.bytes);
    texts[target.name] = fetched.bytes.toString('utf8');

    if (!options.dryRun) {
      await mkdirIfNeeded(path.dirname(targetAbs), false);
      await fs.writeFile(targetAbs, fetched.bytes);
      entry.status = 'downloaded';
      entry.note = 'ok';
    } else {
      entry.status = 'planned-download';
      entry.note = 'download planned (dry-run)';
    }

    entries.push(entry);
  }

  return {
    entries,
    failures,
    bundleText: texts['client.mjs'] ?? '',
    mapText: texts['client.mjs.map'] ?? '',
  };
}

async function downloadAssetTask(task, options) {
  const result = {
    kind: 'asset',
    url: task.url,
    targetPath: task.targetPath,
    sourceTags: task.sourceTags,
    status: '',
    statusCode: null,
    contentType: '',
    bytes: null,
    sha256: '',
    attempts: 0,
    note: '',
    timestamp: new Date().toISOString(),
  };

  const alreadyExists = await exists(task.targetAbsPath);
  if (alreadyExists && !options.overwrite) {
    result.status = options.dryRun ? 'planned-skip-existing' : 'skipped-existing';
    try {
      const stat = await fs.stat(task.targetAbsPath);
      result.bytes = stat.size;
    } catch {
      result.bytes = null;
    }
    result.note = 'using existing local file';
    return result;
  }

  if (options.dryRun) {
    result.status = 'planned-download';
    result.note = 'download planned (dry-run)';
    return result;
  }

  const fetched = await fetchBufferWithRetries(task.url, options);
  result.attempts = fetched.attempts;
  result.statusCode = fetched.statusCode ?? null;
  result.contentType = fetched.contentType ?? '';

  if (!fetched.ok || !fetched.bytes) {
    result.status = 'failed';
    result.note = fetched.error || 'Download failed';
    return result;
  }

  result.bytes = fetched.bytes.byteLength;
  if (result.contentType && !result.contentType.toLowerCase().startsWith('image/')) {
    result.status = 'unexpected_content_type';
    result.note = `Expected image/* but received ${result.contentType}`;
    return result;
  }

  await mkdirIfNeeded(path.dirname(task.targetAbsPath), false);
  await fs.writeFile(task.targetAbsPath, fetched.bytes);
  result.sha256 = sha256(fetched.bytes);
  result.status = 'downloaded';
  result.note = 'ok';
  return result;
}

function sourceToSegments(source) {
  const normalized = String(source ?? '').replace(/\\/g, '/');

  const urlMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/);
  if (urlMatch) {
    const scheme = urlMatch[1].toLowerCase();
    const rest = urlMatch[2];
    const slashIndex = rest.indexOf('/');
    const host = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest;
    const tail = slashIndex >= 0 ? rest.slice(slashIndex + 1) : '';
    return ['url', scheme, host, ...tail.split('/')];
  }

  const schemePathMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/(.*)$/);
  if (schemePathMatch && !/^[A-Za-z]:\//.test(normalized)) {
    const scheme = schemePathMatch[1].toLowerCase();
    const tail = schemePathMatch[2];
    return ['scheme', scheme, ...tail.split('/')];
  }

  const windowsNormalized = normalized.replace(/^([a-zA-Z]):\//, '$1_/');
  return windowsNormalized.split('/');
}

function resolveSourceRelativePath(source, index, usedPaths) {
  const segments = sourceToSegments(source);
  const safeSegments = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      safeSegments.push('__up__');
      continue;
    }
    safeSegments.push(sanitizeSegment(segment));
  }

  if (safeSegments.length === 0) safeSegments.push(`source_${index}`);

  let basePath = path.posix.join(...safeSegments);
  if (basePath.endsWith('/')) basePath = `${basePath}__index__.txt`;

  let finalPath = basePath;
  let collisionResolved = false;
  let suffixIndex = 1;
  while (usedPaths.has(finalPath) && usedPaths.get(finalPath) !== source) {
    collisionResolved = true;
    finalPath = appendSuffixToFileName(basePath, `__dup_${suffixIndex}`);
    suffixIndex += 1;
  }
  usedPaths.set(finalPath, source);

  return { finalPath, collisionResolved };
}

async function unpackSourceMap(options, paths, mapText) {
  let parsed;
  try {
    parsed = JSON.parse(mapText);
  } catch (error) {
    throw new Error(`Unable to parse client.mjs.map JSON: ${asErrorMessage(error)}`);
  }

  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sourcesContent = Array.isArray(parsed.sourcesContent) ? parsed.sourcesContent : [];
  const usedPaths = new Map();
  const entries = [];

  await mkdirIfNeeded(paths.mapSourcesDir, options.dryRun);

  let missingContent = 0;
  let written = 0;
  let skippedExisting = 0;
  let plannedWrite = 0;
  let collisionResolvedCount = 0;

  for (let i = 0; i < sources.length; i += 1) {
    const source = String(sources[i] ?? '');
    const content = typeof sourcesContent[i] === 'string' ? sourcesContent[i] : null;
    const { finalPath, collisionResolved } = resolveSourceRelativePath(source, i, usedPaths);
    const targetPath = path.posix.join('map-unpacked', 'sources', finalPath);
    const targetAbsPath = path.join(paths.outRoot, ...targetPath.split('/'));
    const bytes = content == null ? 0 : Buffer.byteLength(content, 'utf8');
    const contentHash = content == null ? '' : sha256(Buffer.from(content, 'utf8'));

    let status = '';
    let note = '';
    if (content == null) {
      status = 'missing-content';
      note = 'sourcesContent entry missing';
      missingContent += 1;
    } else if (options.dryRun) {
      status = 'planned-write';
      note = 'write planned (dry-run)';
      plannedWrite += 1;
    } else if (!options.overwrite && (await exists(targetAbsPath))) {
      status = 'skipped-existing';
      note = 'using existing local file';
      skippedExisting += 1;
    } else {
      await mkdirIfNeeded(path.dirname(targetAbsPath), false);
      await fs.writeFile(targetAbsPath, content, 'utf8');
      status = 'written';
      note = 'ok';
      written += 1;
    }

    if (collisionResolved) collisionResolvedCount += 1;

    entries.push({
      index: i,
      source,
      targetPath,
      status,
      bytes,
      sha256: contentHash,
      hasContent: content != null,
      collisionResolved,
      note,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    totalSources: sources.length,
    withContent: sources.length - missingContent,
    missingContent,
    written,
    skippedExisting,
    plannedWrite,
    collisionResolved: collisionResolvedCount,
  };

  if (!options.dryRun) {
    await fs.writeFile(path.join(paths.mapDir, 'index.json'), JSON.stringify(entries, null, 2), 'utf8');
    await fs.writeFile(path.join(paths.mapDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  }

  return { entries, summary };
}

function summarizeAssetResults(results) {
  const summary = {
    total: results.length,
    downloaded: 0,
    skippedExisting: 0,
    plannedDownload: 0,
    plannedSkipExisting: 0,
    failed: 0,
    unexpectedContentType: 0,
  };

  for (const item of results) {
    if (item.status === 'downloaded') summary.downloaded += 1;
    if (item.status === 'skipped-existing') summary.skippedExisting += 1;
    if (item.status === 'planned-download') summary.plannedDownload += 1;
    if (item.status === 'planned-skip-existing') summary.plannedSkipExisting += 1;
    if (item.status === 'failed') summary.failed += 1;
    if (item.status === 'unexpected_content_type') summary.unexpectedContentType += 1;
  }

  return summary;
}

function summarizeBundleResults(results) {
  const summary = {
    total: results.length,
    downloaded: 0,
    skippedExisting: 0,
    plannedDownload: 0,
    plannedSkipExisting: 0,
    failed: 0,
  };

  for (const item of results) {
    if (item.status === 'downloaded') summary.downloaded += 1;
    if (item.status === 'skipped-existing') summary.skippedExisting += 1;
    if (item.status === 'planned-download') summary.plannedDownload += 1;
    if (item.status === 'planned-skip-existing') summary.plannedSkipExisting += 1;
    if (item.status === 'failed') summary.failed += 1;
  }

  return summary;
}

async function writeReports(paths, payloads, dryRun) {
  if (dryRun) return;
  await mkdirIfNeeded(paths.reportsDir, false);

  const writers = [
    ['bundle-manifest.json', payloads.bundleEntries],
    ['asset-manifest.json', payloads.assetEntries],
    ['asset-extraction.json', payloads.extractionSummary],
    ['map-unpack-summary.json', payloads.mapSummary],
    ['failures.json', payloads.failures],
    ['run-summary.json', payloads.runSummary],
  ];

  for (const [name, data] of writers) {
    await fs.writeFile(path.join(paths.reportsDir, name), JSON.stringify(data, null, 2), 'utf8');
  }
}

function createPaths(cwd, outRoot) {
  const outRootAbs = path.resolve(cwd, outRoot);
  return {
    cwd,
    outRoot: outRootAbs,
    bundleDir: path.join(outRootAbs, 'bundle'),
    assetsDir: path.join(outRootAbs, 'assets'),
    mapDir: path.join(outRootAbs, 'map-unpacked'),
    mapSourcesDir: path.join(outRootAbs, 'map-unpacked', 'sources'),
    reportsDir: path.join(outRootAbs, 'reports'),
  };
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const paths = createPaths(cwd, options.outRoot);
  const startedAt = nowIso();
  const stageReports = [];
  const failures = [];

  if (!options.dryRun) {
    await mkdirIfNeeded(paths.outRoot, false);
  }

  console.log(`[archive] outRoot=${toPosixPath(path.relative(cwd, paths.outRoot) || '.')}`);
  console.log(
    `[archive] mode=${options.dryRun ? 'dry-run' : 'write'}, overwrite=${options.overwrite}, concurrency=${options.concurrency}, timeoutMs=${options.timeoutMs}, retries=${options.retries}`,
  );

  const bundleStage = {
    name: 'bundle',
    startedAt: nowIso(),
    success: false,
    stats: {},
  };

  const bundleResult = await prepareBundles(options, paths);
  bundleStage.finishedAt = nowIso();
  bundleStage.stats = summarizeBundleResults(bundleResult.entries);
  bundleStage.success = bundleResult.failures.length === 0 && Boolean(bundleResult.bundleText) && Boolean(bundleResult.mapText);
  if (!bundleStage.success) {
    failures.push(
      ...bundleResult.failures.map((item) => ({
        stage: 'bundle',
        ...item,
      })),
    );
    if (!bundleResult.bundleText || !bundleResult.mapText) {
      failures.push({
        stage: 'bundle',
        status: 'failed',
        note: 'Missing required text content from client.mjs or client.mjs.map',
      });
    }
  }
  stageReports.push(bundleStage);

  let extractionSummary = {
    bundleCandidates: 0,
    mapCandidates: 0,
    accepted: 0,
    rejected: 0,
    uniqueAccepted: 0,
  };
  let assetEntries = [];
  let mapSummary = null;

  if (bundleStage.success) {
    const extractionStage = {
      name: 'extract-assets',
      startedAt: nowIso(),
      success: true,
      stats: {},
    };

    const extraction = buildAssetTasks(bundleResult.bundleText, bundleResult.mapText, paths.outRoot);
    extractionSummary = extraction.scanStats;
    extractionStage.stats = {
      ...extraction.scanStats,
      plannedAssets: extraction.tasks.length,
    };
    extractionStage.finishedAt = nowIso();
    stageReports.push(extractionStage);

    const assetStage = {
      name: 'download-assets',
      startedAt: nowIso(),
      success: true,
      stats: {},
    };

    if (!options.dryRun) {
      await mkdirIfNeeded(paths.assetsDir, false);
    }

    assetEntries = await runWithConcurrency(
      extraction.tasks,
      options.concurrency,
      (task) => downloadAssetTask(task, options),
      (done, total, task, result) => {
        if (result.status === 'failed' || result.status === 'unexpected_content_type') {
          console.warn(`[archive] asset issue (${done}/${total}): ${task.url} -> ${result.status} (${result.note})`);
          return;
        }
        if (done % 50 === 0 || done === total) {
          console.log(`[archive] assets progress ${done}/${total}`);
        }
      },
    );

    const failedAssets = assetEntries.filter((item) => item.status === 'failed' || item.status === 'unexpected_content_type');
    if (failedAssets.length > 0) {
      assetStage.success = false;
      failures.push(
        ...failedAssets.map((item) => ({
          stage: 'download-assets',
          ...item,
        })),
      );
    }
    assetStage.stats = summarizeAssetResults(assetEntries);
    assetStage.finishedAt = nowIso();
    stageReports.push(assetStage);

    const mapStage = {
      name: 'unpack-source-map',
      startedAt: nowIso(),
      success: false,
      stats: {},
    };

    try {
      if (!options.dryRun) {
        await mkdirIfNeeded(paths.mapDir, false);
      }
      const mapResult = await unpackSourceMap(options, paths, bundleResult.mapText);
      mapSummary = mapResult.summary;
      mapStage.success = true;
      mapStage.stats = mapResult.summary;
    } catch (error) {
      mapStage.success = false;
      mapStage.error = asErrorMessage(error);
      failures.push({
        stage: 'unpack-source-map',
        status: 'failed',
        note: asErrorMessage(error),
      });
    } finally {
      mapStage.finishedAt = nowIso();
      stageReports.push(mapStage);
    }
  }

  const failedStages = stageReports.filter((stage) => !stage.success).map((stage) => stage.name);
  const runSummary = {
    generatedAt: nowIso(),
    startedAt,
    finishedAt: nowIso(),
    outRoot: toPosixPath(path.relative(cwd, paths.outRoot) || '.'),
    options: {
      outRoot: options.outRoot,
      overwrite: options.overwrite,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      dryRun: options.dryRun,
    },
    status: failedStages.length > 0 || failures.length > 0 ? 'failed' : 'success',
    failedStages,
    stageReports,
    counts: {
      failures: failures.length,
      bundle: summarizeBundleResults(bundleResult.entries),
      assets: summarizeAssetResults(assetEntries),
      mapUnpack: mapSummary ?? {},
      extraction: extractionSummary,
    },
  };

  await writeReports(
    paths,
    {
      bundleEntries: bundleResult.entries,
      assetEntries,
      extractionSummary,
      mapSummary,
      failures,
      runSummary,
    },
    options.dryRun,
  );

  console.log('[archive] summary:');
  console.log(`  status=${runSummary.status}`);
  console.log(`  failedStages=${runSummary.failedStages.join(', ') || '(none)'}`);
  console.log(`  failures=${runSummary.counts.failures}`);
  console.log(`  assets total=${runSummary.counts.assets.total}`);
  console.log(`  assets downloaded=${runSummary.counts.assets.downloaded}`);
  console.log(`  assets skipped-existing=${runSummary.counts.assets.skippedExisting}`);
  console.log(`  assets planned-download=${runSummary.counts.assets.plannedDownload}`);
  console.log(`  assets planned-skip-existing=${runSummary.counts.assets.plannedSkipExisting}`);
  console.log(`  assets failed=${runSummary.counts.assets.failed}`);
  console.log(`  assets unexpected-content-type=${runSummary.counts.assets.unexpectedContentType}`);
  if (!options.dryRun) {
    console.log(`[archive] wrote reports: ${toPosixPath(path.relative(cwd, paths.reportsDir))}`);
  }

  if (runSummary.status !== 'success') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[archive] fatal error: ${asErrorMessage(error)}`);
  process.exitCode = 1;
});

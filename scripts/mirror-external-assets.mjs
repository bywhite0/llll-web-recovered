#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  mode: 'bundle-map',
  srcRoots: ['src'],
  bundleFiles: [
    path.join('snapshots', 'archive', 'current', 'bundle', 'client.mjs'),
    path.join('snapshots', 'archive', 'current', 'bundle', 'client.mjs.map'),
  ],
  archiveAssetsRoot: path.join('snapshots', 'archive', 'current', 'assets'),
  outRoot: 'public/external',
  concurrency: 8,
  timeoutMs: 30000,
  retries: 2,
  overwrite: false,
  dryRun: false,
  includeTemplateUrls: false,
};

const ALLOWED_URL_RULES = [
  { host: 'assets.link-like-lovelive.app', pathnamePrefix: '/news/img/' },
];

const SCAN_EXTENSIONS = new Set([
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.json',
  '.txt',
  '.md',
  '.map',
]);

const URL_REGEX = /https?:\/\/[^\s"'`<>\\)]+/g;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function printHelp() {
  console.log(`Usage:
  node scripts/mirror-external-assets.mjs [options]

Options:
  --mode=bundle-map                    URL source mode: bundle-map | src-scan (default: bundle-map)
  --bundle-file=<path>                 Bundle/map file for URL extraction (repeatable or comma-separated)
  --src=<path>                         Source root(s) for legacy src-scan mode (repeatable or comma-separated)
  --archive-assets-root=<path>         Archive assets root for local copy fallback (default: snapshots/archive/current/assets)
  --out=public/external                Output root for mirrored files
  --concurrency=8                      Download concurrency
  --timeout=30000                      Per-request timeout in ms
  --retries=2                          Retry count for failed downloads
  --overwrite                          Overwrite existing files
  --dry-run                            Print URL -> output mapping only (no writes)
  --include-template-urls              Include template-like URLs containing \${...}
  --help                               Show this help
`);
}

function parseListValue(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const srcRoots = [...DEFAULTS.srcRoots];
  const bundleFiles = [...DEFAULTS.bundleFiles];

  function readValue(currentArg, index) {
    const eqIndex = currentArg.indexOf('=');
    if (eqIndex >= 0) {
      return { value: currentArg.slice(eqIndex + 1), nextIndex: index };
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${currentArg}`);
    }
    return { value: next, nextIndex: index + 1 };
  }

  let explicitMode = false;
  let explicitSrc = false;
  let explicitBundleFile = false;

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
    if (arg === '--include-template-urls') {
      options.includeTemplateUrls = true;
      continue;
    }
    if (arg.startsWith('--mode')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      options.mode = String(value).trim().toLowerCase();
      explicitMode = true;
      continue;
    }
    if (arg.startsWith('--src')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      srcRoots.push(...parseListValue(value));
      explicitSrc = true;
      continue;
    }
    if (arg.startsWith('--bundle-file')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      bundleFiles.push(...parseListValue(value));
      explicitBundleFile = true;
      continue;
    }
    if (arg.startsWith('--out')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      options.outRoot = value.trim();
      continue;
    }
    if (arg.startsWith('--archive-assets-root')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      options.archiveAssetsRoot = value.trim();
      continue;
    }
    if (arg.startsWith('--concurrency')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --concurrency value: ${value}`);
      }
      options.concurrency = parsed;
      continue;
    }
    if (arg.startsWith('--timeout')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeout value: ${value}`);
      }
      options.timeoutMs = parsed;
      continue;
    }
    if (arg.startsWith('--retries')) {
      const { value, nextIndex } = readValue(arg, i);
      i = nextIndex;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --retries value: ${value}`);
      }
      options.retries = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!explicitMode && explicitSrc && !explicitBundleFile) {
    options.mode = 'src-scan';
  }

  if (!['bundle-map', 'src-scan'].includes(options.mode)) {
    throw new Error(`Invalid --mode value: ${options.mode}`);
  }

  options.srcRoots = [...new Set(srcRoots)].filter(Boolean);
  options.bundleFiles = [...new Set(bundleFiles)].filter(Boolean);
  return options;
}

function toPosixPath(p) {
  return p.split(path.sep).join('/');
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function sanitizeSegment(segment) {
  let value = segment ?? '';
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

function mapUrlToRelativePath(urlString) {
  const url = new URL(urlString);
  const hostSegment = sanitizeSegment(url.host.toLowerCase());
  const rawSegments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));

  const dirSegments = [hostSegment];
  let fileName = 'index.html';

  if (!url.pathname || url.pathname.endsWith('/')) {
    dirSegments.push(...rawSegments);
  } else {
    const last = rawSegments.pop() ?? '';
    const ext = path.posix.extname(last);
    if (last && ext) {
      dirSegments.push(...rawSegments);
      fileName = sanitizeSegment(last);
    } else {
      dirSegments.push(...rawSegments);
      if (last) dirSegments.push(last);
      fileName = 'index.html';
    }
  }

  if (url.search) {
    fileName = appendSuffixToFileName(fileName, `__q_${shortHash(url.search)}`);
  }

  return path.posix.join(...dirSegments, fileName);
}

function mapUrlToArchiveAssetRelativePath(urlString) {
  const url = new URL(urlString);
  const hostSegment = sanitizeSegment(url.host.toLowerCase());
  const rawSegments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));

  if (rawSegments.length === 0) return null;
  const last = rawSegments[rawSegments.length - 1];
  const ext = path.posix.extname(last);
  if (!ext) return null;

  let fileName = last;
  if (url.search) {
    fileName = appendSuffixToFileName(fileName, `__q_${shortHash(url.search)}`);
  }

  const dirSegments = rawSegments.slice(0, -1);
  return path.posix.join(hostSegment, ...dirSegments, fileName);
}

function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
  }
  return url.toString();
}

function isTemplateLikeUrl(url) {
  return url.includes('${') || url.includes('}');
}

function isAllowedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;
  return ALLOWED_URL_RULES.some((rule) => host === rule.host && pathname.startsWith(rule.pathnamePrefix));
}

function extractUrls(text, includeTemplateUrls) {
  const matches = text.match(URL_REGEX) ?? [];
  const urls = [];
  for (const match of matches) {
    const cleaned = match.trim().replace(/[\\'"`<>]+$/g, '');
    if (!cleaned) continue;
    if (!includeTemplateUrls && isTemplateLikeUrl(cleaned)) continue;
    urls.push(cleaned);
  }
  return urls;
}

function isScanCandidate(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SCAN_EXTENSIONS.has(ext);
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(rootPath) {
  const files = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isScanCandidate(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function collectSourceFiles(srcRoots, cwd) {
  const files = [];
  for (const root of srcRoots) {
    const absolute = path.resolve(cwd, root);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      console.warn(`[warn] Source root not found, skip: ${root}`);
      continue;
    }
    if (stat.isDirectory()) {
      const walked = await walkFiles(absolute);
      files.push(...walked);
    } else if (stat.isFile() && isScanCandidate(absolute)) {
      files.push(absolute);
    }
  }
  return [...new Set(files)];
}

async function collectBundleFiles(bundleFiles, cwd) {
  const files = [];
  for (const input of bundleFiles) {
    const absolute = path.resolve(cwd, input);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      console.warn(`[warn] Bundle/map file not found, skip: ${input}`);
      continue;
    }
    if (stat.isFile()) {
      files.push(absolute);
    }
  }
  return [...new Set(files)];
}

async function collectUrlSourcesFromFiles(sourceFiles, cwd, includeTemplateUrls) {
  const urlSources = new Map();
  const stats = {
    scannedFiles: sourceFiles.length,
    rawUrls: 0,
    filteredTemplate: 0,
    filteredDisallowed: 0,
    accepted: 0,
  };
  for (const sourceFile of sourceFiles) {
    let content = '';
    try {
      content = await fs.readFile(sourceFile, 'utf8');
    } catch (error) {
      console.warn(`[warn] Failed to read file, skip: ${sourceFile} (${asErrorMessage(error)})`);
      continue;
    }

    const rawMatches = content.match(URL_REGEX) ?? [];
    stats.rawUrls += rawMatches.length;
    for (const match of rawMatches) {
      const cleaned = match.trim().replace(/[\\'"`<>]+$/g, '');
      if (!cleaned) continue;
      if (!includeTemplateUrls && isTemplateLikeUrl(cleaned)) {
        stats.filteredTemplate += 1;
        continue;
      }
      let normalized;
      try {
        normalized = normalizeUrl(cleaned);
      } catch {
        continue;
      }
      if (!isAllowedUrl(normalized)) {
        stats.filteredDisallowed += 1;
        continue;
      }
      stats.accepted += 1;

      if (!urlSources.has(normalized)) urlSources.set(normalized, new Set());
      urlSources.get(normalized).add(sourceFile);
    }
  }
  return { urlSources, stats };
}

function buildTasks(urlSources, outAbs, cwd, options) {
  const targetToUrl = new Map();
  const tasks = [];
  const archiveRootAbs = path.resolve(cwd, options.archiveAssetsRoot);

  for (const url of [...urlSources.keys()].sort()) {
    const baseRelativePath = mapUrlToRelativePath(url);
    let relativePath = baseRelativePath;
    let collisionResolved = false;
    const existingUrl = targetToUrl.get(relativePath);

    if (existingUrl && existingUrl !== url) {
      collisionResolved = true;
      const suffix = `__u_${shortHash(url)}`;
      relativePath = appendSuffixToFileName(baseRelativePath, suffix);
      let guard = 0;
      while (targetToUrl.has(relativePath) && targetToUrl.get(relativePath) !== url) {
        guard += 1;
        relativePath = appendSuffixToFileName(baseRelativePath, `${suffix}_${guard}`);
      }
    }

    targetToUrl.set(relativePath, url);
    const absolutePath = path.join(outAbs, ...relativePath.split('/'));
    const archiveRel = mapUrlToArchiveAssetRelativePath(url);
    const archiveAbs = archiveRel ? path.join(archiveRootAbs, ...archiveRel.split('/')) : null;
    tasks.push({
      url,
      relativePath,
      absolutePath,
      archiveAssetPath: archiveAbs,
      sourceFiles: [...urlSources.get(url)].map((source) => toPosixPath(path.relative(cwd, source))),
      collisionResolved,
    });
  }

  return tasks;
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
    return await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function asErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runWithConcurrency(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function runOneWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;

      const item = items[currentIndex];
      const result = await worker(item, currentIndex);
      results[currentIndex] = result;
      completed += 1;
      if (onProgress) onProgress(completed, items.length, item, result);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runOneWorker()));
  return results;
}

async function downloadTask(task, options, cwd) {
  const localPath = toPosixPath(path.relative(cwd, task.absolutePath));
  const now = new Date().toISOString();

  if (!options.overwrite && (await exists(task.absolutePath))) {
    let bytes = null;
    try {
      const stat = await fs.stat(task.absolutePath);
      bytes = stat.size;
    } catch {
      bytes = null;
    }
    return {
      ok: true,
      status: 'skipped-existing',
      url: task.url,
      filePath: localPath,
      statusCode: null,
      contentType: null,
      bytes,
      attempts: 0,
      sourceFiles: task.sourceFiles,
      collisionResolved: task.collisionResolved,
      timestamp: now,
    };
  }

  if (task.archiveAssetPath && (await exists(task.archiveAssetPath))) {
    await fs.mkdir(path.dirname(task.absolutePath), { recursive: true });
    await fs.copyFile(task.archiveAssetPath, task.absolutePath);
    let bytes = null;
    try {
      const stat = await fs.stat(task.absolutePath);
      bytes = stat.size;
    } catch {
      bytes = null;
    }
    return {
      ok: true,
      status: 'copied-from-archive',
      url: task.url,
      filePath: localPath,
      statusCode: null,
      contentType: null,
      bytes,
      attempts: 0,
      sourceFiles: task.sourceFiles,
      collisionResolved: task.collisionResolved,
      timestamp: now,
      archiveAssetPath: toPosixPath(path.relative(cwd, task.archiveAssetPath)),
    };
  }

  let lastError = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    attempts = attempt + 1;
    try {
      const response = await fetchWithTimeout(task.url, options.timeoutMs);
      const contentType = response.headers.get('content-type');
      const statusCode = response.status;
      if (!response.ok) {
        const error = new Error(`HTTP ${statusCode} ${response.statusText}`.trim());
        error.statusCode = statusCode;
        throw error;
      }

      const bodyBuffer = Buffer.from(await response.arrayBuffer());
      await fs.mkdir(path.dirname(task.absolutePath), { recursive: true });
      await fs.writeFile(task.absolutePath, bodyBuffer);

      return {
        ok: true,
        status: 'downloaded',
        url: task.url,
        filePath: localPath,
        statusCode,
        contentType,
        bytes: bodyBuffer.byteLength,
        attempts,
        sourceFiles: task.sourceFiles,
        collisionResolved: task.collisionResolved,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error;
      if (attempt < options.retries) {
        const delay = 500 * 2 ** attempt;
        await sleep(delay);
      }
    }
  }

  return {
    ok: false,
    status: 'failed',
    url: task.url,
    filePath: localPath,
    statusCode: lastError?.statusCode ?? null,
    contentType: null,
    bytes: null,
    attempts,
    sourceFiles: task.sourceFiles,
    collisionResolved: task.collisionResolved,
    error: asErrorMessage(lastError),
    timestamp: now,
  };
}

async function dryRunTask(task, options, cwd) {
  const localPath = toPosixPath(path.relative(cwd, task.absolutePath));
  const existsAlready = !options.overwrite && (await exists(task.absolutePath));
  const existsInArchive = Boolean(task.archiveAssetPath && (await exists(task.archiveAssetPath)));
  const status = existsAlready
    ? 'planned-skip-existing'
    : existsInArchive
      ? 'planned-copy-from-archive'
      : 'planned';
  return {
    ok: true,
    status,
    url: task.url,
    filePath: localPath,
    statusCode: null,
    contentType: null,
    bytes: null,
    attempts: 0,
    sourceFiles: task.sourceFiles,
    collisionResolved: task.collisionResolved,
    timestamp: new Date().toISOString(),
  };
}

function summarize(entries) {
  const summary = {
    total: entries.length,
    downloaded: 0,
    skippedExisting: 0,
    copiedFromArchive: 0,
    failed: 0,
    planned: 0,
    plannedSkipExisting: 0,
    plannedCopyFromArchive: 0,
  };

  for (const entry of entries) {
    if (entry.status === 'downloaded') summary.downloaded += 1;
    if (entry.status === 'skipped-existing') summary.skippedExisting += 1;
    if (entry.status === 'copied-from-archive') summary.copiedFromArchive += 1;
    if (entry.status === 'failed') summary.failed += 1;
    if (entry.status === 'planned') summary.planned += 1;
    if (entry.status === 'planned-skip-existing') summary.plannedSkipExisting += 1;
    if (entry.status === 'planned-copy-from-archive') summary.plannedCopyFromArchive += 1;
  }

  return summary;
}

async function writeResultFiles(options, cwd, manifestEntries) {
  const outAbs = path.resolve(cwd, options.outRoot);
  const manifestPath = path.join(outAbs, '_manifest.json');
  const failuresPath = path.join(outAbs, '_failures.json');
  const failures = manifestEntries.filter((entry) => entry.status === 'failed');
  const summary = summarize(manifestEntries);

  await fs.mkdir(outAbs, { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        options: {
          mode: options.mode,
          srcRoots: options.srcRoots,
          bundleFiles: options.bundleFiles,
          archiveAssetsRoot: options.archiveAssetsRoot,
          outRoot: options.outRoot,
          concurrency: options.concurrency,
          timeoutMs: options.timeoutMs,
          retries: options.retries,
          overwrite: options.overwrite,
          dryRun: options.dryRun,
          includeTemplateUrls: options.includeTemplateUrls,
        },
        summary,
        entries: manifestEntries,
      },
      null,
      2,
    ),
    'utf8',
  );

  await fs.writeFile(
    failuresPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary: {
          totalFailures: failures.length,
          totalEntries: manifestEntries.length,
        },
        failures,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    manifestRel: toPosixPath(path.relative(cwd, manifestPath)),
    failuresRel: toPosixPath(path.relative(cwd, failuresPath)),
  };
}

async function main() {
  const cwd = process.cwd();
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  let sourceFiles = [];
  if (options.mode === 'src-scan') {
    sourceFiles = await collectSourceFiles(options.srcRoots, cwd);
    if (sourceFiles.length === 0) {
      console.warn('[warn] No source files matched scan rules.');
    }
  } else {
    sourceFiles = await collectBundleFiles(options.bundleFiles, cwd);
    if (sourceFiles.length === 0) {
      throw new Error('No bundle/map files available for URL extraction. Provide --bundle-file paths.');
    }
  }

  const { urlSources, stats: extractionStats } = await collectUrlSourcesFromFiles(sourceFiles, cwd, options.includeTemplateUrls);
  const outAbs = path.resolve(cwd, options.outRoot);
  const tasks = buildTasks(urlSources, outAbs, cwd, options);

  console.log(`[mirror] cwd=${toPosixPath(cwd)}`);
  console.log(`[mirror] mode=${options.mode}`);
  if (options.mode === 'src-scan') {
    console.log(`[mirror] srcRoots=${options.srcRoots.join(', ')}`);
  } else {
    console.log(`[mirror] bundleFiles=${sourceFiles.map((file) => toPosixPath(path.relative(cwd, file))).join(', ')}`);
  }
  console.log(`[mirror] scanFiles=${sourceFiles.length}`);
  console.log(
    `[mirror] urlExtraction raw=${extractionStats.rawUrls}, filtered-template=${extractionStats.filteredTemplate}, filtered-disallowed=${extractionStats.filteredDisallowed}, accepted=${extractionStats.accepted}`,
  );
  console.log(`[mirror] uniqueUrls=${tasks.length}`);
  console.log(`[mirror] outRoot=${toPosixPath(path.relative(cwd, outAbs) || '.')}`);
  console.log(`[mirror] archiveAssetsRoot=${toPosixPath(path.relative(cwd, path.resolve(cwd, options.archiveAssetsRoot)) || '.')}`);
  console.log(
    `[mirror] mode-run=${options.dryRun ? 'dry-run' : 'download'}, concurrency=${options.concurrency}, timeoutMs=${options.timeoutMs}, retries=${options.retries}, overwrite=${options.overwrite}`,
  );

  const worker = options.dryRun
    ? (task) => dryRunTask(task, options, cwd)
    : (task) => downloadTask(task, options, cwd);

  const results = await runWithConcurrency(tasks, options.concurrency, worker, (done, total, task, result) => {
    if (result.status === 'failed') {
      console.warn(`[mirror] fail (${done}/${total}): ${task.url} -> ${result.error}`);
      return;
    }
    if (done % 25 === 0 || done === total) {
      console.log(`[mirror] progress ${done}/${total}`);
    }
  });

  const summary = summarize(results);
  console.log('[mirror] summary:');
  console.log(`  total=${summary.total}`);
  console.log(`  downloaded=${summary.downloaded}`);
  console.log(`  skipped-existing=${summary.skippedExisting}`);
  console.log(`  copied-from-archive=${summary.copiedFromArchive}`);
  console.log(`  failed=${summary.failed}`);
  console.log(`  planned=${summary.planned}`);
  console.log(`  planned-skip-existing=${summary.plannedSkipExisting}`);
  console.log(`  planned-copy-from-archive=${summary.plannedCopyFromArchive}`);

  if (options.dryRun) {
    console.log('[mirror] dry-run mappings:');
    for (const entry of results) {
      console.log(`  ${entry.url} -> ${entry.filePath}`);
    }
    return;
  }

  const paths = await writeResultFiles(options, cwd, results);
  console.log(`[mirror] wrote manifest: ${paths.manifestRel}`);
  console.log(`[mirror] wrote failures: ${paths.failuresRel}`);
}

main().catch((error) => {
  console.error(`[error] ${asErrorMessage(error)}`);
  process.exitCode = 1;
});

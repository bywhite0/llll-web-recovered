#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const mappings = [
  ['app_icon-SWSD5BUR.png', 'src/page/app/store/img/app_icon.png'],
  ['app_store_badge-CYPUFIEU.png', 'src/page/app/store/img/app_store_badge.png'],
  ['google_play_badge-YKO5PUQY.png', 'src/page/app/store/img/google_play_badge.png'],
  ['favicon-2SHVHF36.png', 'src/asset/img/favicon.png'],

  ['membership3001_2604_0-2JVGVNM7.png', 'src/asset/img/membership3001_2604_0.png'],
  ['membership3002_2604_0-RRPNPCKI.png', 'src/asset/img/membership3002_2604_0.png'],
  ['membership3003_2604_0-WFWKV4EJ.png', 'src/asset/img/membership3003_2604_0.png'],
  ['membership3004_2604_0-O76GK7HF.png', 'src/asset/img/membership3004_2604_0.png'],

  ['faq_category_3-SKX364OG.png', 'src/asset/img/faq_category_3.png'],
  ['faq_category_4-JICCVTLE.png', 'src/asset/img/faq_category_4.png'],
  ['faq_category_5-KXKJJVLW.png', 'src/asset/img/faq_category_5.png'],
  ['faq_question-5PGRU6JZ.png', 'src/asset/img/faq_question.png'],
  ['app_store_badge-CYPUFIEU.png', 'src/asset/img/app-store-badge.png'],
  ['google_play_badge-YKO5PUQY.png', 'src/asset/img/google-play-badge.png'],

  ['spring-355QZC5S.png', 'src/page/explain/gacha/images/spring.png'],
  ['summer-CHYRHGS3.png', 'src/page/explain/gacha/images/summer.png'],
  ['autumn-3Y6OS3TC.png', 'src/page/explain/gacha/images/autumn.png'],
  ['winter-MWXYLRRZ.png', 'src/page/explain/gacha/images/winter.png'],
  ['graduation-UEEQWD4E.png', 'src/page/explain/gacha/images/graduation.png'],
  ['party-DGQX6PKS.png', 'src/page/explain/gacha/images/party.png'],
  ['birthday-LFA76SAD.png', 'src/page/explain/gacha/images/birthday.png'],
  ['collaboration-C6UI3H7L.png', 'src/page/explain/gacha/images/collaboration.png'],
  ['collaboration_202-7LHFNJLV.png', 'src/page/explain/gacha/images/collaboration_202.png'],
  ['collaboration_203-ADI5PPJZ.png', 'src/page/explain/gacha/images/collaboration_203.png'],
  ['collaboration_204-O32GYQZ2.png', 'src/page/explain/gacha/images/collaboration_204.png'],
];

const placeholderMappings = [
  ['src/asset/img/faq_category_3.png', 'src/asset/img/faq_category_1.png', 'placeholder_from_faq_category_3'],
  ['src/asset/img/faq_category_4.png', 'src/asset/img/faq_category_2.png', 'placeholder_from_faq_category_4'],
  ['src/page/app/store/img/app_icon.png', 'src/asset/img/sisca_icon.png', 'placeholder_from_app_icon'],
  ['src/asset/img/faq_question.png', 'src/asset/img/plus_icon.png', 'placeholder_from_faq_question'],
];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;

    const eqIndex = current.indexOf('=');
    if (eqIndex >= 0) {
      args[current.slice(2, eqIndex)] = current.slice(eqIndex + 1);
      continue;
    }

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

function asBool(value) {
  if (value === true) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y' || normalized === 'on';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toPosixPath(inputPath) {
  return inputPath.replace(/\\/g, '/');
}

function printHelp() {
  console.log(`Usage:
  node scripts/populate-src-assets.mjs [options]

Options:
  --public-images-dir <dir>         Source directory for hashed image files (default: public/images)
  --source-dir <dir>                Alias of --public-images-dir (backward-compatible convenience)
  --summary-file <file>             JSON summary output (default: reports/asset-populate-summary.json)
  --overwrite                       Overwrite existing target files
  --strict                          Exit with non-zero status if any source file is missing
  --help                            Show this help
`);
}

function createSummary(options) {
  return {
    generatedAt: new Date().toISOString(),
    options,
    stats: {
      concreteTotal: mappings.length,
      concreteCopied: 0,
      concreteSkippedExisting: 0,
      concreteMissingSource: 0,
      placeholderTotal: placeholderMappings.length,
      placeholderCopied: 0,
      placeholderSkippedExisting: 0,
      placeholderMissingSource: 0,
    },
    missingConcrete: [],
    missingPlaceholderSources: [],
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (asBool(args.help) || asBool(args.h)) {
    printHelp();
    return;
  }

  const publicImagesDir = path.resolve(
    root,
    String(args['public-images-dir'] || args['source-dir'] || path.join('public', 'images')),
  );
  const summaryFile = path.resolve(root, String(args['summary-file'] || path.join('reports', 'asset-populate-summary.json')));
  const overwrite = asBool(args.overwrite);
  const strict = asBool(args.strict);

  const summary = createSummary({
    publicImagesDir: toPosixPath(path.relative(root, publicImagesDir)),
    summaryFile: toPosixPath(path.relative(root, summaryFile)),
    overwrite,
    strict,
  });

  for (const [sourceFileName, targetRelativePath] of mappings) {
    const sourceAbs = path.join(publicImagesDir, sourceFileName);
    const targetAbs = path.join(root, targetRelativePath);

    if (!fs.existsSync(sourceAbs)) {
      summary.stats.concreteMissingSource += 1;
      summary.missingConcrete.push({
        source: toPosixPath(path.relative(root, sourceAbs)),
        target: toPosixPath(targetRelativePath),
      });
      continue;
    }

    if (!overwrite && fs.existsSync(targetAbs)) {
      summary.stats.concreteSkippedExisting += 1;
      continue;
    }

    ensureDir(path.dirname(targetAbs));
    fs.copyFileSync(sourceAbs, targetAbs);
    summary.stats.concreteCopied += 1;
  }

  for (const [fromRelativePath, toRelativePath, note] of placeholderMappings) {
    const fromAbs = path.join(root, fromRelativePath);
    const toAbs = path.join(root, toRelativePath);

    if (!fs.existsSync(fromAbs)) {
      summary.stats.placeholderMissingSource += 1;
      summary.missingPlaceholderSources.push({
        source: toPosixPath(fromRelativePath),
        target: toPosixPath(toRelativePath),
        note,
      });
      continue;
    }

    if (!overwrite && fs.existsSync(toAbs)) {
      summary.stats.placeholderSkippedExisting += 1;
      continue;
    }

    ensureDir(path.dirname(toAbs));
    fs.copyFileSync(fromAbs, toAbs);
    summary.stats.placeholderCopied += 1;
  }

  ensureDir(path.dirname(summaryFile));
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`[populate-src-assets] summary: ${toPosixPath(path.relative(root, summaryFile))}`);
  console.log(
    `[populate-src-assets] concrete copied=${summary.stats.concreteCopied}, ` +
    `skipped-existing=${summary.stats.concreteSkippedExisting}, missing=${summary.stats.concreteMissingSource}`,
  );
  console.log(
    `[populate-src-assets] placeholders copied=${summary.stats.placeholderCopied}, ` +
    `skipped-existing=${summary.stats.placeholderSkippedExisting}, missing-source=${summary.stats.placeholderMissingSource}`,
  );

  if (strict && (summary.stats.concreteMissingSource > 0 || summary.stats.placeholderMissingSource > 0)) {
    process.exitCode = 1;
  }
}

main();

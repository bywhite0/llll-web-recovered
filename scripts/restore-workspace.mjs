#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_ARCHIVE_OUT_ROOT = path.join('snapshots', 'archive', 'current');
const DEFAULT_POPULATE_SUMMARY = path.join('reports', 'asset-populate-summary.json');
const DEFAULT_RESTORE_SUMMARY = path.join('reports', 'restore-workspace-summary.json');
const DEFAULT_CONFIG_PATH = path.join(process.env.USERPROFILE || '', '.config', 'linkura-cli', 'config.json');

const BASELINE_DIRS = [
  'dist',
  'public',
  'public/images',
  'public/external',
  'reports',
  'reports/api_overlay',
  'snapshots',
  'snapshots/archive',
  'snapshots/archive/current',
  'tmp',
];

const REQUIRED_SCAFFOLD_FILES = [
  {
    relativePath: path.join('src', 'components', 'index.ts'),
    content: `export { App } from './app/app';
export { Button } from './atom/button/button';
export { default as FileUploader } from './atom/FileUploader/FileUploader';
export { ImgWithAuth } from './atom/ImgWithAuth/ImgWithAuth';
export { HourPicker, MinutePicker } from './atom/TimePicker/TimePicker';
`,
  },
  {
    relativePath: path.join('src', 'components', 'atom', 'TimePicker', 'index.ts'),
    content: `export { HourPicker, MinutePicker } from './TimePicker';
`,
  },
  {
    relativePath: path.join('src', 'config', 'index.ts'),
    content: `export { router } from './router';
export { RadioCategories } from './radio';
`,
  },
  {
    relativePath: path.join('src', 'context', 'index.ts'),
    content: `export { RecaptchaFormFieldName, useRecaptch } from './recaptcha/recaptcha';
`,
  },
  {
    relativePath: path.join('src', 'gacha', 'series.ts'),
    content: `export type GachaCard = {
  id?: number;
  rarity: string;
  name: string;
  description: string;
  odds: number;
  pickup?: boolean;
  limited?: string;
  IsParallel?: boolean;
};

export type GachaRarityRate = {
  name: string;
  odds: number;
};

export type GachaGift = {
  rank: number;
  name: string;
  quantity: number;
  odds: number;
};

export type GachaRate = {
  min: number;
  max: number;
  rarities: GachaRarityRate[];
  cards: GachaCard[];
  items: GachaGift[];
};

export type GachaSeries = {
  id?: number;
  title: string;
  notice?: string;
  paidlimited?: boolean;
  giftless?: boolean;
  rates: GachaRate[];
};

export type SelectTicketCard = {
  rarity: string;
  name: string;
  description: string;
  limited?: string;
};

export type SelectTicketListItem = {
  exchange_ticket_name: string;
  cards: SelectTicketCard[];
};

export type SelectTicket = {
  select_ticket_list: SelectTicketListItem[];
};
`,
  },
  {
    relativePath: path.join('src', 'page', 'index.ts'),
    content: `export { AppStorePage } from './app/store/store';
export { ContactCompletePage } from './contact/complete';
export { ContactPage } from './contact/contact';
export { ContactRadioCompletePage } from './contact/radio_complete';
export { ContactRadioMailPage } from './contact/radio_mail';
export { ExplainArchivePage } from './explain/archive/archive';
export { ExplainGachaListPage } from './explain/gacha/list';
export { ExplainGachaRatePage } from './explain/gacha/rate';
export { ExplainMembershipPage } from './explain/membership/membership';
export { ExplainPlayPtPage } from './explain/playPt/playPt';
export { ExplainPresentCountPage } from './explain/presentCount/presentCount';
export { FaqPage } from './help/faq';
export { HelpPage } from './help/help';
export { LegalCopyrightPage } from './legal/copyright/copyright';
export { LegalCreditsPage } from './legal/credits/credits';
export { LegalLawSettlementPage } from './legal/law/settlement/settlement';
export { LegalLawTransactionPage } from './legal/law/transaction/transaction';
export { LegalLawTransactionAndroidPage } from './legal/law/transaction/transaction_android';
export { LegalLawTransactionIOSPage } from './legal/law/transaction/transaction_ios';
export { LegalPrivacyPage } from './legal/privacy/privacy';
export { LegalTermsPage } from './legal/terms/terms';
export { LivePage } from './live';
export { NewsDetailsPage } from './news/details';
export { NewsPage } from './news/news';
export { SerialCodeFormCompletePage } from './serialCode/form/complete';
export { SerialCodeFormPage } from './serialCode/form/form';
`,
  },
  {
    relativePath: path.join('src', 'page', 'contact', 'types.ts'),
    content: `export type SchoolConnectPostTheme = {
  id: number | string;
  theme: string;
  image_url: string | null;
};
`,
  },
  {
    relativePath: path.join('src', 'page', 'explain', 'membership', 'types.ts'),
    content: `export type ExchangeCard = {
  id: number;
  rarity: number;
  name: string;
  description: string;
};

export type SelectTicketSeries = {
  id: number;
  exchange_ticket_name: string;
  exchange_cards: ExchangeCard[];
};

export type Membership = {
  id?: number;
  name: string;
  notice?: string;
  select_ticket_serieses: SelectTicketSeries[] | null;
};
`,
  },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const eqIndex = current.indexOf('=');
    if (eqIndex >= 0) {
      const key = current.slice(2, eqIndex);
      args[key] = current.slice(eqIndex + 1);
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

function toPosixPath(inputPath) {
  return inputPath.replace(/\\/g, '/');
}

function ensureDir(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function listFilesRecursive(rootDir) {
  const result = [];
  if (!fs.existsSync(rootDir)) return result;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

function copyDirectoryRecursive(sourceDir, targetDir) {
  ensureDir(targetDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function moveDirectory(sourceDir, targetDir) {
  ensureDir(path.dirname(targetDir));
  try {
    fs.renameSync(sourceDir, targetDir);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EXDEV') {
      copyDirectoryRecursive(sourceDir, targetDir);
      fs.rmSync(sourceDir, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/restore-workspace.mjs [options]

Options:
  --overwrite                      Replace existing src and merge unpacked node_modules into existing node_modules
  --with-api-content               Also run select-card-index + credentialed API snapshot fetch
  --masterdata-dir <dir>           Masterdata directory (required when --with-api-content)
  --config-path <file>             Config JSON path for API login flow (optional)
  --player-id <id>                 Player ID (or env PLAYER_ID)
  --password <password>            Password/id_token for connect auth mode (or env PLAYER_PASSWORD)
  --use-session-token              Use session-token auth mode for API stage
  --session-token <token>          Session token override (or env SESSION_TOKEN)
  --device-specific-id <id>        Device specific id override (or env DEVICE_SPECIFIC_ID)
  --gacha-yaml <file>              Optional GachaSeries.yaml path (defaults to <masterdata-dir>/GachaSeries.yaml)
  --archive-out-root <dir>         Archive output root (default: snapshots/archive/current)
  --help                           Show this help
`);
}

function runNodeScript(root, scriptRelativePath, args = []) {
  const scriptAbs = path.join(root, scriptRelativePath);
  if (!fs.existsSync(scriptAbs)) {
    throw new Error(`Script not found: ${scriptRelativePath}`);
  }

  const result = spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): node ${scriptRelativePath} ${args.join(' ')}`.trim());
  }
}

function createStage(name) {
  return {
    name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: false,
    stats: {},
  };
}

function finishStage(stage, success, stats = {}, error = '') {
  stage.finishedAt = new Date().toISOString();
  stage.success = Boolean(success);
  stage.stats = stats;
  if (error) {
    stage.error = error;
  }
}

function ensureBaselineTree(root) {
  let created = 0;
  for (const relativeDir of BASELINE_DIRS) {
    const absPath = path.join(root, relativeDir);
    if (fs.existsSync(absPath)) continue;
    ensureDir(absPath);
    created += 1;
  }
  return { total: BASELINE_DIRS.length, created };
}

function validatePromotionTargets(root, overwrite) {
  const targets = [
    path.join(root, 'src'),
    path.join(root, 'node_modules'),
  ];

  if (overwrite) {
    return {
      overwrite: true,
      existingTargets: targets.filter((target) => fs.existsSync(target)).map((target) => toPosixPath(path.relative(root, target))),
    };
  }

  const existing = targets.filter((target) => fs.existsSync(target));
  if (existing.length > 0) {
    const rel = existing.map((target) => toPosixPath(path.relative(root, target)));
    throw new Error(
      `Promotion targets already exist: ${rel.join(', ')}\n` +
      'Run with --overwrite to replace existing directories.',
    );
  }

  return {
    overwrite: false,
    existingTargets: [],
  };
}

function resolveUnpackedSources(root, archiveRootAbs) {
  const unpackedBase = path.join(archiveRootAbs, 'map-unpacked', 'sources', '__up__');
  const unpackedSrc = path.join(unpackedBase, 'src');
  const unpackedNodeModules = path.join(unpackedBase, 'node_modules');

  if (!fs.existsSync(unpackedBase)) {
    throw new Error(
      `Unpacked source root not found: ${toPosixPath(path.relative(root, unpackedBase))}\n` +
      'Archive step did not produce source-map unpack output.',
    );
  }
  if (!fs.existsSync(unpackedSrc)) {
    throw new Error(`Unpacked src directory not found: ${toPosixPath(path.relative(root, unpackedSrc))}`);
  }
  if (!fs.existsSync(unpackedNodeModules)) {
    throw new Error(`Unpacked node_modules directory not found: ${toPosixPath(path.relative(root, unpackedNodeModules))}`);
  }

  return {
    unpackedBase,
    unpackedSrc,
    unpackedNodeModules,
  };
}

function promoteUnpackedDirectories(root, archiveRootAbs, overwrite) {
  const unpacked = resolveUnpackedSources(root, archiveRootAbs);
  const targetSrc = path.join(root, 'src');
  const targetNodeModules = path.join(root, 'node_modules');
  const nodeModulesPreExisting = fs.existsSync(targetNodeModules);

  if (overwrite) {
    if (fs.existsSync(targetSrc)) fs.rmSync(targetSrc, { recursive: true, force: true });
  }

  moveDirectory(unpacked.unpackedSrc, targetSrc);
  let nodeModulesPromotion = 'moved';
  if (fs.existsSync(targetNodeModules)) {
    if (!overwrite) {
      throw new Error(
        `Promotion target already exists: ${toPosixPath(path.relative(root, targetNodeModules))}\n` +
        'Run with --overwrite to merge unpacked node_modules into existing directory.',
      );
    }
    copyDirectoryRecursive(unpacked.unpackedNodeModules, targetNodeModules);
    fs.rmSync(unpacked.unpackedNodeModules, { recursive: true, force: true });
    nodeModulesPromotion = 'merged-into-existing';
  } else {
    moveDirectory(unpacked.unpackedNodeModules, targetNodeModules);
  }

  const srcCount = listFilesRecursive(targetSrc).length;
  const nodeModulesCount = listFilesRecursive(targetNodeModules).length;

  return {
    from: toPosixPath(path.relative(root, unpacked.unpackedBase)),
    moved: ['src', 'node_modules'],
    nodeModulesPromotion,
    nodeModulesPreExisting,
    srcFiles: srcCount,
    nodeModulesFiles: nodeModulesCount,
  };
}

function ensureRequiredScaffoldFiles(root) {
  let created = 0;
  let skippedExisting = 0;
  const createdFiles = [];
  const skippedFiles = [];

  for (const file of REQUIRED_SCAFFOLD_FILES) {
    const targetAbs = path.join(root, file.relativePath);
    if (fs.existsSync(targetAbs)) {
      skippedExisting += 1;
      skippedFiles.push(toPosixPath(file.relativePath));
      continue;
    }
    ensureDir(path.dirname(targetAbs));
    fs.writeFileSync(targetAbs, file.content, 'utf8');
    created += 1;
    createdFiles.push(toPosixPath(file.relativePath));
  }

  return {
    total: REQUIRED_SCAFFOLD_FILES.length,
    created,
    skippedExisting,
    createdFiles,
    skippedFiles,
  };
}

function restorePublicImages(root, archiveRootAbs, overwrite) {
  const sourceRoot = path.join(archiveRootAbs, 'assets', 'link-like-lovelive.app', 'images');
  const targetRoot = path.join(root, 'public', 'images');

  if (!fs.existsSync(sourceRoot)) {
    throw new Error(
      `Missing archived image root: ${toPosixPath(path.relative(root, sourceRoot))}\n` +
      'Run archive step first to fetch official image assets.',
    );
  }

  if (overwrite && fs.existsSync(targetRoot)) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
  ensureDir(targetRoot);

  const files = listFilesRecursive(sourceRoot);
  let restored = 0;
  let skippedExisting = 0;

  for (const sourceFileAbs of files) {
    const rel = path.relative(sourceRoot, sourceFileAbs);
    const targetAbs = path.join(targetRoot, rel);
    if (!overwrite && fs.existsSync(targetAbs)) {
      skippedExisting += 1;
      continue;
    }
    ensureDir(path.dirname(targetAbs));
    fs.copyFileSync(sourceFileAbs, targetAbs);
    restored += 1;
  }

  return {
    sourceRoot: toPosixPath(path.relative(root, sourceRoot)),
    targetRoot: toPosixPath(path.relative(root, targetRoot)),
    candidates: files.length,
    restored,
    skippedExisting,
  };
}

function validateApiOptions(options) {
  if (!options.masterdataDir) {
    throw new Error('Missing --masterdata-dir (or MASTERDATA_DIR env) for --with-api-content.');
  }

  if (!fs.existsSync(options.masterdataDir)) {
    throw new Error(`masterdata directory not found: ${options.masterdataDir}`);
  }

  if (!options.gachaYamlPath) {
    throw new Error('Unable to resolve gacha yaml path. Provide --gacha-yaml explicitly.');
  }

  if (!fs.existsSync(options.gachaYamlPath)) {
    throw new Error(`Gacha YAML not found: ${options.gachaYamlPath}`);
  }

  if (!options.useSessionToken && (!options.playerId || !options.password)) {
    throw new Error(
      'Missing API credentials for connect auth mode: provide --player-id/--password ' +
      '(or PLAYER_ID/PLAYER_PASSWORD), or use --use-session-token.',
    );
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (asBool(args.help) || asBool(args.h)) {
    printHelp();
    return;
  }

  const root = process.cwd();
  const options = {
    overwrite: asBool(args.overwrite),
    withApiContent: asBool(args['with-api-content']),
    useSessionToken: asBool(args['use-session-token']),
    archiveOutRoot: String(args['archive-out-root'] || DEFAULT_ARCHIVE_OUT_ROOT),
    masterdataDir: String(args['masterdata-dir'] || process.env.MASTERDATA_DIR || ''),
    configPath: String(args['config-path'] || process.env.LINKURA_CONFIG_PATH || DEFAULT_CONFIG_PATH),
    playerId: String(args['player-id'] || process.env.PLAYER_ID || ''),
    password: String(args.password || process.env.PLAYER_PASSWORD || ''),
    sessionToken: String(args['session-token'] || process.env.SESSION_TOKEN || ''),
    deviceSpecificId: String(args['device-specific-id'] || process.env.DEVICE_SPECIFIC_ID || ''),
    gachaYamlPath: String(args['gacha-yaml'] || process.env.GACHA_YAML || ''),
  };

  if (!options.gachaYamlPath && options.masterdataDir) {
    options.gachaYamlPath = path.join(options.masterdataDir, 'GachaSeries.yaml');
  }

  const archiveOutRootAbs = path.resolve(root, options.archiveOutRoot);
  const archiveBundleRel = toPosixPath(path.relative(root, path.join(archiveOutRootAbs, 'bundle', 'client.mjs')));
  const archiveMapRel = toPosixPath(path.relative(root, path.join(archiveOutRootAbs, 'bundle', 'client.mjs.map')));
  const archiveAssetsRel = toPosixPath(path.relative(root, path.join(archiveOutRootAbs, 'assets')));
  const stages = [];

  const restoreSummary = {
    generatedAt: new Date().toISOString(),
    cwd: toPosixPath(root),
    options: {
      overwrite: options.overwrite,
      withApiContent: options.withApiContent,
      useSessionToken: options.useSessionToken,
      archiveOutRoot: toPosixPath(path.relative(root, archiveOutRootAbs) || '.'),
      masterdataDir: options.masterdataDir ? toPosixPath(path.resolve(options.masterdataDir)) : '',
      configPath: options.configPath ? toPosixPath(path.resolve(options.configPath)) : '',
      gachaYamlPath: options.gachaYamlPath ? toPosixPath(path.resolve(options.gachaYamlPath)) : '',
      playerIdProvided: Boolean(options.playerId),
      passwordProvided: Boolean(options.password),
      sessionTokenProvided: Boolean(options.sessionToken),
      deviceSpecificIdProvided: Boolean(options.deviceSpecificId),
    },
    stages,
    status: 'success',
  };

  try {
    if (options.withApiContent) {
      validateApiOptions(options);
    }

    const validateTargetStage = createStage('validate-promotion-targets');
    stages.push(validateTargetStage);
    const validateStats = validatePromotionTargets(root, options.overwrite);
    finishStage(validateTargetStage, true, validateStats);

    const baselineStage = createStage('ensure-baseline-tree');
    stages.push(baselineStage);
    const baselineStats = ensureBaselineTree(root);
    finishStage(baselineStage, true, baselineStats);

    const archiveStage = createStage('archive-assets');
    stages.push(archiveStage);
    const archiveArgs = ['--out-root', options.archiveOutRoot];
    if (options.overwrite) {
      archiveArgs.push('--overwrite');
    }
    runNodeScript(root, 'scripts/archive-assets.mjs', archiveArgs);
    finishStage(archiveStage, true, {
      outRoot: toPosixPath(path.relative(root, archiveOutRootAbs) || '.'),
    });

    const promoteStage = createStage('promote-unpacked-directories');
    stages.push(promoteStage);
    const promoteStats = promoteUnpackedDirectories(root, archiveOutRootAbs, options.overwrite);
    finishStage(promoteStage, true, promoteStats);

    const scaffoldStage = createStage('ensure-scaffold-files');
    stages.push(scaffoldStage);
    const scaffoldStats = ensureRequiredScaffoldFiles(root);
    finishStage(scaffoldStage, true, scaffoldStats);

    const restoreImagesStage = createStage('restore-public-images');
    stages.push(restoreImagesStage);
    const imageStats = restorePublicImages(root, archiveOutRootAbs, options.overwrite);
    finishStage(restoreImagesStage, true, imageStats);

    const populateStage = createStage('populate-src-assets');
    stages.push(populateStage);
    const populateArgs = [
      '--public-images-dir',
      'public/images',
      '--summary-file',
      DEFAULT_POPULATE_SUMMARY,
      '--strict',
    ];
    if (options.overwrite) {
      populateArgs.push('--overwrite');
    }
    runNodeScript(root, 'scripts/populate-src-assets.mjs', populateArgs);
    finishStage(populateStage, true, {
      summaryFile: toPosixPath(DEFAULT_POPULATE_SUMMARY),
    });

    const mirrorStage = createStage('mirror-external-assets');
    stages.push(mirrorStage);
    const mirrorArgs = [
      '--mode',
      'bundle-map',
      '--bundle-file',
      archiveBundleRel,
      '--bundle-file',
      archiveMapRel,
      '--archive-assets-root',
      archiveAssetsRel,
      '--out',
      'public/external',
    ];
    if (options.overwrite) {
      mirrorArgs.push('--overwrite');
    }
    runNodeScript(root, 'scripts/mirror-external-assets.mjs', mirrorArgs);
    finishStage(mirrorStage, true, {
      mode: 'bundle-map',
      bundleFiles: [archiveBundleRel, archiveMapRel],
      archiveAssetsRoot: archiveAssetsRel,
      output: 'public/external',
    });

    if (options.withApiContent) {
      const selectCardStage = createStage('build-select-card-index');
      stages.push(selectCardStage);
      runNodeScript(root, 'scripts/build-masterdata-select-card-index.mjs', [
        '--masterdata-dir',
        options.masterdataDir,
        '--out-file',
        path.join('reports', 'api_overlay', 'select-card-list-index.json'),
      ]);
      finishStage(selectCardStage, true, {
        outFile: 'reports/api_overlay/select-card-list-index.json',
      });

      const fetchApiStage = createStage('fetch-api-content');
      stages.push(fetchApiStage);
      const fetchApiArgs = [
        '--config-path',
        options.configPath,
        '--masterdata-dir',
        options.masterdataDir,
        '--gacha-yaml',
        options.gachaYamlPath,
      ];
      if (options.playerId) {
        fetchApiArgs.push('--player-id', options.playerId);
      }
      if (options.password) {
        fetchApiArgs.push('--password', options.password);
      }
      if (options.useSessionToken) {
        fetchApiArgs.push('--use-session-token');
      }
      if (options.sessionToken) {
        fetchApiArgs.push('--session-token', options.sessionToken);
      }
      if (options.deviceSpecificId) {
        fetchApiArgs.push('--device-specific-id', options.deviceSpecificId);
      }

      runNodeScript(root, 'scripts/fetch-api-content.mjs', fetchApiArgs);
      finishStage(fetchApiStage, true, {
        masterdataDir: toPosixPath(path.resolve(options.masterdataDir)),
        configPath: toPosixPath(path.resolve(options.configPath)),
        useSessionToken: options.useSessionToken,
      });
    }
  } catch (error) {
    restoreSummary.status = 'failed';
    restoreSummary.error = error instanceof Error ? error.message : String(error);

    const pendingStage = stages[stages.length - 1];
    if (pendingStage && !pendingStage.finishedAt) {
      finishStage(pendingStage, false, pendingStage.stats, restoreSummary.error);
    }
  } finally {
    ensureDir(path.join(root, 'reports'));
    fs.writeFileSync(path.join(root, DEFAULT_RESTORE_SUMMARY), JSON.stringify(restoreSummary, null, 2), 'utf8');
    console.log(`[restore] summary: ${toPosixPath(DEFAULT_RESTORE_SUMMARY)}`);
    console.log(`[restore] status: ${restoreSummary.status}`);
  }

  if (restoreSummary.status !== 'success') {
    process.exitCode = 1;
  }
}

main();

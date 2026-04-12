# llll-web-recovered

## Disclaimer
This repository is based on analysis of unpacked official front-end code/assets for local research and debugging.

- All intellectual property rights remain with the original rights holders.
- This project is unofficial and is not affiliated with or endorsed by any original publisher/owner.
- Do not use this repository for unauthorized redistribution or commercial reuse of proprietary assets.
- Use only in legally permitted local environments.

## Resource-First Repository Policy
This repository intentionally tracks scripts/configuration, not official unpacked resources.

- Official/unpacked code and data are ignored by `.gitignore`.
- You must restore required resources locally before development/build workflows.

## Overview
`llll-web-recovered` is a `React + TypeScript + Vite` project used to reproduce and debug Link! Like! Lovelive! web behavior locally.

Core capabilities:
- Save official bundle/source-map snapshots and unpack them
- Promote unpacked `src/` and `node_modules/` directories to project root
- Rebuild image assets and mapped `src` image targets
- Rebuild external mirrored resources from archived `bundle/map`
- Optionally fetch authenticated API snapshots for local `/api/*` overlay replay

## Requirements
- `Node.js 22+`
- `pnpm 10+`
- Required for full dev overlay: masterdata files
- First-time API fetch (no config): player ID + account password (connect login mode)
- Optional: API config JSON for session-token mode reuse

## Fresh Setup

1. Install dependencies once so script tooling is available:
   ```bash
   pnpm install
   ```
2. Restore workspace resources:
   ```bash
   pnpm run restore:workspace -- --overwrite
   ```
3. Fetch API snapshot data for local overlay.
   First run: use account/password login mode.
   ```bash
   pnpm run fetch:api-content -- \
     --masterdata-dir <path-to-masterdata> \
     --player-id <player-id> \
     --password <account-password>
   ```
   Config/session already available: use session-token mode.
   ```bash
   pnpm run fetch:api-content -- \
     --use-session-token \
     --masterdata-dir <path-to-masterdata> \
     --config-path <path-to-config.json>
   ```
4. Build select-card index for local API overlay:
   ```bash
   pnpm run build:select-card-index -- \
     --masterdata-dir <path-to-masterdata> \
     --out-file reports/api_overlay/select-card-list-index.json
   ```
5. Start local development:
   ```bash
   pnpm run dev
   ```

Build-only flow:
```bash
pnpm run build
pnpm run preview
```

Notes:
- `pnpm run dev` requires both `reports/api_content_*` and `reports/api_overlay/select-card-list-index.json`.
- If you do not use a config file, `fetch:api-content` falls back to built-in header defaults unless overridden.
- `pnpm run build` writes output to `dist-vite/`.
- `pnpm run preview` serves the built output locally.
- You can find the related masterdata on [link-like-diff](https://github.com/vertesan/link-like-diff).

## restore:workspace Behavior
Default flow (without `--with-api-content`):
1. Validate promotion targets (`src/`, `node_modules/`) and overwrite policy.
2. Run `archive:assets` to save `client.mjs`/`client.mjs.map`, extract allowed assets, and unpack source map.
3. Promote unpacked directories from `snapshots/archive/current/map-unpacked/sources/__up__/` to root:
   - `src/` is moved (replaced when `--overwrite` is set).
   - `node_modules/` is moved when missing, or merged into an existing install when `--overwrite` is set.
4. Rebuild `public/images` from archived official image assets.
5. Run `sync:src-assets` (`populate-src-assets`) to copy mapped images/placeholders into `src` image paths.
6. Rebuild `public/external` from archived `bundle/map` URL extraction (not from `src` scanning).
   The mirror stage only keeps `assets.link-like-lovelive.app/news/img/*` URLs and prefers local copy from archived assets before network download.
7. Write summary to `reports/restore-workspace-summary.json`.

## Script Reference
| Command | Purpose |
| --- | --- |
| `pnpm run restore:workspace -- [flags]` | Archive/unpack, promote `src/node_modules`, restore images, run `populate-src-assets`, rebuild `public/external` (bundle/map whitelist + archive copy first), optional API stage |
| `pnpm run archive:assets -- ...` | Download current bundle/map, extract allowed assets, and unpack source-map sources under `snapshots/archive/current` |
| `pnpm run sync:bundle-snapshots -- ...` | Sync current bundle/map and optionally copy legacy bundle/map from local files |
| `pnpm run sync:src-assets -- ...` | Copy mapped image assets from `public/images` into `src` targets (plus placeholders) |
| `pnpm run build:select-card-index -- ...` | Build select-card index from masterdata |
| `pnpm run fetch:api-content -- ...` | Fetch authenticated API snapshots (connect mode or session-token mode) |
| `pnpm run serve:static -- ...` | Serve mapped static output with local API overlay responses |
| `pnpm run dev` | Start Vite dev server with local API overlay plugin |
| `pnpm run build` | Build production bundle |
| `pnpm run preview` | Preview production build |

## restore:workspace Flags
```bash
pnpm run restore:workspace -- \
  [--overwrite] \
  [--archive-out-root <dir>] \
  [--with-api-content \
    [--use-session-token] \
    --masterdata-dir <dir> \
    [--config-path <file>] \
    [--player-id <id>] \
    [--password <password>] \
    [--session-token <token>] \
    [--device-specific-id <id>] \
    [--gacha-yaml <file>]]
```

## Local API Overlay
Two overlay modes are supported:
- Dev server plugin mode: `pnpm run dev`
- Static mapped server mode: `pnpm run serve:static`

For this project layout, `pnpm run dev` expects local overlay inputs to exist.
Prepare them before running dev:
1. Fetch API snapshots to generate `reports/api_content_*`.
2. Build select-card index to generate `reports/api_overlay/select-card-list-index.json`.

## White Screen Fix for Session-Gated Pages
Some pages return early when no valid `session` cookie exists, which can appear as a blank/white page in local dev.

For local debugging, comment out this block in the relevant page files:
```ts
if (session === undefined || Object.keys(session).length === 0) {
  return;
}
```

Common files that use this guard:
- `src/page/contact/radio_mail.tsx`
- `src/page/explain/gacha/list.tsx`
- `src/page/explain/gacha/rate.tsx`
- `src/page/explain/membership/membership.tsx`

## Key Environment Variables
| Variable | Description |
| --- | --- |
| `PLAYER_ID` | Player ID for API snapshot fetching |
| `PLAYER_PASSWORD` | Credential/token for API snapshot fetching |
| `MASTERDATA_DIR` | Masterdata directory used by restore/API scripts |
| `LINKURA_CONFIG_PATH` | Config JSON path used by API fetch script |
| `RES_VERSION` | Optional res version override when config is missing |
| `CLIENT_VERSION` | Optional client version override when config is missing |
| `LOGIN_TYPE` | Optional login type override (`android` or `ios`) |
| `GACHA_YAML` | Optional explicit GachaSeries YAML path |
| `SESSION_TOKEN` | Optional session-token override for API fetch session mode |
| `DEVICE_SPECIFIC_ID` | Optional device id override for API fetch session mode |
| `LOCAL_API_SELECT_CARD_INDEX` | Select-card index path for local API overlay |
| `LOCAL_API_REPORTS_ROOT` | Optional reports root override for local API overlay |
| `LOCAL_API_CONTENT_DIR` | Optional explicit API content directory for local API overlay |

## Security Notes
- Never commit real credentials, tokens, or reusable secrets.
- Keep private or account-bound resources out of version control.
- Sanitize snapshot outputs before sharing.

## Special Thanks
- [linkura-cli](https://github.com/ChocoLZS/linkura-cli)

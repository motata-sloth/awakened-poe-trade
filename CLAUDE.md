# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The repo has no root `package.json`. `renderer/` and `main/` are separate npm projects, each with its own `npm ci`. CI (`.github/workflows/main.yml`) is the source of truth for build steps.

```shell
# Dev: start the renderer first (Vite on :5173), then main in a second shell
cd renderer && npm ci && npm run dev
cd main && npm ci && npm run dev     # esbuild watch; restarts Electron on every rebuild

# Checks (this is all CI runs; there is no unit-test framework)
cd renderer && npm run lint          # eslint over src (.ts, .vue)
cd renderer && npm run build         # vue-tsc --noEmit + vite build -> renderer/dist
cd main && npm run build             # tsc --noEmit + production esbuild bundle -> main/dist

# Installer (needs renderer/dist to exist; signing is optional, no cert needed locally)
cd main && npm run package           # electron-builder, config in main/electron-builder.yml
```

Dev-mode gotchas:
- **Logs:** main's `Logger` (`main/src/RemoteLogger.ts`) doesn't print to the terminal. It broadcasts to UI clients, so read the log in Settings → Debug. Every new `/events` WebSocket client also receives the full history.
- **Blank `localhost:8584`:** in dev, main's server doesn't serve the UI (`server.ts` only serves static files when `VITE_DEV_SERVER_URL` is unset). The UI is at `localhost:5173`, so the tray's "open in browser" shows a blank page in dev.
- **Overlay loads but hotkeys don't work:** the renderer's startup (`renderer/src/main.ts`) awaits config → i18n → data → `Host.init()` in sequence. If any earlier step throws, no WebSocket connects, the host config is never pushed, and main never registers shortcuts. The overlay's detached DevTools window shows the error.

`docs/` is a separate Astro site for the GitHub Pages docs and download page (`.github/workflows/pages.yml`). It is not part of the app.

## Architecture

The app is an Electron overlay for Path of Exile. It has three top-level parts:

- **`main/`**: the Electron main process (Node). esbuild bundles it into `dist/main.js`, plus `dist/vision.js` for the OCR worker thread. It owns the transparent overlay window attached to the game (`electron-overlay-window`), global hotkeys (`uiohook-napi`, `shortcuts/`), clipboard capture, game client log and config file watching (`host-files/`), the auto-updater, and the tray.
- **`renderer/`**: the entire UI, a Vue 3 + Tailwind app built with Vite. Item parsing and all trade logic live here, not in main.
- **`ipc/`**: shared TypeScript types (`types.ts`) imported by both sides. The renderer imports them through the `@ipc` alias.

### Main ↔ renderer communication is HTTP + WebSocket, not Electron IPC

`main/src/server.ts` starts a local HTTP server. In production it also serves the built renderer files. The renderer connects to the `/events` WebSocket (`renderer/src/web/background/IPC.ts`, the `Host` object), and both sides exchange JSON `IpcEvent`s.

- Event names encode direction: `MAIN->CLIENT::…`, `CLIENT->MAIN::…`, `MAIN->OVERLAY::…`, `OVERLAY->MAIN::…`.
- To add an event, add it to the `IpcEvent` union in `ipc/types.ts`. Both sides then get typed payloads through `IpcEventPayload<Name>`.
- The server also exposes HTTP routes: `/config` (stores the config file, `host-files/ConfigStore.ts`), `/uploads`, and `/proxy` (forwards requests to the trade site and other services, `main/src/proxy.ts`).
- In dev, Vite proxies these routes and `/events` to `127.0.0.1:8584` (`renderer/vite.config.mts`). Main loads the UI from `VITE_DEV_SERVER_URL`, which the build script injects only in dev mode.

### Typical flow (price check)

1. The user presses a hotkey.
2. `main/src/shortcuts/Shortcuts.ts` sends Ctrl+C to the game, reads the clipboard, and emits `MAIN->CLIENT::item-text`.
3. The renderer runs `parseClipboard()` (`renderer/src/parser/Parser.ts`), which produces a `ParsedItem`.
4. The parsed item goes to a widget such as `web/price-check/`.

Hotkey bindings live in the renderer config. The renderer pushes them to main with `CLIENT->MAIN::update-host-config` (`HostConfig` in `ipc/types.ts`), and `main.ts` rewires shortcuts, overlay key, log watcher, and game config when that event arrives.

### Renderer structure

- **Widgets:** overlay features are widgets registered in `renderer/src/web/overlay/widget-registry.ts`. Each component exports a static `widget: WidgetSpec`. Widget state (position, visibility, settings) is stored in the user config.
- **Config:** `renderer/src/web/Config.ts` holds the config as a single JSON blob saved through main. The schema is versioned by `configVersion`, and `upgradeConfig()` runs a chain of migrations. **If you change the config shape, bump `configVersion` in `defaultConfig()` and add a migration step.**

### Game data

- **Location:** per-language game data is in `renderer/public/data/<lang>/`:
  - `items.ndjson` and `stats.ndjson`
  - `client_strings.js`
  - `app_i18n.json`, the UI translations. Crowdin syncs these with `en` as the source.
- **Generated externally:** data updates arrive as bulk commits (e.g. "update data 3.30.x"). Don't hand-edit these files for logic changes.
- **Lookup:** `renderer/src/assets/data/index.ts` searches the ndjson files as raw strings and uses binary `*.index.bin` hash indexes for fast lookup.
- **Indexes:** `make-index-files.mjs` generates the indexes through a Vite plugin (`vite-plugin-make-indexes.ts`), and regenerates them in dev whenever an `.ndjson` file changes. They are gitignored build outputs. The plugin generates them in `configResolved`, not `buildStart`: the dev server snapshots the public file list before `buildStart`, so files created later get Vite's `index.html` fallback, and `Uint32Array` on that HTML throws in `Data.init`.
- **Languages:** supported game-data languages are hardcoded in `make-index-files.mjs` (`en`, `ru`, `cmn-Hant`, `ko`).

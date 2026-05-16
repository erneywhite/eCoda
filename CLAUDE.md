# eCoda — context for Claude Code

This file is auto-loaded as project context whenever Claude Code starts a session in this repo. It mirrors the long-form notes from Claude's local memory so the SAME context is available on every machine the repo is checked out on (Windows dev, macOS dev, future CI). Update it as work progresses — both the Windows-side and macOS-side Claude sessions should keep this current.

## Overview

**eCoda** is a from-scratch desktop client for YouTube Music. Personal project, Windows-first, MIT-licensed.

**Architecture: native client ("Path B").** Own UI + own audio player. Public metadata via `youtubei.js` (in-process); authenticated metadata via a hidden Electron `BrowserWindow` on `music.youtube.com` that signs InnerTube calls with `Authorization: SAPISIDHASH` ourselves; streaming via bundled `yt-dlp` + Deno.

**Stack:** Electron 33 + Vite 6 + TypeScript + Svelte 5. Build pipeline `electron-vite build`. Packaging `electron-builder` (NSIS on Windows, DMG/ZIP on macOS), auto-update `electron-updater` against GitHub Releases.

**Status (2026-05-16):** All planned phases 0–7 done. Last Windows build 0.0.45. macOS port preparation in progress — cross-platform code branches landed, awaiting first Mac build.

## Repo layout

```
src/
  main/                  Electron main process
    auth.ts              browser detection + config storage (lang, theme,
                         shuffle/repeat, closeAction, crossfadeDuration,
                         pinned playlists, window state, last session)
    metadata.ts          search / home / playlist / artist parsers
                         (youtubei.js + page-proxy)
    token-harvest.ts     hidden BrowserWindow + innertubeFetch
                         (SAPISIDHASH-signed)
    library-session.ts   cookie import into persist:music partition
    ytdlp.ts             stream resolve + login verification
                         (cross-platform binary path resolution)
    resolver.ts          three-layer track resolve:
                         offline → memory cache → yt-dlp
    downloads.ts         per-track / per-playlist downloads + thumbnail
                         caching, verifyCache, offline/ dir migration
                         (cross-platform binary paths)
    updater.ts           electron-updater wrapper
    logger.ts            mirrors console to <userData>/main.log
    index.ts             window state restore, silent-reconnect on launch,
                         titleBarStyle branch (hidden on win /
                         hiddenInset on mac), Tray + Menu + close-action
                         interceptor + forceQuit flag, mini-mode helpers,
                         all IPC handlers, media:// protocol
  preload/               IPC API exposed as window.api.*
  renderer/
    src/App.svelte       single-file UI: header, sidebar, views, player
                         bar, mini-shell, audio (two elements for crossfade)
    src/i18n.ts          ru/en string tables
    src/assets/          wordmark.png
build/                   electron-builder resources (icon + mac entitlements)
resources/               bundled binaries (yt-dlp + deno, auto-fetched
                         per platform by postinstall scripts)
scripts/                 fetch-ytdlp + fetch-deno (postinstall) + probes
branding/                source brand assets — final wordmark + icon
                         drop in here when the artist delivers
```

## Cross-platform binary paths (load-bearing)

Both `src/main/ytdlp.ts` and `src/main/downloads.ts` resolve binary paths at runtime, NOT via Vite `?asset` imports. The same compiled `out/main/index.js` runs on any platform; the build machine doesn't need both `.exe` and bare binaries present.

```ts
const isWin = process.platform === 'win32'
const binDir = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'resources')
  : join(app.getAppPath(), 'resources')
const ytdlpPath = join(binDir, isWin ? 'yt-dlp.exe' : 'yt-dlp')
const denoPath  = join(binDir, isWin ? 'deno.exe'  : 'deno')
```

`electron-builder` `asarUnpack` includes `resources/yt-dlp*`, `resources/deno*`, and `resources/python-mac/**/*` (macOS only — see below) so spawn() can reach the binaries on disk.

## macOS yt-dlp pipeline (load-bearing — paid for in blood)

On macOS we ship **the yt-dlp zipapp + a bundled standalone Python**, NOT the `yt-dlp_macos` PyInstaller binary. Reason:

- `yt-dlp_macos` is a PyInstaller onefile bundle. At every launch it extracts ~100 Python `.so` modules (Cryptodome, websockets, lib-dynload, etc.) into `/var/folders/.../tmp/_MEI*/`.
- macOS `amfid` (AppleMobileFileIntegrity daemon) validates each extracted `.so` against Apple's cert chain. Every file fails with `Error -423 "adhoc signed or unknown certificate chain"`, but amfid still takes ~150ms per validation → **12-15 seconds of cold startup overhead before yt-dlp even talks to YouTube**. Combined with the network calls it adds up to 20-30s per resolve in practice; on Windows the same yt-dlp.exe is sub-second because Windows has no amfid.
- The `yt-dlp` zipapp (Python source archive, 3.2 MB) imports Python modules from the bundled standalone Python install — every `.so` there is signed by python-build-standalone's developer cert and amfid passes them instantly. Cold resolve drops to **5-7 seconds** (network-bound).

Implementation:

- `resources/yt-dlp` on macOS is the zipapp (downloaded by `scripts/fetch-ytdlp.mjs`, which switches asset by platform). On Windows it's the PyInstaller `.exe` as before.
- `resources/python-mac/` holds astral-sh/python-build-standalone's `cpython-3.13.13+...-aarch64-apple-darwin-install_only_stripped`. ~65 MB extracted. Pinned in `scripts/fetch-python-mac.mjs` for reproducibility — bump the `RELEASE` + `PY_VERSION` constants together when updating.
- `macPython3Path()` in `src/main/ytdlp.ts` picks `<binDir>/python-mac/bin/python3` first; Homebrew paths are a dev fallback only. `ytdlpInvocation(args)` returns `[python3Path, [zipappPath, ...args]]` on macOS and `[binaryPath, args]` on Windows/Linux.
- `--js-runtimes deno:<denoPath>` is passed explicitly in both `resolveAudio` and `downloadOne` because yt-dlp 2026.x stopped auto-discovering Deno on PATH on macOS — without the explicit flag the n-challenge falls back to a slow retry loop.

**Don't switch back to `yt-dlp_macos`** — codesign'ing the outer binary doesn't help (the extracted `.so` files in `/tmp` are what amfid scans, and they're created at runtime). `--options runtime` on the outer binary actively breaks the bundle because the extracted Python.framework has a different Team ID from the resigned executable.

**`mac.target.arch` is `arm64` only.** Apple-Silicon-first decision. Adding Intel support would require either a universal-arch Python bundle (~130 MB, doubles .dmg size) or an electron-builder `afterPack` hook that fetches the arch-specific Python per build pass — neither is worth doing until there's actual Intel demand.

**Persistent daemon pool (macOS, 0.0.47):** `resources/yt-dlp-daemon.py` is a Python worker that imports `yt_dlp` once and processes newline-delimited JSON over stdin/stdout. `src/main/ytdlp-daemon.ts` is the Node wrapper; `YtdlpDaemonPool` runs **two** daemons so a foreground user click can land on the idle one while a background prefetch occupies the other (pool size 1 caused 10s clicks because requests queued behind prefetches). Pool starts after `silentReconnect` succeeds; `stopYtdlpDaemon()` runs on `before-quit`. **No warmup-on-start** — we tried it and it actively queued ahead of the user's first real click. Per-call spawn stays as a fallback if the daemon script is missing or the bundled Python can't be found.

## Windows yt-dlp pipeline (0.0.49 — same machinery as macOS)

Windows now ships the same zipapp + bundled Python + daemon pool that macOS does. Single code path in `ytdlp.ts`, single fetch script for Python, lockstep Python version across both OSes.

Measured on Windows (5 cold resolves, firefox cookies, 0.0.48 vs 0.0.49):

| Path | min | p50 | avg | p95 |
| --- | --- | --- | --- | --- |
| Per-call spawn (old, `yt-dlp.exe`) | 6572 | 6710 | 6800 | 7162 |
| Daemon pool (new, zipapp + bundled Python) | 5017 | 5342 | 5594 | 6397 |

**Avg saving: ~1.2 s per cold resolve. p50 saving: ~1.4 s.** First call still pays YoutubeDL construction (~6.4 s); 2nd-and-later calls steady at ~5.0-5.3 s once the cache is warm. Network + Deno n-sig solve is the irreducible remainder.

**Installer size barely moved**: 132.7 MB → 132.9 MB (+0.3 MB). NSIS compresses Python's `Lib/` aggressively, and the ~30 MB of standalone Python net almost exactly cancels the ~30 MB we used to ship as `yt-dlp.exe` (PyInstaller bundle). The bundle on disk *unpacked* grew ~+30 MB.

**Anti-checklist (don't undo these):**
- Don't bring back `yt-dlp.exe` — it's slower per call (PyInstaller startup) and roughly the same size, with no upside.
- Don't ship Python 3.14 — keep 3.13.13 + the `RELEASE='20260510'` constant in `scripts/fetch-python.mjs` matching macOS for lockstep behaviour.
- Don't try to share `resources/python/` between mac and win (layouts differ — Mac has `bin/python3`, Windows has flat `python.exe`).
- Don't pre-warm via a fake resolve at startup (tried on mac in 0.0.47 dev, hurt first-click latency by queueing ahead of the user).
- Don't set `POOL_SIZE` higher than 2 without measuring — each daemon = ~70 MB resident.
- Don't drop `process.env.SystemRoot/System32/tar.exe` for the Windows tar in `fetch-python.mjs` — Git-Bash's GNU tar misinterprets `C:` in `-C` paths as a remote host.

**Single source of truth:** `ytdlpInvocation()` in `ytdlp.ts` now returns `[bundledPython3Path(), [ytdlpPath, ...args]]` on every platform. Downloads + resolve both flow through it. Linux is not yet shipped; if/when we add it, postinstall will need a Linux Python branch (likely also python-build-standalone).

## Build commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs deps + runs postinstall: fetches `yt-dlp` + `deno` for the CURRENT platform into `resources/`. |
| `npm run dev` | electron-vite dev with auto-reload + detached DevTools. |
| `npm run build:win` | Produces `dist/eCoda-Setup-<v>.exe` (NSIS, x64). |
| `npm run build:mac` | Produces `dist/eCoda-<v>-{arch}.dmg` + `.zip` (universal: arm64 + x64). Must run on macOS. |
| `npm run release:win` | Build + publish to GitHub Releases. Needs `GH_TOKEN`. |
| `npm run release:mac` | Same for macOS. Needs `GH_TOKEN` + Apple Developer credentials (see below). |

## macOS-specific notes (port in progress)

**BrowserWindow:**
- `titleBarStyle: 'hiddenInset'` on darwin (keeps traffic lights at top-left).
- `trafficLightPosition: { x: 14, y: 16 }` to vertically centre them on the 40px-tall header.
- Renderer: `<main>` has `class:platform-mac={isMac}`; the custom `.window-controls` (min/max/close on right side) are `{#if !isMac}`-hidden — traffic lights cover those functions. Header padding-left bumped to 78px on macOS to clear the traffic-light cluster.

**Tray:**
- `nativeImage.resize({ 22, 22 })` (vs 16 on Windows; menu bar standard scale).
- `setTemplateImage(true)` — AppKit re-tints the icon to follow the menu bar theme (white on dark, black on light). The Dock + window keep the original coloured raccoon.
- Click behavior: macOS opens the menu on single-click natively, we don't override.

**close-action setting:**
- Default `'tray'` (window-close → hide) matches macOS convention naturally (Cmd+W ≠ Cmd+Q).
- `before-quit` is still the universal "we're actually exiting" signal, fires on Cmd+Q.

**Code-signing + notarization:**
- For sharing builds with other users, the app needs Apple Developer code-signing ($99/year). Without it, Gatekeeper shows "eCoda can't be opened because Apple cannot check it for malicious software" — user has to right-click → Open the first time.
- Local testing of unsigned builds works fine via `npm run build:mac` → manual Open.
- For production: set `CSC_LINK` (.p12 cert) + `CSC_KEY_PASSWORD` env vars; electron-builder handles signing. For notarization, also set `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
- Entitlements live in `build/entitlements.mac.plist` (network client + allow-jit for Deno + allow-unsigned-executable for our spawned binaries).

**First-time Mac dev checklist:**
1. Clone repo
2. `npm install` (fetches darwin yt-dlp + deno automatically)
3. `npm run dev` to test in dev mode
4. `npm run build:mac` to produce `dist/eCoda-0.0.x-{arm64,x64}.dmg`. Gatekeeper will block — right-click → Open the first time.
5. For a release: set Apple Developer env vars + `npm run release:mac`.

## Key gotchas (paid for in blood, don't re-pay)

**Cookies pipeline:**
- `#HttpOnly_` prefix on the domain field marks HttpOnly cookies in yt-dlp's Netscape output. Every meaningful auth cookie comes through that way. Strip + set `httpOnly:true`.
- `__Host-`-prefixed cookies are spec host-only: no Domain, Path="/", Secure=true. Drop the domain or Chrome rejects with `EXCLUDE_INVALID_PREFIX`.
- `persist:music` partition needs clearing before each cookie import (else `EXCLUDE_OVERWRITE_HTTP_ONLY`).
- Synthetic SOCS + CONSENT cookies on `.youtube.com` + `.google.com` to skip EU consent gate.
- `verifyBrowserLogin` MUST truncate the cookies file before yt-dlp runs — else with `--cookies <file>` populated AND `--cookies-from-browser firefox`, yt-dlp merges both jars and stale cookies fail auth.

**Offline cache:**
- Lives at `<userData>/offline/` — NOT `cache/`. On case-insensitive Windows fs, `cache/` collided with Chromium's own `Cache/`; Chromium's eviction nuked our audio between launches. Rename was the 0.0.4 fix; `migrateLegacyCache()` copies leftovers on first run.

**Spawn + asar:**
- Electron's child_process patch rewrites asar paths transparently for `execFile`, but NOT for `spawn`. Use `app.asar.unpacked` paths for spawn'd binaries (this is what our binDir resolution does).

**Mini-player:**
- Two presets: compact 420×108 + square 280×320. `setResizable(false)` on enter so the top-of-shell seek strip doesn't conflict with the Windows resize edge. Don't try transparent-window translucency (tried in 0.0.42 → reverted in 0.0.43; user wanted a solid card).

**Crossfade:**
- Two `<audio>` elements (audioElA + audioElB). `activeAudioKey: 'a' | 'b'` says which is logical-current; the other is silent unless a fade is ramping. Per-audio `gainA/gainB` multiplied with master volume in a `$effect` — single source of truth for `element.volume`.
- Triggers in `onAudioElementTimeUpdate` on the active audio when `(duration - currentTime) <= crossfadeDuration`. Bails when `repeatMode === 'one'`. crossfadeTriggered latches to prevent re-firing.
- Manual `playTrack` calls `cancelCrossfade()` at the top — no inherited half-fades.

**Playlist parser:**
- Initial `/browse VL<id>` response: tracks under `musicPlaylistShelfRenderer.contents`. Continuation pages (modern shape) use `appendContinuationItemsAction.continuationItems` (an array). Older shape: `musicPlaylistShelfContinuation`. Handle both.
- Dedup by `playlistItemData.playlistSetVideoId`, not `videoId` — a user can legitimately add the same track twice and YT counts both. Fallback to `videoId@index`.
- Empty `watchEndpoint.videoId` + non-empty `playlistSetVideoId` = unavailable row. Keep with `unavailable: true`, synthetic id `__unavail__<setVideoId>`.

**Clickable artist link in rows:**
- `parseTrackRowsInto` extracts the row's primary artist channelId. Renderer wraps the artist text in a `<span role="link">` with `e.stopPropagation()` on click — the row is itself a `<button>` so without stopPropagation the click bubbles and starts playback.

## What's done

Roadmap (Phases 0–7) all closed. Latest Windows: 0.0.45.

| Phase | Status |
| --- | --- |
| 0 Skeleton | ✅ |
| 1 Streaming MVP | ✅ |
| 2 Offline | ✅ |
| 3 Polish | ✅ |
| 4 Distribution | ✅ |
| 5 Playback features (shuffle/repeat/queue/ctx menu/streamer bundle/like/radio) | ✅ |
| 6 Deeper navigation (artist + album views; lyrics intentionally cut) | ✅ |
| 7 System integration (tray + close-action + global media keys via MediaSession + mini-player A↔B) | ✅ |
| Motion polish (FLIP / drag-pickup / ctx scale-in / cover crossfade / hover-lift) | ✅ |
| Track-to-track crossfade (0-12s, Settings slider) | ✅ |
| **macOS port** | 🔜 in progress |

## User decisions to remember

- **Lyrics: don't pitch.** (2026-05-16) "необязательно добавлять, думаю это будет лишним для обычного плеера для обычного пользователя"
- **Transparent mini-player: don't try.** (2026-05-16) "ты сделал хуже, пофиг на прозрачность, верни как было" — wanted a solid card, not a floating frame.
- **Lossy re-encoding of downloads: no.** Opus is already optimal.
- **Cache size limit / LRU: no.** Would surprise the user by deleting old downloads.
- **DRM / obfuscation: no.** User's own music.

## Conventions

- Iteration cycle: `0.0.x` patches. Each ships with `npm version patch`-bumped `package.json`, fresh `dist/eCoda-Setup-0.0.x.exe`, tagged commit pushed to `main`.
- Commit messages: terse first line `0.0.x: <one-line summary>`, then a paragraph describing the change.
- Russian commit / chat messages from the user are normal — keep replies in Russian unless the conversation switches to English. Code comments stay in English.
- No GitHub Release until brand assets land (per user request) — auto-updater won't find anything until then. Use `npm run release:win` / `:mac` when ready.

## When adding macOS-specific code

Always branch via `process.platform === 'darwin'` in main, or via the `isMac` const + `class:platform-mac` in the renderer. Don't add separate `*.mac.ts` files unless absolutely needed — single-file branches with comments are easier to keep in sync.

# eCoda

Desktop client for YouTube Music — your library, fast playback, Spotify-style offline cache, and a native UI you can theme. Talks to YouTube's InnerTube API directly: no embedded webview, no heavy web player.

> **Status:** Phase 4 done, 0.0.4 shipped. All core flows work; auto-update wired; Windows NSIS installer ready. Public 1.0 release pending the final brand assets from the artist.

## Features

- **Authentication via your browser's existing YouTube session** — Firefox, Chrome, Edge, Brave, Opera, Vivaldi, Chromium, Whale, and Firefox forks (Waterfox, LibreWolf, Floorp, Zen). No password input; eCoda reads the cookies you already have signed in there.
- **Native Home** with YouTube Music's own recommendation grid.
- **Native Library** showing your real playlists — including private ones and Liked Music — rendered as our own grid of cards.
- **Native playlist view** with cover, track list, per-track and per-playlist download buttons.
- **Pinned playlists in the sidebar** — Liked Music always pinned at the top, plus any playlist you pin (from the playlist header *or* from the Library card's hover overlay).
- **Search** with thumbnails and click-to-play.
- **Custom player bar** — YT-Music-style: aurora-glass background, thin top progress strip flush to the player's rounded top edge, prev / play / next + inline time, volume slider, mute toggle.
- **Source-list-aware next/prev** — skipping follows whichever list you launched the track from (search results vs playlist).
- **Background prefetch** — while one track plays, the next few in the active list are resolved in the background, so the next click is instant.
- **Spotify-style offline cache** — download a single track (↓ button) or a whole playlist (📥 in the header), then play them instantly from disk on any future launch, fully offline. Audio + cover thumbnails are persisted; manifest in `<userData>/offline/manifest.json`. Bulk downloads return a "X of Y · N failed" summary with a one-click Retry-failed button.
- **Resume where you left off** — last played track + queue + position is restored on launch as a paused, ready-to-play state in the player bar. First Play click resolves the stream and continues from the saved second.
- **Remembers the window** — size, position, and maximized state persist across launches, with on-screen validation so a disconnected monitor doesn't strand the window off-screen.
- **Silent reconnect on launch** — if cookies have rotated in the browser since the last Connect, eCoda refreshes them quietly in the background and re-fetches the current view, so Library never comes up empty just because the app sat unused for a while.
- **Mouse-side-button navigation** + back/forward chips in the header.
- **Eight colour themes** (Purple, Cyber Cyan, Sunset, Forest, Crimson, Mono, Ocean, Neon Pink) — palette switches the accent colour, glow, player gradient and aurora in one shot.
- **Language switch** — Russian / English UI, persisted per-user.
- **Default tab on launch** — pick Home, Search or Library.
- **Auto-update** via `electron-updater` against GitHub Releases. Silent check on startup, manual "Check for updates" button in Settings, one-click "Restart and install" once the new release is downloaded.
- **Diagnostics in Settings** — paths to user data / offline cache / log file with one-click Open-in-Explorer, plus a "Verify cache" action that reconciles the manifest with what's actually on disk (drops dead entries, adopts orphaned audio files). Main-process console is mirrored to `<userData>/main.log` (2 MB rotation) for post-mortem debugging on packaged installs where DevTools are off.
- **Premium-quality audio** when the connected account is YouTube Premium — pulls ~160 kbps Opus inside `.webm`.

## How it works

- **Electron + Vite + TypeScript + Svelte 5** for the app shell, build pipeline, and renderer.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** drives stream extraction and offline downloads (audio and thumbnails).
- **Deno** is the JS runtime yt-dlp uses for YouTube's signature challenges. Both binaries are downloaded automatically by `npm install` and shipped via `asarUnpack`.
- **[youtubei.js](https://github.com/LuanRT/YouTube.js)** for public InnerTube metadata (search, Home feed, public playlist tracks fallback).
- **Hidden Electron BrowserWindow + page-proxy** — a `music.youtube.com` window kept alive in the background. Every authenticated InnerTube call (Library landing, private playlist contents, Liked Music) is `fetch`'d inside that page context, with a manually-computed `Authorization: SAPISIDHASH …` header so the server treats us as logged in. This is what unlocks the native library experience.
- **`media://` custom Electron protocol** — serves offline-cached audio and thumbnails to the renderer without bumping into webSecurity / CSP rules that block bare `file://` URLs from a non-file: origin.
- **Cookies pipeline** — read once via `yt-dlp --cookies-from-browser`, normalised (`#HttpOnly_` rows preserved, `__Host-*` host-only rules respected, synthetic `SOCS` + `CONSENT` injected to bypass the GDPR gate), then loaded into both the InnerTube session and the `persist:music` partition the hidden window uses. On every launch with a configured browser, the cookies are re-dumped in the background to track YouTube's silent rotation.
- **Offline cache is at `<userData>/offline/`** — *not* `cache/`. On case-insensitive Windows file systems, `cache/` collided with Chromium's own `Cache/` directory; Chromium's cache eviction was nuking our audio files between launches. The directory name was changed in 0.0.4 to escape that collision.
- **Themes & language** persist in `<userData>/config.json` along with the connected browser, default tab, pinned playlists, window bounds, and last playback session.

## Development

```sh
npm install
npm run dev
```

DevTools auto-open in a detached window in dev. `Ctrl+R` in the eCoda window reloads the renderer; the main process is hot-reloaded by `electron-vite`.

## Building a Windows installer

Local build (no publish):

```sh
npm run build:win
```

Produces `dist/eCoda-Setup-<version>.exe` — NSIS, x64, per-user install, configurable directory, desktop + Start-Menu shortcuts.

> **First build on Windows requires Administrator rights** (electron-builder unpacks `winCodeSign` which contains macOS dylib symlinks — Windows blocks symlink creation without admin or Developer Mode + the `SeCreateSymbolicLinkPrivilege` group policy). Run PowerShell as Administrator the first time; subsequent builds reuse the cache and don't need elevation.

Cut a release that auto-updaters can see:

1. Bump version: `npm version patch` (or edit `package.json`).
2. `git push --follow-tags`.
3. `set GH_TOKEN=ghp_…` — personal access token with `public_repo` scope.
4. `npm run release` — rebuilds, then `electron-builder --win --publish always` uploads the installer + `latest.yml` to GitHub Releases.

Installed copies see the new release via the in-app **Settings → Обновления → Проверить обновления** button and via a silent check three seconds after every launch.

## Project layout

```
src/
  main/                  Electron main process
    auth.ts              browser detection + config storage (browser, theme, lang,
                         pinned playlists, window state, last playback session)
    metadata.ts          search / home / playlist parsers (youtubei.js + page-proxy)
    token-harvest.ts     hidden BrowserWindow + innertubeFetch (SAPISIDHASH-signed)
    library-session.ts   cookie import into persist:music partition
    ytdlp.ts             stream resolve + login verification (yt-dlp wrapper)
    resolver.ts          three-layer track resolve: offline → memory cache → yt-dlp
    downloads.ts         per-track / per-playlist downloads + thumbnail caching,
                         verifyCache reconciliation, offline/ dir migration
    updater.ts           electron-updater wrapper, lifecycle events to renderer
    logger.ts            mirrors main-process console to <userData>/main.log
    index.ts             window state restore, silent reconnect on launch,
                         IPC handlers, media:// protocol
  preload/               IPC API exposed as window.api.*
  renderer/
    src/App.svelte       single-file UI: header, sidebar, views, player bar
    src/i18n.ts          ru/en string tables
    src/assets/          wordmark, etc.
branding/                source brand assets (wordmark.png, icon.png)
build/                   electron-builder resources (icon, etc.)
resources/               bundled binaries (yt-dlp.exe, deno.exe — auto-fetched)
scripts/                 fetch-ytdlp / fetch-deno postinstall + diagnostic probes
mockups/                 standalone HTML mockups (A/B/C) used during UI redesign
```

## Roadmap

- **Phase 0 — project skeleton** — done
- **Phase 1 — streaming MVP** — done (search, home, playlist navigation, custom player UI)
- **Phase 2 — offline** — done (per-track + per-playlist downloads, persistent cache, instant disk playback via `media://`)
- **Phase 3 — polish** — sidebar pinned playlists, eight colour themes, language switch, mouse-side-button navigation, settings with cache/diagnostics/about/updates/donate
- **Phase 4 — distribution** — `electron-builder` NSIS installer, `electron-updater` against GitHub Releases (done; current build cycle: 0.0.x)
- **Phase 5 (planned)** — shuffle, queue management, right-click context menus, "radio by track" via `getUpNext`, like/dislike, artist + album views, mini-player, system tray, global media keys, lyrics
- **macOS port** — same codebase, `.dmg` target, needs Mac/CI + Apple notarisation

## Disclaimer

eCoda is an unofficial client and is not affiliated with, endorsed by, or sponsored by YouTube or Google. It is intended for personal use. Respect YouTube's Terms of Service and your local laws.

## License

[MIT](LICENSE)

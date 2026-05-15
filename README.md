# eCoda

Desktop client for YouTube Music — built around **owning your music**: native library, Spotify-style offline cache, playlist sync, and audio-quality control, in a fast, native-feeling app.

> **Status:** Phase 2 done. Functional daily-driver: search, native YT Music home, your real library (private playlists, Liked Music), per-track and per-playlist offline downloads with instant playback from disk. Still pre-1.0 — Windows-only build, no installer yet.

## What works today

- **Authentication** via your browser's existing YouTube session — no password, no separate sign-in.
- **Search** with track results, thumbnails, click-to-play.
- **Home feed** with YT Music's own recommendations as a native grid of cards.
- **Library tab** showing your real playlists — including private ones like *Liked Music* — rendered as native cards in eCoda's UI (not an embedded webview).
- **Playlist view** with cover, track list, and per-track or whole-playlist download buttons.
- **Player bar** in YouTube Music style — thumbnail, title/artist, prev/play/next, seek, volume, mute.
- **Source-list-aware skip** — next/prev follow the list the current track was launched from (search results vs playlist).
- **Background prefetch** — while one track plays, the next few in the active list are resolved in the background, so the next click is instant.
- **Offline cache** — Spotify-style. Download a single track (↓ button) or a whole playlist (📥 in the header), then play them instantly from disk on any future launch, including without internet. Files live under `<userData>/cache/`; deletions go through the in-app ✓ button.
- **Browser-style back / forward** in the header.
- **Premium-quality audio** — if your account has YouTube Premium, eCoda pulls 256 kbps Opus.

## Why

Web-wrapper YouTube Music desktop apps can't offer real offline caching, can't pick audio quality, and inherit the heavy web player. eCoda is a native client: it talks to YouTube's InnerTube API directly, runs its own player, and renders its own UI.

## How it works

- **Electron + Vite + TypeScript + Svelte** — app shell and renderer.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — audio stream extraction and offline downloads.
- **Deno** — the JS runtime yt-dlp uses to solve YouTube's signature challenges.
- **[youtubei.js](https://github.com/LuanRT/YouTube.js)** — InnerTube wrapper for public metadata (search, home).
- **Hidden Electron BrowserWindow + page-proxy** — a music.youtube.com window kept alive in the background signs authenticated InnerTube calls (SAPISIDHASH, X-Goog-Visitor-Id, full Chrome session) for everything that needs the user's account: private playlists, library, Liked Music.
- **`media://` custom Electron protocol** — serves the offline-cached audio and thumbnails to the renderer without bumping into webSecurity / CSP rules that block bare `file://` URLs.
- **Cookies** — read from any browser you're already signed in to: Firefox / Chrome / Edge / Brave / Opera / Vivaldi / Chromium / Whale, plus Firefox forks (Waterfox / LibreWolf / Floorp / Zen).

`yt-dlp` and `Deno` are downloaded automatically on `npm install` — they aren't committed to the repo.

## Development

```sh
npm install
npm run dev
```

In dev DevTools auto-open in a detached window. Press `Ctrl+R` in the eCoda window to reload the renderer.

## Building a Windows installer

Local build (no publish):

```sh
npm run build:win
```

Produces `dist/eCoda-Setup-<version>.exe` (NSIS, x64, per-user install, desktop + start menu shortcuts).

Cut a release that auto-updaters can see:

1. Bump `package.json` `"version"` (or `npm version patch`).
2. `git tag v<version> && git push --tags`.
3. `set GH_TOKEN=ghp_...` (a personal access token with `public_repo` scope).
4. `npm run release` — builds, publishes to GitHub Releases and uploads `latest.yml` + the installer.

Installed copies will see the new release via the in-app "Проверить обновления" button (Settings → Обновления) and via a silent check 3 seconds after every launch.

## Roadmap

- **Phase 0 — project skeleton** — done
- **Phase 1 — streaming MVP** — done
  - Audio extraction + playback at Premium quality
  - Browser-cookie authentication
  - Search, Home, native playlist navigation
  - YT-Music-style player bar with seek and volume
- **Phase 2 — offline** — done
  - Per-track and per-playlist download with live progress
  - Persistent on-disk cache (`media://` scheme for renderer playback)
  - Thumbnails cached alongside audio
- **Phase 3 — daily-use polish** — mini-player, tray icon, global media keys, lyrics, more library tabs (Songs / Albums / Artists / History)
- **Phase 4 — distribution** — `electron-builder` NSIS installer for Windows, auto-update, macOS port

## Disclaimer

eCoda is an unofficial client and is not affiliated with, endorsed by, or sponsored by YouTube or Google. It is intended for personal use only. Respect YouTube's Terms of Service and your local laws.

## License

[MIT](LICENSE)

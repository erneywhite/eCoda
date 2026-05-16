# eCoda

Desktop client for YouTube Music — your library, fast playback, Spotify-style offline cache, and a native UI you can theme. Talks to YouTube's InnerTube API directly: no embedded webview, no heavy web player.

> **Status:** Phase 4 done; Phase 5 first slice + streamer bundle shipped in 0.0.28. Like / unlike + radio-by-track are the only remaining Phase 5 backlog. Public 1.0 release still pending the artist's final brand assets.

## Features

### Library & navigation
- **Browser-based authentication** — Firefox, Chrome, Edge, Brave, Opera, Vivaldi, Chromium, Whale, and Firefox forks (Waterfox, LibreWolf, Floorp, Zen). No password input; eCoda reads the cookies you already have signed in there. On every launch the cookies are silently re-dumped so YT's rotation never strands you on stale auth.
- **Native Home** — YouTube Music's own recommendation grid.
- **Native Library** — your real playlists (private and Liked Music included) rendered as our own card grid, fed through a SAPISIDHASH-signed page proxy.
- **Native playlist view** with cover, full track list, big Play CTA, compact download chip, pin/unpin. The count line shows total duration ("69 треков · 4 часа 26 минут") with proper Russian pluralisation.
- **Full playlist pagination** — playlists of any length load completely (followed continuation chains across both the old `musicPlaylistShelfContinuation` and the modern `appendContinuationItemsAction.continuationItems` shapes). Dedup is by `playlistSetVideoId` rather than `videoId`, so a track legitimately added to the same playlist twice shows up twice — matching YT's library-card count.
- **Unavailable tracks visible** — when YT keeps a row with no playable `videoId` (deleted / region-blocked / Premium-only), eCoda renders it dimmed and italic with a "Track unavailable" tooltip instead of silently dropping it, so the inside count matches the card. Prev / next / Play-all skip over those rows automatically.
- **Search** with thumbnails and click-to-play.
- **"Downloaded" virtual playlist** in the sidebar — synthetic playlist materialised from the offline manifest, sorted newest-first, plays straight from disk.
- **Pinned playlists** — Liked Music always pinned at the top, plus any playlist you pin (from the playlist header *or* from the Library card's hover overlay). A hover-Play chip on each pinned row navigates and starts the playlist in one click.
- **Mouse-side-button navigation** + back/forward chips in the header.

### Player
- **Custom YT-Music-style player bar** — aurora-glass background, thin top progress strip flush to the player's rounded top edge, `[shuffle] [prev] [play] [next] [repeat]` transport row + inline time, volume slider, mute toggle, plus a download chip that mirrors the playlist-row state for the currently playing track.
- **Shuffle + repeat modes** persisted in config — shuffle plays a random next-track from the source list (with a real "walk back through history" prev), repeat cycles off → all → one (loop the track at end-of-play). Each toggle gets a small accent dot under the icon so the active state reads even without colour-vision contrast.
- **Source-list-aware next/prev** — skipping follows whichever list you launched the track from (search results vs playlist vs Downloaded), preserved across track changes.
- **Background prefetch** — while one track plays, the next few in the active list are resolved in the background, so the next click is instant.
- **Resume where you left off** — last track + queue + position restored on launch as a paused, ready-to-play state in the player bar. First Play click resolves the stream and continues from the saved second; no auto-blast on Windows boot.
- **Right-click context menu** on every track row (playlist + search): `▶ Play next`, `≡ Add to queue`, plus the streamer-bundle actions below. Material-style icons next to each label.
- **Explicit queue** (separate from sourceList) — "Play next" prepends, "Add to queue" appends; the queue takes priority over normal sourceList traversal at end-of-track. Toast feedback on every queue action.

### Track-list editing (the "streamer bundle")
- **Reshuffle button** in the playlist header — one click reorders the playlist into a fresh random sequence; each click is a different arrangement. Different from the player-bar's continuous shuffle: this PERMANENTLY rewrites the saved order until you click again, so an OBS source can show the same plan you set up.
- **Pin position** via the context menu — pinned tracks stay where they are when you reshuffle; Fisher-Yates only touches non-pinned rows and reflows them between the fixed positions. The exact use-case it was built for: pin the stream intro at position 0, click reshuffle for a different random remainder each session. A small 📌 indicator marks pinned rows.
- **Drag-and-drop reorder** — native HTML5 drag, with an accent-coloured drop indicator on the hovered row. Survives restarts (saved as part of the per-playlist override).
- **Smart merge when the playlist changes on YouTube** — added tracks land at the end (regular playlists) or at the top (Liked Music + the Downloaded virtual playlist, both "recent-activity" surfaces). Removed tracks disappear from the override (pins included). The custom order survives YT-side edits as long as the tracks still exist.
- **"Reset to default order"** button appears whenever there's a saved override — drops it entirely and reloads YT's natural order. Guarded by a stylised in-app confirm dialog (no more Windows-native popup).

### Offline cache (download)
- **Per-track ↓ / per-playlist 📥** with a live percentage ring driven by yt-dlp's own progress output (no fake spinner). Audio + cover thumbnails are persisted to `<userData>/offline/` (*not* `cache/` — see "How it works" for why).
- **Bulk download summary** — after a playlist run, a "Downloaded X of Y · N failed" panel appears with a Retry-failed button. Per-track failure reasons are surfaced from yt-dlp's stderr.
- **Audio quality picker** — Settings → Download quality. **Best** (~160 kbps Opus, default), **Medium** (~128 kbps AAC), **Saver** (~70 kbps Opus). Picks the matching stream directly from YouTube — no local re-encoding, no ffmpeg.

### Cosmetics & comfort
- **Eight colour themes** (Purple, Cyber Cyan, Sunset, Forest, Crimson, Mono, Ocean, Neon Pink) — palette switches the accent colour, glow, player gradient and aurora in one shot.
- **Language switch** — Russian / English UI, persisted per-user. YouTube responses are fetched in the matching locale so section titles + auto-playlist names also flip when you toggle.
- **Default tab on launch** — pick Home, Search or Library.
- **Remembers the window** — size, position, and maximized state persist across launches, with on-screen validation so a disconnected monitor doesn't strand the window off-screen.

### Distribution & diagnostics
- **Auto-update** via `electron-updater` against GitHub Releases. Silent check on startup, manual "Check for updates" button in Settings, one-click "Restart and install" once the new release is downloaded.
- **Diagnostics in Settings** — paths to user data / offline cache / log file with one-click Open-in-Explorer, plus a "Verify cache" action that reconciles the manifest with disk (drops dead entries, adopts orphaned audio files). Main-process console is mirrored to `<userData>/main.log` (2 MB rotation) for post-mortem debugging on packaged installs where DevTools are off.

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

- **Phase 0 — project skeleton** — ✅ done
- **Phase 1 — streaming MVP** — ✅ done (search, home, playlist navigation, custom player UI)
- **Phase 2 — offline** — ✅ done (per-track + per-playlist downloads, persistent cache, instant disk playback via `media://`)
- **Phase 3 — polish** — ✅ done (sidebar pinned playlists, eight colour themes, language switch, mouse-side-button navigation, settings with cache/diagnostics/about/updates/donate, audio quality picker, Downloaded virtual playlist, live progress rings, total playlist duration, unavailable-row handling)
- **Phase 4 — distribution** — ✅ done (`electron-builder` NSIS installer, `electron-updater` against GitHub Releases; current build cycle: 0.0.x, latest 0.0.28)
- **Phase 5 — playback features** — mostly done in 0.0.14 + 0.0.24–28:
  - ✅ shuffle + repeat modes (off / all / one), both persisted
  - ✅ queue management (separate from sourceList; Play next / Add to queue)
  - ✅ right-click context menu on tracks with Material-style icons
  - ✅ Reshuffle button (one-shot Fisher-Yates with pinned-position respect)
  - ✅ Pin / unpin position via context menu
  - ✅ Drag-and-drop reorder
  - ✅ Smart YT-side merge (append for normal playlists, prepend for LM + Downloaded)
  - ✅ Reset-to-default-order button
  - ✅ In-app confirm dialog (replaces native Windows prompt)
  - 🔜 "Radio by track" via `yt.music.getUpNext`
  - 🔜 Like / unlike via page-proxy `/like/like` + `/like/removelike`
- **Phase 6 — deeper navigation (planned)** — artist + album views, lyrics panel via `yt.music.getLyrics`.
- **Phase 7 — system integration (planned)** — system tray icon + minimal menu, global media keys (Play / Pause / Next / Prev that work when the app isn't focused), mini-player mode (slim always-on-top window).
- **Brand swap** — when the artist delivers the final wordmark + icon, drop them into `branding/` and rebuild.
- **macOS port** — same codebase, `.dmg` target, needs Mac/CI + Apple notarisation.

## Disclaimer

eCoda is an unofficial client and is not affiliated with, endorsed by, or sponsored by YouTube or Google. It is intended for personal use. Respect YouTube's Terms of Service and your local laws.

## License

[MIT](LICENSE)

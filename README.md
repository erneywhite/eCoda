# eCoda

Desktop client for YouTube Music — your library, fast playback, Spotify-style offline cache, and a native UI you can theme. Talks to YouTube's InnerTube API directly: no embedded webview, no heavy web player.

> **Status:** **1.0.0 released** on [GitHub Releases](https://github.com/erneywhite/eCoda/releases/latest) — Windows (.exe) and macOS arm64 (.dmg/.zip). Cross-platform parity, all planned phases (0–7) done, track-to-track crossfade, mini-player A↔B, persistent yt-dlp daemon pipeline on both OSes. Lyrics intentionally cut from Phase 6.

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
- **Right-click context menu** on every track row (playlist + search): `▶ Play next`, `≡ Add to queue`, `📻 Start radio`, plus the streamer-bundle actions below. Material-style icons next to each label.
- **Explicit queue** (separate from sourceList) — "Play next" prepends, "Add to queue" appends; the queue takes priority over normal sourceList traversal at end-of-track. Toast feedback on every queue action.
- **Mid-resolve clicks switch tracks** — clicking a different row while one is resolving cancels the in-flight resolve (the spinner overlay jumps to the new row), so you're never stuck waiting on a decision you've already changed your mind about.
- **Track-to-track crossfade** — Settings → "Crossfade duration" slider, 0–12 s. The last N seconds of one track overlap with the start of the next via a linear gain ramp on two HTML audio elements. Applies only to natural auto-progression (manual prev/next switches instantly so seeking through a playlist still feels snappy). `repeat-one` bypasses the crossfade.

### Artist & album views
- **Artist page** — click any artist name in a track row (search / playlist / Downloaded / artist top-songs) or any artist card on Home / Library / artist-related-artists. Header has the circular cover, name, locale-aware subscriber line ("138 подписчиков" / "1.2M subscribers"), Play and Shuffle buttons. Below: Top Songs list (full row UI — heart, download, context menu, mid-resolve switching all work), then every YT carousel (Albums, Singles, Featured on, related artists) as a grid of card-tiles.
- **Album header polish** — when the opened "playlist" is actually an album (browseId starts with MPRE / OLAK), the header reads "Альбом · {Artist link} · {Year}" instead of YT's generic "Playlist" subtitle. Artist link navigates straight to the artist page.
- **Click any artist name** — the page-proxy parser extracts each row's primary artist channelId (`UC…`-prefix browseEndpoint in the subtitle column) and the renderer wraps the artist text in a focusable link span (Enter/Space keyboard activation, stopPropagation so the click doesn't fire the row's play handler).

### Likes & radio
- **Inline heart on every row** — filled red = liked, outlined = not. One click toggles via the page-proxy `/like/like` + `/like/removelike` endpoints; optimistic UI flips the heart immediately and reverts on failure. The currently-playing track also has its own heart in the player bar.
- **Liked Music state propagates back** — playlist rows render with the correct heart state on first paint (page-proxy parses each row's `likeStatus`), and Liked Music's own contents are force-marked liked. Removing a like from inside the Liked Music view drops the row immediately.
- **Radio by track** — context-menu `📻 Start radio` opens a synthesised "Радиостанция · {seed}" view with the seed + YouTube's Up-next list visible, then auto-plays the seed. The radio is just another playlist as far as prev / next / shuffle / queue are concerned, with reshuffle / pin / drag intentionally hidden because radio is ephemeral.

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

### System integration
- **System tray icon** with a right-click menu (Show/Hide · Play-Pause · Previous · Next · Quit). Menu labels follow the UI language and rebuild on language change.
- **Close-button action setting** — Settings → Behaviour lets you pick what the X does: "Minimize to tray" (default; music keeps playing in the background) or "Quit". Cmd+Q / Alt+F4 / tray-Quit always exit regardless of the setting.
- **Global media keys, cross-platform** — Windows SMTC (lockscreen widget, volume flyout, F-key media buttons), macOS Now Playing, Linux MPRIS. Driven by the standard `navigator.mediaSession` API so it's the same code path on every platform — no native modules.
- **Mini-player mode** — same window resizes + goes always-on-top + switches to a compact widget. Two presets: A (horizontal pill, 420×108) and B (square cover-focused, 280×320). Toggle button switches between them mid-playback; restore button brings the full window back. Entry button sits in the header next to the back/forward chips; only appears when something is playing. Window is locked from user-resize in mini mode (the two presets cover the use cases, and locking it keeps the seek strip clickable next to the window edge).

### Cosmetics & comfort
- **Eight colour themes** (Purple, Cyber Cyan, Sunset, Forest, Crimson, Mono, Ocean, Neon Pink) — palette switches the accent colour, glow, player gradient and aurora in one shot.
- **Language switch** — Russian / English UI, persisted per-user. YouTube responses are fetched in the matching locale so section titles + auto-playlist names also flip when you toggle.
- **Default tab on launch** — pick Home, Search or Library.
- **Custom frameless titlebar** — native window chrome is hidden; the header is the drag region with our own minimize / maximize-restore / close buttons styled to match the rest of the app. Aero snap, edge-resize, and double-click-to-maximize all still work.
- **Remembers the window** — size, position, and maximized state persist across launches, with on-screen validation so a disconnected monitor doesn't strand the window off-screen.

### Distribution & diagnostics
- **Auto-update** via `electron-updater` against GitHub Releases. Silent check on startup, manual "Check for updates" button in Settings, one-click "Restart and install" once the new release is downloaded.
- **Diagnostics in Settings** — paths to user data / offline cache / log file with one-click Open-in-Explorer, plus a "Verify cache" action that reconciles the manifest with disk (drops dead entries, adopts orphaned audio files). Main-process console is mirrored to `<userData>/main.log` (2 MB rotation) for post-mortem debugging on packaged installs where DevTools are off.

## How it works

- **Electron + Vite + TypeScript + Svelte 5** for the app shell, build pipeline, and renderer.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** drives stream extraction and offline downloads (audio and thumbnails). Shipped as the cross-platform Python zipapp, run inside a **bundled standalone Python** (`python-build-standalone` 3.13.13) so the app doesn't depend on a system Python install on either OS.
- **Persistent yt-dlp daemon pool** — instead of spawning `python yt-dlp` fresh for every resolve, two long-lived Python workers stay running for the lifetime of the app. Each one imports `yt_dlp` once and caches the `YoutubeDL` instance per (browser, deno) tuple, amortising ~3 s of Python interpreter init + extractor registration over every subsequent call. On macOS the win is even larger (~12 s saved per call) because the old `yt-dlp_macos` PyInstaller binary tripped amfid validation on ~100 internal `.so` files at every launch.
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

## Building an installer

| Platform | Local build | Release (publishes to GitHub) |
| --- | --- | --- |
| Windows | `npm run build:win` → `dist/eCoda-Setup-<v>.exe` (NSIS, x64) | `npm run release:win` |
| macOS | `npm run build:mac` → `dist/eCoda-<v>-arm64.{dmg,zip}` | `npm run release:mac` |

> **First build on Windows requires Administrator rights** (electron-builder unpacks `winCodeSign` which contains macOS dylib symlinks — Windows blocks symlink creation without admin or Developer Mode + the `SeCreateSymbolicLinkPrivilege` group policy). Run PowerShell as Administrator the first time; subsequent builds reuse the cache and don't need elevation.

> **macOS builds** must run on a Mac (Apple keychain + notarytool live there). The `.dmg` is Apple-Silicon-only by design — Intel support would double the bundle size (Python runtime is per-arch); revisit if there's demand. For distribution-grade builds, set `CSC_LINK` + `CSC_KEY_PASSWORD` (codesigning) and `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (notarisation). Without them you can still run `build:mac` and right-click → Open the unsigned `.dmg` locally.

Cut a release that auto-updaters can see:

1. Bump version: `npm version patch` (or edit `package.json`).
2. `git push --follow-tags`.
3. `GH_TOKEN=ghp_…` — personal access token with `public_repo` scope (`set` on Windows / `export` on macOS).
4. Run `release:win` and/or `release:mac` to publish — uploads the installer + `latest.yml` to GitHub Releases.

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
- **Phase 4 — distribution** — ✅ done (`electron-builder` NSIS on Windows + `.dmg`/`.zip` on macOS, `electron-updater` against GitHub Releases; **1.0.0 published** + auto-updater wired)
- **Phase 5 — playback features** — ✅ done across 0.0.14 + 0.0.24–34:
  - ✅ shuffle + repeat modes (off / all / one), both persisted
  - ✅ queue management (separate from sourceList; Play next / Add to queue)
  - ✅ right-click context menu on tracks with Material-style icons
  - ✅ Reshuffle button (one-shot Fisher-Yates with pinned-position respect)
  - ✅ Pin / unpin position via context menu
  - ✅ Drag-and-drop reorder
  - ✅ Smart YT-side merge (append for normal playlists, prepend for LM + Downloaded)
  - ✅ Reset-to-default-order button
  - ✅ In-app confirm dialog (replaces native Windows prompt)
  - ✅ Like / unlike — inline heart on every row + heart on the player bar; page-proxy `/like/like` + `/like/removelike`
  - ✅ "Radio by track" via `yt.music.getUpNext` — opens as a synthesised playlist view, not just a hijacked queue
  - ✅ Mid-resolve clicks switch tracks instead of being blocked
- **Custom frameless titlebar** — ✅ done in 0.0.33–34 (minimize / maximize-restore / close in our palette, drag region on the header, Aero snap kept intact)
- **Motion polish** — ✅ done in 0.0.35–36 (FLIP on track-list reorders, drag-pickup lift, drop-indicator animation, ctx-menu scale-in, player-bar cover crossfade, hover-lift + thumb zoom on cards)
- **Phase 6 — deeper navigation** — ✅ done in 0.0.37–38:
  - ✅ Artist page: header (photo + name + subscribers + Play/Shuffle), Top Songs, every YT carousel (Albums / Singles / Featured on / related artists)
  - ✅ Album header polish: "Альбом · {Artist link} · {Year}" instead of generic "Playlist"
  - ✅ Clickable artist names in every track row (parser extracts each row's channelId)
  - ❌ Lyrics — intentionally cut (not the right fit for a personal player)
- **Phase 7 — system integration** — ✅ done in 0.0.39–44:
  - ✅ System tray icon + localised right-click menu, configurable close-button behaviour (tray vs quit)
  - ✅ Global media keys via `navigator.mediaSession` — Windows SMTC, macOS Now Playing, Linux MPRIS, no native modules
  - ✅ Mini-player mode — same window, two fixed presets (A horizontal pill, B square cover), toggle button + restore, always-on-top
- **Track-to-track crossfade** — ✅ done in 0.0.45 (Settings → "Crossfade duration" slider 0–12 s; auto-progression only, manual prev/next stays instant)
- **macOS port** — ✅ done in 0.0.46–47 (cross-platform binary paths, custom titlebar with traffic-light branch, Mac-aware tray template image, Safari Full Disk Access hint in Connect)
- **yt-dlp daemon pipeline (both platforms)** — ✅ done in 0.0.47 (Mac) + 0.0.49 (Windows): persistent Python worker pool that amortises interpreter + extractor init across the lifetime of the app. Measured drop on Windows: avg cold resolve 6.8 s → 5.6 s; on macOS the win is larger (~12 s) because the old PyInstaller-based `yt-dlp_macos` paid amfid validation per launch.
- **Brand swap** — ✅ done in 0.0.53–54 (artist's wordmark + icon landed; `scripts/resize-branding.mjs` downscales the multi-megabyte source PNGs to the sizes the app + electron-builder actually use, square-pads the icon for `.ico`/`.icns` compatibility, copies to the three destination paths in one shot).
- **Public 1.0** — ✅ released (Windows .exe + macOS arm64 .dmg/.zip on [GitHub Releases](https://github.com/erneywhite/eCoda/releases/latest), auto-updater live).

## Disclaimer

eCoda is an unofficial client and is not affiliated with, endorsed by, or sponsored by YouTube or Google. It is intended for personal use. Respect YouTube's Terms of Service and your local laws.

## License

[MIT](LICENSE)

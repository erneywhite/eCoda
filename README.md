# eCoda

Desktop client for YouTube Music — built around **owning your music**: offline caching, playlist sync, and audio-quality control, in a fast, native-feeling app.

> **Status:** early development (Phase 1). The core already works — eCoda extracts and plays YouTube Music audio at Premium quality. The full app (search, library, real player UI, offline) is still being built.

## Why

Web-wrapper YouTube Music desktop apps can't do offline downloads or real quality selection, and they inherit the heavy web player. eCoda is a native client instead: it talks to YouTube's APIs directly, plays and caches audio itself, and renders its own lightweight UI.

## Planned features

- Fast, lightweight native UI
- Offline download & caching of tracks and playlists (Spotify-style)
- Automatic playlist sync — new tracks get pulled down
- Audio-quality selection (up to ~256 kbps with a Premium account)
- System integration: tray, global media keys, mini-player

## How it works

- **Electron + Vite + TypeScript + Svelte** — the app shell and UI.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — extracts audio stream URLs (and, later, handles downloads).
- **Deno** — the JavaScript runtime yt-dlp uses to solve YouTube's signature challenges.
- **Authentication** — eCoda reads your YouTube session cookies from a browser you're already signed in to (Firefox, Chrome, Edge, Brave, Opera, Vivaldi, Chromium, Whale, plus Firefox forks like Waterfox / LibreWolf / Floorp). No passwords, no separate login.

`yt-dlp` and `Deno` are downloaded automatically on `npm install` — they aren't committed to the repo.

## Development

```sh
npm install
npm run dev
```

## Roadmap

- **Phase 0 — project skeleton** — done
- **Phase 1 — streaming MVP** — *in progress*
  - done: audio extraction + playback at Premium quality
  - done: browser-cookie authentication
  - next: InnerTube metadata layer (search, playlists, library)
  - next: real player UI (now-playing, queue, controls)
- **Phase 2 — offline** — local cache, download manager, playlist sync
- **Phase 3 — daily-use polish** — mini-player, tray, media keys, lyrics
- **Phase 4 — distribution** — auto-update, Windows installer (macOS later)

## Disclaimer

eCoda is an unofficial client and is not affiliated with, endorsed by, or sponsored by YouTube or Google. It is intended for personal use. Respect YouTube's Terms of Service and your local laws.

## License

[MIT](LICENSE)

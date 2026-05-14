# eCoda

Desktop client for YouTube Music — built around **owning your music**: offline caching, playlist sync, and audio-quality control, in a fast, native-feeling app.

> **Status:** very early (Phase 0 — project skeleton). Not usable yet.

## Why

Web-wrapper YouTube Music desktop apps can't do offline downloads or real quality selection, and they inherit the heavy web player. eCoda is a native client instead: it talks to YouTube's APIs directly, plays and caches audio itself, and renders its own lightweight UI.

## Planned features

- Fast, lightweight native UI
- Offline download & caching of tracks and playlists (Spotify-style)
- Automatic playlist sync — new tracks get pulled down
- Audio-quality selection (up to 256 kbps with a Premium account)
- System integration: tray, global media keys, mini-player

## Tech stack

- Electron + Vite + TypeScript + Svelte
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for stream extraction and downloads
- InnerTube / ytmusicapi-style layer for metadata

## Development

```sh
npm install
npm run dev
```

## Roadmap

- **Phase 0** — project skeleton  ← *we are here*
- **Phase 1** — streaming MVP (search, playlists, playback, quality selection)
- **Phase 2** — offline (local cache, download manager, playlist sync)
- **Phase 3** — daily-use polish (mini-player, tray, media keys, lyrics)
- **Phase 4** — distribution (auto-update, installer)

## Disclaimer

eCoda is an unofficial client and is not affiliated with, endorsed by, or sponsored by YouTube or Google. It is intended for personal use. Respect YouTube's Terms of Service and your local laws.

## License

[MIT](LICENSE)

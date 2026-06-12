import { app } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// `kind` decides how the browser is handed to yt-dlp:
//  - 'native'       — yt-dlp knows this browser; pass the id directly
//  - 'firefox-fork' — yt-dlp doesn't know it, but it's Firefox-format, so
//                     pass firefox:<resolved profile path>
interface BrowserDef {
  id: string
  name: string
  // path whose existence proves the browser is installed (and, for forks,
  // the directory its profiles live in)
  profileRoot: string
  kind: 'native' | 'firefox-fork'
  // For forks: candidate executable / .app locations. Required for
  // detection — a stale Profiles directory from a past install must not
  // count as installed.
  exePaths?: string[]
}

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const APPDATA = process.env.APPDATA ?? ''
const PROGRAMFILES = process.env['ProgramFiles'] ?? ''
const PROGRAMFILES_X86 = process.env['ProgramFiles(x86)'] ?? ''

// macOS browser data lives under ~/Library/Application Support/<vendor>/;
// Safari is the exception — its cookies are in a sandbox container.
const HOME = homedir()
const MAC_APP_SUPPORT = join(HOME, 'Library', 'Application Support')
const MAC_SAFARI_COOKIES = join(
  HOME,
  'Library',
  'Containers',
  'com.apple.Safari',
  'Data',
  'Library',
  'Cookies'
)

const BROWSERS_WIN: BrowserDef[] = [
  // Browsers yt-dlp supports natively
  {
    id: 'firefox',
    name: 'Firefox',
    profileRoot: join(APPDATA, 'Mozilla', 'Firefox', 'Profiles'),
    kind: 'native'
  },
  {
    id: 'chrome',
    name: 'Chrome',
    profileRoot: join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
    kind: 'native'
  },
  {
    id: 'edge',
    name: 'Edge',
    profileRoot: join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
    kind: 'native'
  },
  {
    id: 'brave',
    name: 'Brave',
    profileRoot: join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    kind: 'native'
  },
  {
    id: 'opera',
    name: 'Opera',
    profileRoot: join(APPDATA, 'Opera Software', 'Opera Stable'),
    kind: 'native'
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    profileRoot: join(LOCALAPPDATA, 'Vivaldi', 'User Data'),
    kind: 'native'
  },
  {
    id: 'chromium',
    name: 'Chromium',
    profileRoot: join(LOCALAPPDATA, 'Chromium', 'User Data'),
    kind: 'native'
  },
  {
    id: 'whale',
    name: 'Whale',
    profileRoot: join(LOCALAPPDATA, 'Naver', 'Naver Whale', 'User Data'),
    kind: 'native'
  },
  // Firefox forks — same cookie format, read as firefox:<profile path>.
  // Detection checks for the executable so a stale Profiles directory from
  // a past install doesn't produce a phantom entry.
  {
    id: 'waterfox',
    name: 'Waterfox',
    profileRoot: join(APPDATA, 'Waterfox', 'Profiles'),
    exePaths: [
      join(PROGRAMFILES, 'Waterfox', 'waterfox.exe'),
      join(PROGRAMFILES_X86, 'Waterfox', 'waterfox.exe')
    ],
    kind: 'firefox-fork'
  },
  {
    id: 'librewolf',
    name: 'LibreWolf',
    profileRoot: join(APPDATA, 'librewolf', 'Profiles'),
    exePaths: [join(PROGRAMFILES, 'LibreWolf', 'librewolf.exe')],
    kind: 'firefox-fork'
  },
  {
    id: 'floorp',
    name: 'Floorp',
    profileRoot: join(APPDATA, 'Floorp', 'Profiles'),
    exePaths: [join(PROGRAMFILES, 'Floorp', 'floorp.exe')],
    kind: 'firefox-fork'
  },
  {
    id: 'zen',
    name: 'Zen Browser',
    profileRoot: join(APPDATA, 'zen', 'Profiles'),
    exePaths: [
      join(PROGRAMFILES, 'Zen Browser', 'zen.exe'),
      join(LOCALAPPDATA, 'Programs', 'zen', 'zen.exe')
    ],
    kind: 'firefox-fork'
  }
]

const BROWSERS_MAC: BrowserDef[] = [
  // Native to yt-dlp
  {
    id: 'firefox',
    name: 'Firefox',
    profileRoot: join(MAC_APP_SUPPORT, 'Firefox', 'Profiles'),
    kind: 'native'
  },
  {
    id: 'chrome',
    name: 'Chrome',
    profileRoot: join(MAC_APP_SUPPORT, 'Google', 'Chrome'),
    kind: 'native'
  },
  {
    id: 'edge',
    name: 'Edge',
    profileRoot: join(MAC_APP_SUPPORT, 'Microsoft Edge'),
    kind: 'native'
  },
  {
    id: 'brave',
    name: 'Brave',
    profileRoot: join(MAC_APP_SUPPORT, 'BraveSoftware', 'Brave-Browser'),
    kind: 'native'
  },
  {
    id: 'opera',
    name: 'Opera',
    profileRoot: join(MAC_APP_SUPPORT, 'com.operasoftware.Opera'),
    kind: 'native'
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    profileRoot: join(MAC_APP_SUPPORT, 'Vivaldi'),
    kind: 'native'
  },
  {
    id: 'chromium',
    name: 'Chromium',
    profileRoot: join(MAC_APP_SUPPORT, 'Chromium'),
    kind: 'native'
  },
  {
    id: 'whale',
    name: 'Whale',
    profileRoot: join(MAC_APP_SUPPORT, 'Naver', 'Naver Whale'),
    kind: 'native'
  },
  // Safari: yt-dlp supports it natively, but reading the cookies file
  // requires Full Disk Access for eCoda (System Settings → Privacy &
  // Security → Full Disk Access → enable eCoda). Without that, yt-dlp
  // fails with a permission error. We still surface Safari in the list
  // — Safari is the most common Mac browser and excluding it would be
  // surprising. The Settings UI should warn about FDA when it's picked.
  {
    id: 'safari',
    name: 'Safari',
    profileRoot: MAC_SAFARI_COOKIES,
    kind: 'native'
  },
  // Firefox forks — read as firefox:<profile path>. Detection checks for
  // the .app bundle so a stale Profiles directory doesn't count.
  {
    id: 'waterfox',
    name: 'Waterfox',
    profileRoot: join(MAC_APP_SUPPORT, 'Waterfox', 'Profiles'),
    exePaths: ['/Applications/Waterfox.app'],
    kind: 'firefox-fork'
  },
  {
    id: 'librewolf',
    name: 'LibreWolf',
    profileRoot: join(MAC_APP_SUPPORT, 'LibreWolf', 'Profiles'),
    exePaths: ['/Applications/LibreWolf.app'],
    kind: 'firefox-fork'
  },
  {
    id: 'floorp',
    name: 'Floorp',
    profileRoot: join(MAC_APP_SUPPORT, 'Floorp', 'Profiles'),
    exePaths: ['/Applications/Floorp.app'],
    kind: 'firefox-fork'
  },
  {
    id: 'zen',
    name: 'Zen Browser',
    profileRoot: join(MAC_APP_SUPPORT, 'zen', 'Profiles'),
    exePaths: ['/Applications/Zen Browser.app', '/Applications/Zen.app'],
    kind: 'firefox-fork'
  }
]

// On unsupported platforms (Linux etc.) we surface no browsers — the
// connect flow handles an empty list with a clear "no supported browser
// detected" message.
const BROWSERS: BrowserDef[] = isWin ? BROWSERS_WIN : isMac ? BROWSERS_MAC : []

export interface DetectedBrowser {
  id: string
  name: string
}

// The supported browsers actually installed on this machine. For forks we
// require the executable to exist — a stale Profiles directory from a past
// install is not enough.
export function detectBrowsers(): DetectedBrowser[] {
  return BROWSERS.filter((b) => {
    if (b.kind === 'firefox-fork') {
      return (b.exePaths ?? []).some((p) => existsSync(p))
    }
    return b.profileRoot !== '' && existsSync(b.profileRoot)
  }).map(({ id, name }) => ({ id, name }))
}

// Inside a Firefox-family Profiles directory, picks the profile whose
// cookies.sqlite was modified most recently — i.e. the one actually in use.
function resolveFirefoxProfile(profilesDir: string): string | null {
  let best: { path: string; mtime: number } | null = null
  try {
    for (const entry of readdirSync(profilesDir)) {
      const profilePath = join(profilesDir, entry)
      try {
        const mtime = statSync(join(profilePath, 'cookies.sqlite')).mtimeMs
        if (!best || mtime > best.mtime) best = { path: profilePath, mtime }
      } catch {
        // no cookies.sqlite here — not a usable profile
      }
    }
  } catch {
    return null
  }
  return best?.path ?? null
}

// Maps a stored browser id to the --cookies-from-browser argument for yt-dlp.
export function ytdlpBrowserArg(id: string): string | null {
  const def = BROWSERS.find((b) => b.id === id)
  if (!def) return null
  if (def.kind === 'native') return def.id
  const profile = resolveFirefoxProfile(def.profileRoot)
  return profile ? `firefox:${profile}` : null
}

export type DefaultTab = 'home' | 'search' | 'library'
export type Lang = 'ru' | 'en'
// Audio quality preset for new downloads. Maps to a yt-dlp `-f` format
// selector at download time — the picker reaches into YouTube's own
// format ladder, never local re-encoding. Existing downloads aren't
// retroactively re-fetched when the preset changes.
//   - 'best'   → bestaudio                (~160 kbps Opus, ~5 MB / 4 min)
//   - 'medium' → bestaudio[abr<=128]      (~128 kbps AAC,  ~3.8 MB / 4 min)
//   - 'low'    → bestaudio[abr<=80]       (~70 kbps Opus,  ~2 MB / 4 min)
export type AudioQuality = 'best' | 'medium' | 'low'
// Repeat mode persists between launches — the streamer use case wants
// "once I've set my modes, they stay set across restarts".
//   - 'off'  → at end-of-list, playback stops
//   - 'one'  → re-seek to 0 and replay the current track forever
//   - 'all'  → wrap to the start of the current sourceList at end
export type RepeatMode = 'off' | 'one' | 'all'
export type Theme =
  | 'purple'
  | 'cyan'
  | 'sunset'
  | 'forest'
  | 'crimson'
  | 'mono'
  | 'ocean'
  | 'neon'

// One pinned playlist as it lives in the user's sidebar shortcut list.
// We snapshot the title + thumbnail at pin time so the sidebar can render
// without re-hitting the InnerTube API on every launch.
export interface PinnedPlaylist {
  id: string
  title: string
  thumbnail: string
}

// A playlist the user recently added a track INTO (via the right-click
// "Add to playlist" modal). Surfaced in a "Recent" row at the top of that
// modal — same snapshot shape as a pin so the modal can render the tile
// without re-fetching. Most-recent-first, capped to RECENT_ADD_CAP.
export interface RecentPlaylist {
  id: string
  title: string
  thumbnail: string
}

// User overrides applied on top of whatever YT returns for a playlist.
// Lets the user reshuffle / pin / drag-reorder tracks and have those
// changes survive a restart. Driven by the streamer-wife use case:
// pin the intro at position 0, click reshuffle for a random remainder
// each stream.
//
// `order` is the full list of setVideoIds in the user's desired
// position. On load, we drop ids not in the YT response (track was
// removed) and add new ids from YT either at the top (LM/Downloaded)
// or the bottom (regular playlists) via `prependOnAdd`. `pinned` is
// the subset of setVideoIds that stay put when reshuffle runs —
// Fisher-Yates only touches non-pinned rows and re-flows them between
// the pinned positions.
export interface PlaylistOverride {
  order: string[]
  pinned: string[]
  prependOnAdd?: boolean
}

// Window geometry remembered between launches so the user doesn't have to
// re-arrange the app every time. The bounds are validated against the
// current display layout before being applied — if a monitor was
// disconnected the window snaps back to a default on the primary display.
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
}

// Minimal snapshot of what was playing when the app last exited. Restored
// on launch as a paused track ready to resume from `currentTime`. We keep
// the sourceList so prev/next still work after restore.
export interface SessionTrack {
  id: string
  title: string
  artist: string
  thumbnail: string
  duration?: string
}
export interface LastSession {
  track: SessionTrack
  sourceList: SessionTrack[]
  // Optional context — playlist the track was launched from, so the UI
  // can surface a hint like "from My Liked Songs" on the resume banner.
  sourceListId?: string
  sourceListTitle?: string
  currentTime: number
}

// What clicking the window close button does:
//   'tray' — hide the window, keep app + audio running, accessible from
//            the system tray. Default for a music player — closing the
//            window mid-track and stopping playback would be jarring.
//   'quit' — actually quit (legacy single-instance behavior). For users
//            who want the X to mean exit.
export type CloseAction = 'tray' | 'quit'

// How hardware media keys (Play/Pause/Next/Prev) reach the app:
//   'system' — Chromium's built-in MediaSession → SMTC / Now Playing
//              integration. Pretty lockscreen widget, OS arbitration decides
//              which app gets the keys. Downside (the reported bug): after a
//              long pause + browser activity Chromium drops/parks the media
//              session and the keys stop reaching us.
//   'global' — WE register the keys via globalShortcut (and disable
//              Chromium's built-in handling at boot). Deterministic: keys
//              always control eCoda while it runs. Downsides: other apps
//              don't get the keys while eCoda runs; the lockscreen widget
//              may not show; macOS needs the Accessibility permission.
// Applied at app startup (command-line feature flag) → needs a restart.
export type MediaKeyMode = 'system' | 'global'

// The audio output device eCoda plays through. `id` is Chromium's
// per-origin deviceId (stable across sessions on the same machine for our
// persistent session); `label` is a human-readable snapshot used by the
// "saved device is missing" launch warning, since the id alone is an opaque
// hash. Field absent → system default output.
export interface AudioOutputDevice {
  id: string
  label: string
}

// 10-band graphic equalizer state. `gains` is exactly 10 values in dB
// (-12..+12), one per band at 32/64/125/250/500/1k/2k/4k/8k/16k Hz —
// the renderer maps them onto a Web Audio BiquadFilter chain. `preset`
// is just the label of the last-applied preset (or 'custom' after a
// manual slider tweak) so the UI can highlight it; the gains array is
// the source of truth. `enabled` gates the whole chain — when off, the
// renderer flattens every band to 0 dB (transparent) rather than
// tearing the audio graph down.
export interface EqualizerState {
  enabled: boolean
  preset: string
  gains: number[]
}

interface Config {
  browser?: string
  defaultTab?: DefaultTab
  theme?: Theme
  lang?: Lang
  audioQuality?: AudioQuality
  shuffleMode?: boolean
  repeatMode?: RepeatMode
  closeAction?: CloseAction
  mediaKeyMode?: MediaKeyMode
  audioOutputDevice?: AudioOutputDevice
  // Seconds of crossfade between natural track transitions. 0 disables
  // — the next track starts the instant the previous ends. Settings
  // slider exposes 0 to 12 seconds.
  crossfadeDuration?: number
  equalizer?: EqualizerState
  pinnedPlaylists?: PinnedPlaylist[]
  recentAddPlaylists?: RecentPlaylist[]
  playlistOverrides?: Record<string, PlaylistOverride>
  windowState?: WindowState
  lastSession?: LastSession
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

// Path to the Netscape cookies file yt-dlp writes at connect time and
// youtubei.js reads from for authenticated extraction.
export function getCookiesFilePath(): string {
  return join(app.getPath('userData'), 'youtube-cookies.txt')
}

// In-memory config cache + serialized atomic writes (1.1.1). Two problems
// this fixes:
//  1. Reads used to hit disk every time. Our old writeConfig truncated the
//     file then wrote it; if a read (e.g. the launch-time auth:status check)
//     landed in that window it got an empty file → JSON.parse threw → {} →
//     getBrowser() returned null → the "connect your account" screen showed
//     even though a browser WAS configured. After first load, reads come
//     from the cache and never touch disk again, so that race is gone.
//  2. Writes are now atomic (temp file → rename, which is atomic on the same
//     volume) and serialized through a chain, so the independent savers
//     (window-state on move/resize/close, session on play, every settings
//     setter) can't truncate each other or interleave a rename.
let cachedConfig: Config | null = null
let configWriteChain: Promise<void> = Promise.resolve()

async function readConfig(): Promise<Config> {
  if (!cachedConfig) {
    try {
      cachedConfig = JSON.parse(await readFile(configPath(), 'utf8')) as Config
    } catch {
      cachedConfig = {}
    }
  }
  return cachedConfig
}

async function writeConfig(config: Config): Promise<void> {
  // Update the in-memory source of truth synchronously, BEFORE any await, so
  // a read-modify-write setter whose readConfig() resolves right after this
  // sees the new value rather than clobbering it with a stale snapshot.
  cachedConfig = config
  const target = configPath()
  const tmp = `${target}.tmp`
  const data = JSON.stringify(config, null, 2)
  const run = configWriteChain.then(async () => {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, target)
  })
  // Keep the chain alive even if this particular write rejects, so the next
  // save still runs; the caller still sees this write's own rejection.
  configWriteChain = run.catch(() => {})
  return run
}

// The browser eCoda reads cookies from, or null if none is configured yet.
export async function getBrowser(): Promise<string | null> {
  return (await readConfig()).browser ?? null
}

export async function setBrowser(id: string): Promise<void> {
  await writeConfig({ ...(await readConfig()), browser: id })
}

export async function disconnect(): Promise<void> {
  const config = await readConfig()
  delete config.browser
  await writeConfig(config)
}

// Preference for which view eCoda opens on startup. 'home' by default
// when nothing is set yet.
export async function getDefaultTab(): Promise<DefaultTab> {
  return (await readConfig()).defaultTab ?? 'home'
}

export async function setDefaultTab(tab: DefaultTab): Promise<void> {
  await writeConfig({ ...(await readConfig()), defaultTab: tab })
}

// User-chosen colour palette. 'purple' is the original/default.
export async function getTheme(): Promise<Theme> {
  return (await readConfig()).theme ?? 'purple'
}

export async function setTheme(theme: Theme): Promise<void> {
  await writeConfig({ ...(await readConfig()), theme })
}

export async function getLang(): Promise<Lang> {
  return (await readConfig()).lang ?? 'ru'
}

export async function setLang(lang: Lang): Promise<void> {
  await writeConfig({ ...(await readConfig()), lang })
}

// Audio quality preset for new downloads. Default 'best' so we ship
// Premium-quality audio out of the box; users on tight disks can opt
// down. Doesn't affect already-downloaded files.
export async function getAudioQuality(): Promise<AudioQuality> {
  return (await readConfig()).audioQuality ?? 'best'
}

export async function setAudioQuality(q: AudioQuality): Promise<void> {
  await writeConfig({ ...(await readConfig()), audioQuality: q })
}

// Shuffle / repeat are persisted because the streamer use case wants
// "once I've set my modes, they stay set across restarts".
export async function getShuffleMode(): Promise<boolean> {
  return (await readConfig()).shuffleMode ?? false
}

export async function setShuffleMode(on: boolean): Promise<void> {
  await writeConfig({ ...(await readConfig()), shuffleMode: on })
}

export async function getRepeatMode(): Promise<RepeatMode> {
  return (await readConfig()).repeatMode ?? 'off'
}

export async function setRepeatMode(m: RepeatMode): Promise<void> {
  await writeConfig({ ...(await readConfig()), repeatMode: m })
}

// What the window's close button does. Default 'tray' for the
// music-player-shouldn't-die-when-X-clicked reason; user can flip to
// 'quit' in Settings if they prefer the X to actually exit.
export async function getCloseAction(): Promise<CloseAction> {
  return (await readConfig()).closeAction ?? 'tray'
}

export async function setCloseAction(action: CloseAction): Promise<void> {
  await writeConfig({ ...(await readConfig()), closeAction: action })
}

// Media-key handling mode — see the MediaKeyMode type above. NOTE: the boot
// path in index.ts reads this field SYNCHRONOUSLY (readFileSync) before
// app.ready, because the Chromium feature flag must be appended before then;
// keep the field name in sync if it ever changes.
export async function getMediaKeyMode(): Promise<MediaKeyMode> {
  const mode = (await readConfig()).mediaKeyMode
  return mode === 'global' ? 'global' : 'system'
}

export async function setMediaKeyMode(mode: MediaKeyMode): Promise<void> {
  await writeConfig({ ...(await readConfig()), mediaKeyMode: mode })
}

// Audio output device — null/absent means "system default". Passing null
// deletes the field so a fresh config stays clean.
export async function getAudioOutputDevice(): Promise<AudioOutputDevice | null> {
  const dev = (await readConfig()).audioOutputDevice
  return dev && typeof dev.id === 'string' && dev.id !== '' ? dev : null
}

export async function setAudioOutputDevice(dev: AudioOutputDevice | null): Promise<void> {
  const cfg = await readConfig()
  if (dev && dev.id) {
    cfg.audioOutputDevice = { id: dev.id, label: dev.label ?? '' }
  } else {
    delete cfg.audioOutputDevice
  }
  await writeConfig(cfg)
}

// Crossfade duration in seconds for natural track transitions. 0
// disables; clamped to [0, 12] on write so a corrupted config can't
// leave the player with a 60-second fade.
export async function getCrossfadeDuration(): Promise<number> {
  const v = (await readConfig()).crossfadeDuration
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(12, v)) : 0
}

export async function setCrossfadeDuration(seconds: number): Promise<void> {
  const clamped = Math.max(0, Math.min(12, Math.round(seconds)))
  await writeConfig({ ...(await readConfig()), crossfadeDuration: clamped })
}

// 10-band equalizer state. Default is disabled + flat. We validate the
// gains array length + clamp each band to [-12, +12] dB on read so a
// hand-edited or version-skewed config can't feed NaN / wrong-length
// data into the Web Audio filter chain (which would throw and kill
// audio).
const EQ_BANDS = 10
function flatGains(): number[] {
  return new Array(EQ_BANDS).fill(0)
}
export async function getEqualizer(): Promise<EqualizerState> {
  const raw = (await readConfig()).equalizer
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, preset: 'flat', gains: flatGains() }
  }
  let gains = Array.isArray(raw.gains) ? raw.gains.slice(0, EQ_BANDS) : flatGains()
  // Pad / sanitise to exactly EQ_BANDS finite values in range.
  gains = Array.from({ length: EQ_BANDS }, (_, i) => {
    const v = gains[i]
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0
  })
  return {
    enabled: !!raw.enabled,
    preset: typeof raw.preset === 'string' ? raw.preset : 'custom',
    gains
  }
}

export async function setEqualizer(state: EqualizerState): Promise<void> {
  const gains = Array.from({ length: EQ_BANDS }, (_, i) => {
    const v = state.gains?.[i]
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0
  })
  await writeConfig({
    ...(await readConfig()),
    equalizer: {
      enabled: !!state.enabled,
      preset: typeof state.preset === 'string' ? state.preset : 'custom',
      gains
    }
  })
}

// Per-playlist override (custom track order + pinned set). null result
// means no override stored — renderer should show YT's natural order.
export async function getPlaylistOverride(
  playlistId: string
): Promise<PlaylistOverride | null> {
  const map = (await readConfig()).playlistOverrides ?? {}
  return map[playlistId] ?? null
}

// Saving null deletes the entry. Used by "Reset to default" (future
// menu action) and by the renderer when it decides the override is
// stale beyond repair.
export async function setPlaylistOverride(
  playlistId: string,
  override: PlaylistOverride | null
): Promise<void> {
  const cfg = await readConfig()
  const map = { ...(cfg.playlistOverrides ?? {}) }
  if (override === null) {
    delete map[playlistId]
  } else {
    map[playlistId] = override
  }
  cfg.playlistOverrides = map
  await writeConfig(cfg)
}

// InnerTube locale tuple derived from the user's UI language. Used by
// metadata.ts when building Innertube + by token-harvest.ts when
// signing /browse / /player calls — so section titles / "N tracks" /
// auto-playlist names come back in the language the user sees.
export async function getLocale(): Promise<{ hl: string; gl: string }> {
  const lang = await getLang()
  if (lang === 'en') return { hl: 'en', gl: 'US' }
  return { hl: 'ru', gl: 'RU' }
}

// "Liked Music" — auto-pinned, always first. The pseudo-id "LM" is what
// YT Music uses for the user's Likes auto-playlist; metadata layer
// prepends "VL" before sending to /browse.
const LIKED_MUSIC_PIN: PinnedPlaylist = {
  id: 'LM',
  title: 'Liked Music',
  thumbnail: ''
}

export async function getPinnedPlaylists(): Promise<PinnedPlaylist[]> {
  const cfg = await readConfig()
  const raw = cfg.pinnedPlaylists ?? []
  // Migrate: a past bug in `updatePinSnapshot` matched by exact id, so a
  // user who opened Liked Music via both code paths could end up with
  // BOTH 'LM' and 'VLLM' persisted as separate pins (visible as the
  // playlist appearing twice in the sidebar). Collapse them to the
  // record with a richer snapshot (non-empty thumbnail wins) and
  // persist the cleaned list so it heals on first launch after upgrade.
  const lmIdx = raw.findIndex((p) => p.id === 'LM')
  const vllmIdx = raw.findIndex((p) => p.id === 'VLLM')
  if (lmIdx >= 0 && vllmIdx >= 0) {
    const lm = raw[lmIdx]
    const vllm = raw[vllmIdx]
    const survivor = vllm.thumbnail ? vllm : lm.thumbnail ? lm : vllm
    const cleaned = raw.filter((_, i) => i !== lmIdx && i !== vllmIdx)
    cleaned.unshift(survivor)
    cfg.pinnedPlaylists = cleaned
    await writeConfig(cfg)
    return cleaned
  }
  // Make sure Liked Music is always present and at the top, even if the
  // user has never opened it yet.
  const hasLM = raw.some((p) => p.id === 'LM' || p.id === 'VLLM')
  if (hasLM) return raw
  return [LIKED_MUSIC_PIN, ...raw]
}

// Refreshes the title + thumbnail snapshot of an already-pinned playlist
// (or persists Liked Music for the first time with real metadata). Used
// when the renderer learns about a better cover than what's stored —
// notably the first time the user opens Liked Music from any path.
export async function updatePinSnapshot(item: PinnedPlaylist): Promise<void> {
  const cfg = await readConfig()
  const list = cfg.pinnedPlaylists ?? []
  // Liked Music has two interchangeable ids: 'LM' (raw) and 'VLLM' (with
  // the /browse prefix the metadata layer prepends). Both refer to the
  // same playlist — collapse them onto the same slot so we never write
  // both as separate pins.
  const isLM = item.id === 'LM' || item.id === 'VLLM'
  const idx = list.findIndex((p) =>
    isLM ? p.id === 'LM' || p.id === 'VLLM' : p.id === item.id
  )
  if (idx >= 0) {
    list[idx] = item
    cfg.pinnedPlaylists = list
    await writeConfig(cfg)
    return
  }
  // Liked Music auto-pin: not yet in the persisted list but always shown
  // in the UI. Persist now so the cover survives a restart.
  if (isLM) {
    list.unshift(item)
    cfg.pinnedPlaylists = list
    await writeConfig(cfg)
  }
}

// Window bounds + maximized flag persisted across launches. The renderer
// doesn't talk to these directly — index.ts handles save/restore around
// the main BrowserWindow lifecycle.
export async function getWindowState(): Promise<WindowState | null> {
  return (await readConfig()).windowState ?? null
}

export async function setWindowState(state: WindowState): Promise<void> {
  await writeConfig({ ...(await readConfig()), windowState: state })
}

// Last track + queue context + position. Saved on track change / pause /
// throttled timeupdate; cleared on auth disconnect (no point pointing the
// user at a track they can no longer resolve).
export async function getLastSession(): Promise<LastSession | null> {
  return (await readConfig()).lastSession ?? null
}

export async function setLastSession(session: LastSession): Promise<void> {
  await writeConfig({ ...(await readConfig()), lastSession: session })
}

export async function clearLastSession(): Promise<void> {
  const cfg = await readConfig()
  delete cfg.lastSession
  await writeConfig(cfg)
}

// Toggles a playlist's pinned state. Returns true if it's pinned now,
// false if it was just unpinned. Liked Music can't be un-pinned (special).
export async function togglePinnedPlaylist(item: PinnedPlaylist): Promise<boolean> {
  if (item.id === 'LM' || item.id === 'VLLM') {
    // Pinning Liked Music is a no-op (it's always pinned), unpinning is
    // disallowed.
    return true
  }
  const cfg = await readConfig()
  const list = cfg.pinnedPlaylists ?? []
  const idx = list.findIndex((p) => p.id === item.id)
  if (idx >= 0) {
    list.splice(idx, 1)
    cfg.pinnedPlaylists = list
    await writeConfig(cfg)
    return false
  }
  // Stash a snapshot of the user-visible label + cover so sidebar can
  // render without phoning home.
  list.push({ id: item.id, title: item.title, thumbnail: item.thumbnail })
  cfg.pinnedPlaylists = list
  await writeConfig(cfg)
  return true
}

// How many recently-used "add to playlist" targets we remember. Mirrors the
// short "Recent" row YT Music shows at the top of its add-to-playlist sheet.
const RECENT_ADD_CAP = 8

// Playlists the user has recently added a track into, most-recent-first.
// Drives the "Recent" row in the add-to-playlist modal.
export async function getRecentAddPlaylists(): Promise<RecentPlaylist[]> {
  return (await readConfig()).recentAddPlaylists ?? []
}

// Records a playlist as the most-recently-used add target. Moves an existing
// entry to the front (refreshing its title/cover snapshot) rather than
// duplicating it, and trims the list to RECENT_ADD_CAP. Called from the
// add-to-playlist IPC handler on a successful add.
export async function pushRecentAddPlaylist(item: RecentPlaylist): Promise<void> {
  if (!item?.id) return
  const cfg = await readConfig()
  const list = (cfg.recentAddPlaylists ?? []).filter((p) => p.id !== item.id)
  list.unshift({ id: item.id, title: item.title, thumbnail: item.thumbnail })
  cfg.recentAddPlaylists = list.slice(0, RECENT_ADD_CAP)
  await writeConfig(cfg)
}

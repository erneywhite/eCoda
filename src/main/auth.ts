import { app } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
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
  // For forks: candidate executable locations. Required for detection — a
  // stale Profiles directory from a past install must not count as installed.
  exePaths?: string[]
}

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const APPDATA = process.env.APPDATA ?? ''
const PROGRAMFILES = process.env['ProgramFiles'] ?? ''
const PROGRAMFILES_X86 = process.env['ProgramFiles(x86)'] ?? ''

const BROWSERS: BrowserDef[] = [
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

interface Config {
  browser?: string
  defaultTab?: DefaultTab
  theme?: Theme
  lang?: Lang
  audioQuality?: AudioQuality
  shuffleMode?: boolean
  repeatMode?: RepeatMode
  pinnedPlaylists?: PinnedPlaylist[]
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

async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8')) as Config
  } catch {
    return {}
  }
}

async function writeConfig(config: Config): Promise<void> {
  await writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8')
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
  const list = (await readConfig()).pinnedPlaylists ?? []
  // Make sure Liked Music is always present and at the top, even if the
  // user has never opened it yet.
  const hasLM = list.some((p) => p.id === 'LM' || p.id === 'VLLM')
  if (hasLM) return list
  return [LIKED_MUSIC_PIN, ...list]
}

// Refreshes the title + thumbnail snapshot of an already-pinned playlist
// (or persists Liked Music for the first time with real metadata). Used
// when the renderer learns about a better cover than what's stored —
// notably the first time the user opens Liked Music from any path.
export async function updatePinSnapshot(item: PinnedPlaylist): Promise<void> {
  const cfg = await readConfig()
  const list = cfg.pinnedPlaylists ?? []
  const idx = list.findIndex((p) => p.id === item.id)
  if (idx >= 0) {
    list[idx] = item
    cfg.pinnedPlaylists = list
    await writeConfig(cfg)
    return
  }
  // Liked Music auto-pin: not yet in the persisted list but always shown
  // in the UI. Persist now so the cover survives a restart.
  if (item.id === 'LM' || item.id === 'VLLM') {
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

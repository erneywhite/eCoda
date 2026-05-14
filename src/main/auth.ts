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
}

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const APPDATA = process.env.APPDATA ?? ''

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
  // Firefox forks — same cookie format, read as firefox:<profile path>
  {
    id: 'waterfox',
    name: 'Waterfox',
    profileRoot: join(APPDATA, 'Waterfox', 'Profiles'),
    kind: 'firefox-fork'
  },
  {
    id: 'librewolf',
    name: 'LibreWolf',
    profileRoot: join(APPDATA, 'librewolf', 'Profiles'),
    kind: 'firefox-fork'
  },
  {
    id: 'floorp',
    name: 'Floorp',
    profileRoot: join(APPDATA, 'Floorp', 'Profiles'),
    kind: 'firefox-fork'
  },
  {
    id: 'zen',
    name: 'Zen Browser',
    profileRoot: join(APPDATA, 'zen', 'Profiles'),
    kind: 'firefox-fork'
  }
]

export interface DetectedBrowser {
  id: string
  name: string
}

// The supported browsers actually installed on this machine.
export function detectBrowsers(): DetectedBrowser[] {
  return BROWSERS.filter((b) => b.profileRoot && existsSync(b.profileRoot)).map(({ id, name }) => ({
    id,
    name
  }))
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

interface Config {
  browser?: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
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

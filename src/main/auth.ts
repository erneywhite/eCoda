import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Browsers yt-dlp can read cookies from. `probe` is a path that exists only
// once the browser is installed and has created a profile.
interface BrowserDef {
  id: string
  name: string
  probe: string
}

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const APPDATA = process.env.APPDATA ?? ''

const BROWSERS: BrowserDef[] = [
  { id: 'firefox', name: 'Firefox', probe: join(APPDATA, 'Mozilla', 'Firefox', 'Profiles') },
  { id: 'chrome', name: 'Chrome', probe: join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data') },
  { id: 'edge', name: 'Edge', probe: join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data') },
  {
    id: 'brave',
    name: 'Brave',
    probe: join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data')
  },
  { id: 'opera', name: 'Opera', probe: join(APPDATA, 'Opera Software', 'Opera Stable') },
  { id: 'vivaldi', name: 'Vivaldi', probe: join(LOCALAPPDATA, 'Vivaldi', 'User Data') }
]

export interface DetectedBrowser {
  id: string
  name: string
}

// The supported browsers actually installed on this machine.
export function detectBrowsers(): DetectedBrowser[] {
  return BROWSERS.filter((b) => b.probe && existsSync(b.probe)).map(({ id, name }) => ({
    id,
    name
  }))
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

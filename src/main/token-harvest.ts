import { BrowserWindow } from 'electron'
import { MUSIC_PARTITION, importCookiesToMusicSession } from './library-session'

// In-page client config that the real YT Music web app uses for every
// InnerTube call. Once we have these we can mint our own InnerTube
// requests that the server treats as logged-in.
export interface HarvestedTokens {
  visitorData: string | null
  innertubeApiKey: string | null
  innertubeClientName: string | null
  innertubeClientVersion: string | null
  loggedIn: boolean
}

const TTL_MS = 30 * 60 * 1000
let cache: { tokens: HarvestedTokens; at: number } | null = null
let inflight: Promise<HarvestedTokens | null> | null = null

// Harvests tokens by loading music.youtube.com in an off-screen Electron
// window on the persist:music partition (which already has our auth
// cookies after importCookiesToMusicSession). After the page loads we
// pull window.ytcfg.data_ via executeJavaScript and destroy the window.
//
// Cached for 30 minutes — visitor_data has a long life but YT rotates
// it occasionally; periodic refresh is cheap (one page load).
export async function harvestTokens(): Promise<HarvestedTokens | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.tokens
  if (inflight) return inflight
  inflight = doHarvest()
  try {
    const r = await inflight
    if (r) cache = { tokens: r, at: Date.now() }
    return r
  } finally {
    inflight = null
  }
}

async function doHarvest(): Promise<HarvestedTokens | null> {
  // Make sure cookies are loaded into the partition before we open a
  // window on it. Idempotent and cheap if they're already there.
  await importCookiesToMusicSession().catch(() => undefined)

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      partition: MUSIC_PARTITION,
      // Disable preload + sandbox so the page can run normally
      sandbox: false,
      contextIsolation: true
    }
  })

  try {
    const t0 = Date.now()
    // Use a small page that still bootstraps ytcfg — the explore page
    // loads faster than the heavy "Home" feed.
    await win.loadURL('https://music.youtube.com/', { userAgent: undefined })

    // ytcfg is populated synchronously by an inline <script> in the
    // initial HTML, so by did-finish-load it's there. Read it.
    const tokens: HarvestedTokens = await win.webContents.executeJavaScript(
      `(() => {
        const cfg = (window).ytcfg && (window).ytcfg.data_ ? (window).ytcfg.data_ : {};
        const ctx = cfg.INNERTUBE_CONTEXT || {};
        const client = ctx.client || {};
        return {
          visitorData: cfg.VISITOR_DATA || client.visitorData || null,
          innertubeApiKey: cfg.INNERTUBE_API_KEY || null,
          innertubeClientName: cfg.INNERTUBE_CLIENT_NAME || client.clientName || null,
          innertubeClientVersion: cfg.INNERTUBE_CLIENT_VERSION || client.clientVersion || null,
          loggedIn: cfg.LOGGED_IN === true
        };
      })()`
    )
    const ms = Date.now() - t0
    console.log(
      `[token-harvest] (${ms}ms) loggedIn=${tokens.loggedIn} visitorData=${tokens.visitorData ? tokens.visitorData.slice(0, 20) + '…' : '(none)'} client=${tokens.innertubeClientName}/${tokens.innertubeClientVersion}`
    )

    if (!tokens.visitorData) {
      console.warn('[token-harvest] no visitor_data on page — page probably did not load logged-in')
      return null
    }
    return tokens
  } catch (err) {
    console.warn('[token-harvest] failed:', err)
    return null
  } finally {
    // destroy() unconditionally; we never want the harvest window to linger.
    win.destroy()
  }
}

// Force a fresh harvest on the next call. Called from auth flows when
// the underlying session might have changed.
export function resetHarvest(): void {
  cache = null
}

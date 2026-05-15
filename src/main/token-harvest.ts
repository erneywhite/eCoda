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
      `[token-harvest] (${ms}ms) loggedIn=${tokens.loggedIn} client=${tokens.innertubeClientName}/${tokens.innertubeClientVersion}`
    )
    if (tokens.visitorData) console.log(`[token-harvest] visitor_data: ${tokens.visitorData}`)

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
// the underlying session might have changed. Also tears down the
// long-lived proxy window so the next request gets a fresh page.
export function resetHarvest(): void {
  cache = null
  destroyProxyWindow()
}

// Long-lived hidden music.youtube.com page reused for every InnerTube call.
// loadURL is expensive (~2-3s) but once the page is up subsequent requests
// are just a single executeJavaScript round trip (~50-150ms). We tear the
// window down on auth:disconnect via resetHarvest.
let proxyWindow: BrowserWindow | null = null
let proxyReady: Promise<BrowserWindow> | null = null

async function getProxyWindow(): Promise<BrowserWindow> {
  if (proxyWindow && !proxyWindow.isDestroyed()) return proxyWindow
  if (proxyReady) return proxyReady
  proxyReady = (async () => {
    await importCookiesToMusicSession().catch(() => undefined)
    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        partition: MUSIC_PARTITION,
        sandbox: false,
        contextIsolation: true
      }
    })
    try {
      await win.loadURL('https://music.youtube.com/')
      proxyWindow = win
      return win
    } catch (err) {
      win.destroy()
      proxyReady = null
      throw err
    }
  })()
  return proxyReady
}

function destroyProxyWindow(): void {
  if (proxyWindow && !proxyWindow.isDestroyed()) proxyWindow.destroy()
  proxyWindow = null
  proxyReady = null
}

// Runs an authenticated InnerTube call by routing it through the live page
// context. The page computes SAPISIDHASH from document.cookie and attaches
// all the X-Goog-* / X-YouTube-* headers Google expects; Chrome adds the
// cookies for free. Server treats the call as logged_in.
export async function innertubeFetch(endpoint: string, body: object): Promise<unknown> {
  const win = await getProxyWindow()
  const bodyJson = JSON.stringify(body)
  // SAPISIDHASH-signed POST runs in the page context, so cookies are
  // attached natively and we synthesise the auth header from
  // document.cookie + crypto.subtle. clientBody is merged with the page's
  // own ytcfg context so we don't have to maintain client_name /
  // client_version separately.
  const json = await win.webContents.executeJavaScript(
    `(async (endpoint, bodyJson) => {
      const cfg = (window).ytcfg.data_;
      const ctx = cfg.INNERTUBE_CONTEXT;
      const visitorData = cfg.VISITOR_DATA || (ctx.client && ctx.client.visitorData);
      const clientName = cfg.INNERTUBE_CONTEXT_CLIENT_NAME || '67';
      const clientVersion = cfg.INNERTUBE_CONTEXT_CLIENT_VERSION || (ctx.client && ctx.client.clientVersion);
      const cookies = Object.fromEntries(
        document.cookie.split('; ').map(c => {
          const eq = c.indexOf('=');
          return [c.slice(0, eq), c.slice(eq + 1)];
        })
      );
      const sapisid = cookies['__Secure-3PAPISID'] || cookies['SAPISID'];
      if (!sapisid) throw new Error('No SAPISID cookie in page context');
      const ts = Math.floor(Date.now() / 1000);
      const origin = 'https://music.youtube.com';
      const data = new TextEncoder().encode(ts + ' ' + sapisid + ' ' + origin);
      const hashBuf = await crypto.subtle.digest('SHA-1', data);
      const hashHex = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const auth =
        'SAPISIDHASH ' + ts + '_' + hashHex +
        ' SAPISID1PHASH ' + ts + '_' + hashHex +
        ' SAPISID3PHASH ' + ts + '_' + hashHex;
      // Merge caller body with ytcfg's own context — context.client carries
      // visitor_data + experiments + locale and is required for every call.
      const callerBody = JSON.parse(bodyJson);
      const finalBody = Object.assign({}, callerBody, { context: ctx });
      const r = await fetch('/youtubei/v1' + endpoint + '?prettyPrint=false', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'Authorization': auth,
          'X-Origin': origin,
          'X-Goog-AuthUser': '0',
          'X-Goog-Visitor-Id': visitorData || '',
          'X-YouTube-Client-Name': String(clientName),
          'X-YouTube-Client-Version': String(clientVersion || '')
        },
        body: JSON.stringify(finalBody)
      });
      return await r.text();
    })(${JSON.stringify(endpoint)}, ${JSON.stringify(bodyJson)})`
  )
  return JSON.parse(json)
}

// Convenience wrapper for the /browse endpoint. Old name kept for the
// debug IPC handler.
export async function browseViaPage(browseId: string): Promise<unknown> {
  return innertubeFetch('/browse', { browseId })
}

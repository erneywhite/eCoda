import { app, shell, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import icon from '../../resources/icon.png?asset'
import { verifyBrowserLogin } from './ytdlp'
import {
  detectBrowsers,
  getBrowser,
  setBrowser,
  disconnect,
  ytdlpBrowserArg,
  getDefaultTab,
  setDefaultTab,
  getPinnedPlaylists,
  togglePinnedPlaylist,
  updatePinSnapshot,
  getTheme,
  setTheme,
  getLang,
  setLang,
  type DefaultTab,
  type Lang,
  type PinnedPlaylist,
  type Theme
} from './auth'
import {
  searchSongs,
  getHomeSections,
  getPlaylistTracks,
  getLibraryPlaylists,
  resetInnertube
} from './metadata'
import { resolveCached, queuePrefetch, clearResolverCache } from './resolver'
import {
  downloadOne,
  downloadMany,
  deleteDownloadedTrack,
  getCachedFilePath,
  getCachedThumbPath,
  getCacheStats,
  clearAllDownloads,
  getDownloadedStatus,
  listDownloadedTracks,
  type TrackInfo
} from './downloads'
import { importCookiesToMusicSession, clearMusicSessionCookies } from './library-session'
import { harvestTokens, resetHarvest, browseViaPage, innertubeFetch } from './token-harvest'
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  registerMainWindow,
  silentCheckOnStartup
} from './updater'

let mainWindow: BrowserWindow | null = null

// Privileged custom protocol so the renderer can play offline-cached audio
// without bumping into webSecurity / CSP rules that block bare file://
// URLs from a non-file:// page. Must be registered before app.ready —
// once whenReady() fires we then `protocol.handle('media', ...)` to wire
// up the actual file serving.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  }
])

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0c0816',
    title: 'eCoda',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // The Library tab uses <webview> to embed music.youtube.com with our
      // cookies imported into a dedicated session partition. webviewTag is
      // off by default in modern Electron; we need it on.
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // DevTools open by default in dev only — easier to inspect renderer
    // logs and network without poking Ctrl+Shift+I every launch.
    if (!app.isPackaged) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
    // Hand the window over to the updater module so it can stream
    // lifecycle events to the renderer, then fire a silent check.
    if (mainWindow) {
      registerMainWindow(mainWindow)
      silentCheckOnStartup()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Wire up media:// — translates media://<kind>/<videoId> to the file
  // on disk and lets Electron's net module stream it (Range requests,
  // content-type sniffing, the lot). HTML5 <audio>/<img>/background-image
  // talk to it identically to a regular https stream.
  //
  //   media://audio/<videoId>  → cached audio file
  //   media://thumb/<videoId>  → cached cover thumbnail
  //
  // Standard-scheme URLs lowercase their host (per URL spec). The kind
  // labels are all-lowercase so that's fine; the videoId lives in the
  // path which preserves case.
  protocol.handle('media', (request) => {
    const u = new URL(request.url)
    const kind = u.hostname
    const videoId = u.pathname.replace(/^\//, '').trim()
    let path: string | null = null
    if (kind === 'audio') path = getCachedFilePath(videoId)
    else if (kind === 'thumb') path = getCachedThumbPath(videoId)
    if (!path) {
      console.warn(`[media://] not found ${kind}/${videoId} (url=${request.url})`)
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(path).toString())
  })

  ipcMain.handle('auth:browsers', () => detectBrowsers())
  ipcMain.handle('auth:status', () => getBrowser())
  ipcMain.handle('auth:connect', async (_event, browser: string) => {
    const arg = ytdlpBrowserArg(browser)
    if (!arg) return false
    const ok = await verifyBrowserLogin(arg)
    if (ok) {
      await setBrowser(browser)
      // The cookies file was just refreshed by verifyBrowserLogin; force
      // youtubei.js to pick them up on the next request.
      resetInnertube()
      resetHarvest()
      // Push the same cookies into the persist:music partition so the
      // Library tab's <webview> sees a live YT Music session, then prime
      // the token harvest in the background so Phase B paths are warm.
      void importCookiesToMusicSession()
        .then(() => harvestTokens())
        .catch((err) => console.warn('[auth:connect] post-import flow failed:', err))
    }
    return ok
  })
  ipcMain.handle('auth:disconnect', async () => {
    await disconnect()
    resetInnertube()
    resetHarvest()
    clearResolverCache()
    await clearMusicSessionCookies()
    return true
  })
  ipcMain.handle('auth:open-youtube', () => {
    shell.openExternal('https://www.youtube.com/')
    return true
  })
  ipcMain.handle('metadata:search', (_event, query: string) => searchSongs(query))
  ipcMain.handle('metadata:home', () => getHomeSections())
  ipcMain.handle('metadata:playlist', (_event, id: string) => getPlaylistTracks(id))
  // Native library (Phase B) — single section of the user's playlists,
  // fetched via the page-proxy so the server treats us as logged-in.
  ipcMain.handle('metadata:library-playlists', () => getLibraryPlaylists())
  // Ensures the persist:music partition has fresh YouTube cookies before
  // the renderer mounts the Library <webview>. Idempotent.
  ipcMain.handle('library:prepare', async () => {
    try {
      const n = await importCookiesToMusicSession()
      return { ok: true, cookies: n }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // Diagnostic — pulls the live ytcfg.data_ from a hidden music.youtube.com
  // window. Phase B groundwork: visitor_data + client info we'll pipe into
  // youtubei.js so it stops being treated as anonymous.
  ipcMain.handle('debug:harvest-tokens', async () => {
    const t = await harvestTokens()
    return t
  })
  // Diagnostic — dumps a /browse response to userData/debug-<id>.json so
  // we can inspect the raw shape next time YouTube changes the schema.
  ipcMain.handle('debug:save-browse', async (_event, browseId: string) => {
    try {
      const data = await innertubeFetch('/browse', { browseId })
      const file = join(app.getPath('userData'), `debug-${browseId.replace(/[^\w-]/g, '_')}.json`)
      const fs = await import('node:fs')
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
      console.log('[debug] wrote', file)
      return { ok: true, file }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // Diagnostic — proxies a /browse call through the hidden window so the
  // request gets signed by the real browser engine. Use to verify whether
  // logged_in flips to 1 this way (it should — the page itself shows
  // logged_in=true).
  ipcMain.handle('debug:browse-via-page', async (_event, browseId: string) => {
    const t0 = Date.now()
    try {
      const data = await browseViaPage(browseId)
      const ms = Date.now() - t0
      const d = data as Record<string, unknown>
      const responseContext = (d.responseContext ?? {}) as Record<string, unknown>
      const params = (responseContext.serviceTrackingParams ?? []) as Array<{
        service: string
        params?: Array<{ key: string; value: string }>
      }>
      const flat: Record<string, string> = {}
      for (const grp of params) {
        for (const p of grp.params ?? []) flat[`${grp.service}.${p.key}`] = p.value
      }
      console.log(
        `[browseViaPage] ${browseId} (${ms}ms) logged_in=${flat['GFEEDBACK.logged_in']} yt_li=${flat['CSI.yt_li']}`
      )
      return { ok: true, ms, loggedIn: flat['GFEEDBACK.logged_in'] === '1', topKeys: Object.keys(d) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // Resolves a single track's stream URL. yt-dlp is the only working path —
  // youtubei.js can't get music streams without po_token (see metadata.ts).
  // Resolves go through resolver.ts so re-clicks and prefetched tracks come
  // back from the in-memory cache instantly.
  ipcMain.handle('audio:resolve', async (_event, input: string) => {
    const browser = await getBrowser()
    if (!browser) {
      throw new Error('No browser connected — connect a browser first.')
    }
    const arg = ytdlpBrowserArg(browser)
    if (!arg) {
      throw new Error('Could not resolve cookies for the connected browser.')
    }
    return resolveCached(input, arg)
  })
  // Fire-and-forget — renderer hands off "next N tracks" once playback
  // starts, so by the time the user clicks the next one its URL is ready.
  ipcMain.handle('audio:prefetch', async (_event, ids: string[]) => {
    const browser = await getBrowser()
    if (!browser) return false
    const arg = ytdlpBrowserArg(browser)
    if (!arg) return false
    queuePrefetch(Array.isArray(ids) ? ids : [], arg)
    return true
  })

  // -------- Downloads (Phase 2: offline cache) ---------------------------
  // Returns the subset of provided ids that are already cached on disk.
  ipcMain.handle('downloads:status', (_event, ids: string[]) =>
    getDownloadedStatus(Array.isArray(ids) ? ids : [])
  )
  ipcMain.handle('downloads:list', () => listDownloadedTracks())
  // Downloads a single track. Renderer passes the metadata it already has
  // so we don't fetch it twice.
  ipcMain.handle('downloads:track', async (_event, info: TrackInfo) => {
    const browser = await getBrowser()
    if (!browser) throw new Error('No browser connected')
    const arg = ytdlpBrowserArg(browser)
    if (!arg) throw new Error('Cookies unavailable')
    return downloadOne(info, arg)
  })
  // Downloads a whole playlist sequentially. Progress events are streamed
  // back to the renderer so it can show "12 / 95".
  ipcMain.handle('downloads:playlist', async (event, tracks: TrackInfo[]) => {
    const browser = await getBrowser()
    if (!browser) throw new Error('No browser connected')
    const arg = ytdlpBrowserArg(browser)
    if (!arg) throw new Error('Cookies unavailable')
    await downloadMany(Array.isArray(tracks) ? tracks : [], arg, (done, total, current, errored) => {
      event.sender.send('downloads:progress', {
        done,
        total,
        videoId: current.videoId,
        title: current.title,
        errored
      })
    })
    return true
  })
  ipcMain.handle('downloads:delete', (_event, videoId: string) => deleteDownloadedTrack(videoId))
  ipcMain.handle('downloads:stats', () => getCacheStats())
  ipcMain.handle('downloads:clearAll', () => clearAllDownloads())

  // App-level info for Settings.
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    userData: app.getPath('userData'),
    repoUrl: 'https://github.com/erneywhite/eCoda'
  }))
  ipcMain.handle('settings:getDefaultTab', () => getDefaultTab())
  ipcMain.handle('settings:setDefaultTab', (_event, tab: DefaultTab) => setDefaultTab(tab))
  ipcMain.handle('settings:getPinned', () => getPinnedPlaylists())
  ipcMain.handle('settings:togglePin', (_event, item: PinnedPlaylist) =>
    togglePinnedPlaylist(item)
  )
  ipcMain.handle('settings:updatePinSnapshot', (_event, item: PinnedPlaylist) =>
    updatePinSnapshot(item)
  )
  ipcMain.handle('settings:getTheme', () => getTheme())
  ipcMain.handle('settings:setTheme', (_event, theme: Theme) => setTheme(theme))
  ipcMain.handle('settings:getLang', () => getLang())
  ipcMain.handle('settings:setLang', (_event, lang: Lang) => setLang(lang))

  // Auto-update IPC. `update:event` flows back via webContents.send from
  // the updater module — renderer subscribes once and reacts to each
  // lifecycle state.
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => {
    installUpdate()
    return true
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

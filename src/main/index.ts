import { app, shell, BrowserWindow, ipcMain, protocol, net, screen } from 'electron'
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
  getAudioQuality,
  setAudioQuality,
  getWindowState,
  setWindowState,
  getLastSession,
  setLastSession,
  clearLastSession,
  type AudioQuality,
  type DefaultTab,
  type Lang,
  type LastSession,
  type PinnedPlaylist,
  type Theme,
  type WindowState
} from './auth'
import { installLogger, getLogPath } from './logger'
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
  getDownloadsAsPlaylist,
  verifyCache,
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

// Validate saved bounds against the live display layout — a monitor that
// was attached last session may be gone now, in which case the window would
// "open" off-screen and look like it never launched. We require the bounds
// to intersect at least one display's workArea with a 100px overlap so a
// barely-clipped window still counts as on-screen.
function isOnScreen(b: { x: number; y: number; width: number; height: number }): boolean {
  const displays = screen.getAllDisplays()
  for (const d of displays) {
    const wa = d.workArea
    const ix = Math.max(b.x, wa.x)
    const iy = Math.max(b.y, wa.y)
    const ax = Math.min(b.x + b.width, wa.x + wa.width)
    const ay = Math.min(b.y + b.height, wa.y + wa.height)
    if (ax - ix >= 100 && ay - iy >= 100) return true
  }
  return false
}

// Debounced window-state writer. resize/move fire dozens of times per
// second while dragging; we coalesce them into a single config write.
let saveStateTimer: NodeJS.Timeout | null = null
function scheduleSaveWindowState(): void {
  if (saveStateTimer) clearTimeout(saveStateTimer)
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null
    if (!mainWindow || mainWindow.isDestroyed()) return
    // Don't save zero/minimized states — restoring to (0,0,0,0) would
    // make the next launch look broken.
    if (mainWindow.isMinimized()) return
    const isMaximized = mainWindow.isMaximized()
    // While maximized, getBounds() returns the maximized rect. We want the
    // RESTORED bounds for next-launch sizing, so use getNormalBounds().
    const b = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    if (b.width < 200 || b.height < 200) return
    const state: WindowState = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      isMaximized
    }
    void setWindowState(state).catch((err) => console.warn('[window-state] save failed:', err))
  }, 400)
}

async function createWindow(): Promise<void> {
  const saved = await getWindowState().catch(() => null)
  // Start from saved bounds if they exist AND are still on-screen.
  // Otherwise fall back to defaults centred by Electron.
  const useSaved =
    saved &&
    typeof saved.x === 'number' &&
    typeof saved.y === 'number' &&
    isOnScreen({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })

  mainWindow = new BrowserWindow({
    width: useSaved ? saved!.width : 1200,
    height: useSaved ? saved!.height : 800,
    x: useSaved ? saved!.x : undefined,
    y: useSaved ? saved!.y : undefined,
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
      webviewTag: true,
      // DevTools available in dev only — installed users shouldn't be
      // staring at a debugger by default, and disabling them here also
      // blocks Ctrl+Shift+I + the View → Developer Tools menu item.
      devTools: !app.isPackaged
    }
  })

  // Maximize after creation, not via the BrowserWindow options, so the
  // RESTORED bounds we just passed in stick when the user un-maximizes.
  if (saved?.isMaximized) mainWindow.maximize()

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

  // Window geometry persistence: every move/resize/maximize change kicks
  // a debounced write. close() fires AFTER the bounds are zeroed, so we
  // also save on 'close' to capture the very last state explicitly.
  mainWindow.on('resize', scheduleSaveWindowState)
  mainWindow.on('move', scheduleSaveWindowState)
  mainWindow.on('maximize', scheduleSaveWindowState)
  mainWindow.on('unmaximize', scheduleSaveWindowState)
  mainWindow.on('close', () => {
    if (saveStateTimer) {
      clearTimeout(saveStateTimer)
      saveStateTimer = null
    }
    if (!mainWindow || mainWindow.isDestroyed()) return
    const isMaximized = mainWindow.isMaximized()
    const b = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    if (b.width >= 200 && b.height >= 200) {
      const state: WindowState = {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        isMaximized
      }
      try {
        // Sync write via a fire-and-forget promise — we'll get cut off if
        // it doesn't resolve in time, but the debounced timer should have
        // already saved everything bar the very last micro-change.
        void setWindowState(state)
      } catch (err) {
        console.warn('[window-state] final save failed:', err)
      }
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

app.whenReady().then(async () => {
  // First thing after ready: hook console.log/warn/error into a file at
  // <userData>/main.log. The packaged app has no stdout console visible
  // to the user; without this we'd be flying blind whenever a bug needs
  // diagnosing from a real install.
  installLogger()
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
    // The resume-banner points at a track the user can no longer resolve
    // without auth. Drop it so we don't surface a dead link next launch.
    await clearLastSession()
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
  // so we don't fetch it twice. Live progress (0–100) is forwarded as
  // downloads:track-progress events keyed by videoId, so the UI can show
  // a real percentage ring instead of a generic spinner.
  ipcMain.handle('downloads:track', async (event, info: TrackInfo) => {
    const browser = await getBrowser()
    if (!browser) throw new Error('No browser connected')
    const arg = ytdlpBrowserArg(browser)
    if (!arg) throw new Error('Cookies unavailable')
    return downloadOne(info, arg, (percent) => {
      event.sender.send('downloads:track-progress', { videoId: info.videoId, percent })
    })
  })
  // Downloads a whole playlist sequentially. Progress events are streamed
  // back to the renderer so it can show "12 / 95" AND a live percentage on
  // the track that's currently being fetched. Returns a summary of what
  // worked and what failed so the UI can offer Retry-failed.
  ipcMain.handle('downloads:playlist', async (event, tracks: TrackInfo[]) => {
    const browser = await getBrowser()
    if (!browser) throw new Error('No browser connected')
    const arg = ytdlpBrowserArg(browser)
    if (!arg) throw new Error('Cookies unavailable')
    const summary = await downloadMany(
      Array.isArray(tracks) ? tracks : [],
      arg,
      (done, total, current, errored, errorReason) => {
        event.sender.send('downloads:progress', {
          done,
          total,
          videoId: current.videoId,
          title: current.title,
          errored,
          errorReason
        })
      },
      (videoId, percent) => {
        event.sender.send('downloads:track-progress', { videoId, percent })
      }
    )
    return summary
  })
  ipcMain.handle('downloads:delete', (_event, videoId: string) => deleteDownloadedTrack(videoId))
  ipcMain.handle('downloads:stats', () => getCacheStats())
  ipcMain.handle('downloads:clearAll', () => clearAllDownloads())
  // Scan the cache directory, reconcile manifest entries with files on
  // disk, and report what was patched up. Surfaced from Settings →
  // Diagnostics so the user can recover from a flaky restart by hand.
  ipcMain.handle('downloads:verify', () => verifyCache())
  // Materialises the offline cache as a synthetic playlist (sorted
  // newest-first, with cover taken from the latest download). Renderer
  // shows it under the "Downloaded" sidebar entry as a normal playlist
  // view, so play/delete UX is identical to any other list.
  ipcMain.handle('downloads:asPlaylist', () => getDownloadsAsPlaylist())

  // App-level info for Settings. logPath lets us surface "Open log file"
  // so the user can ship us the file when investigating bugs.
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    userData: app.getPath('userData'),
    logPath: getLogPath(),
    repoUrl: 'https://github.com/erneywhite/eCoda'
  }))
  // Open a folder or file in Explorer (Windows) / Finder (macOS). Used by
  // the Settings "Cache" and "Diagnostics" cards.
  ipcMain.handle('app:openPath', async (_event, target: string) => {
    if (!target) return false
    const err = await shell.openPath(target)
    if (err) console.warn('[app:openPath] failed:', target, err)
    return err === ''
  })
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
  ipcMain.handle('settings:setLang', async (_event, lang: Lang) => {
    await setLang(lang)
    // Locale-bound caches must be dropped so the next InnerTube call uses
    // the new hl/gl, not the cached one from the previous language.
    resetInnertube()
  })
  // Audio quality preset for new downloads — see formatSelectorFor() in
  // downloads.ts. Doesn't retroactively re-download anything.
  ipcMain.handle('settings:getAudioQuality', () => getAudioQuality())
  ipcMain.handle('settings:setAudioQuality', (_event, q: AudioQuality) => setAudioQuality(q))

  // Last-playing track + queue + position. Renderer pushes a snapshot on
  // every track change / pause / throttled timeupdate; we restore it on
  // launch as a paused track ready to resume.
  ipcMain.handle('session:get', () => getLastSession())
  ipcMain.handle('session:set', (_event, s: LastSession) => setLastSession(s))
  ipcMain.handle('session:clear', () => clearLastSession())

  // Auto-update IPC. `update:event` flows back via webContents.send from
  // the updater module — renderer subscribes once and reacts to each
  // lifecycle state.
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => {
    installUpdate()
    return true
  })

  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })

  // Silent reconnect: the userData carries forward across launches AND
  // across app versions (same appId → same %APPDATA%\ecoda path). But
  // YouTube periodically rotates SAPISID / __Secure-3PSID in the browser,
  // and our youtube-cookies.txt was last dumped on the previous Connect.
  // If the browser's live cookies have rotated since then, the file is
  // stale → persist:music imports stale cookies → page-proxy /browse
  // comes back logged_in=0 → Library is empty. We refresh on every launch
  // so the user never has to manually Disconnect+Connect just because
  // they reopened the app a day later or installed an upgrade.
  void silentReconnect()
})

// Refreshes the cookies file from the currently-installed-and-configured
// browser, then pushes them into persist:music and tears down any cached
// page-proxy state so the next InnerTube call uses the new session. Emits
// `auth:refreshed` so the renderer can drop any logged-in-required caches
// (Library, Home, current playlist) and re-fetch them with the new auth.
async function silentReconnect(): Promise<void> {
  const browser = await getBrowser()
  if (!browser) return
  const arg = ytdlpBrowserArg(browser)
  if (!arg) {
    console.warn('[startup-reconnect] cookies path could not be resolved:', browser)
    return
  }
  console.log('[startup-reconnect] refreshing cookies for', browser)
  const t0 = Date.now()
  try {
    const ok = await verifyBrowserLogin(arg)
    if (!ok) {
      console.warn(
        `[startup-reconnect] verifyBrowserLogin failed in ${Date.now() - t0}ms — cookies may have expired in the browser; user will need to Disconnect+Connect`
      )
      return
    }
    resetInnertube()
    resetHarvest()
    try {
      await importCookiesToMusicSession()
    } catch (err) {
      console.warn('[startup-reconnect] importCookiesToMusicSession failed:', err)
    }
    console.log(`[startup-reconnect] done in ${Date.now() - t0}ms`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:refreshed')
    }
  } catch (err) {
    console.warn('[startup-reconnect] failed:', err)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

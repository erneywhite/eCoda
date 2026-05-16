import { app, shell, BrowserWindow, ipcMain, protocol, screen, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import icon from '../../resources/icon.png?asset'
import { verifyBrowserLogin, startYtdlpDaemon, stopYtdlpDaemon } from './ytdlp'
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
  getShuffleMode,
  setShuffleMode,
  getRepeatMode,
  setRepeatMode,
  getCloseAction,
  setCloseAction,
  getCrossfadeDuration,
  setCrossfadeDuration,
  getPlaylistOverride,
  setPlaylistOverride,
  getWindowState,
  setWindowState,
  getLastSession,
  setLastSession,
  clearLastSession,
  type AudioQuality,
  type CloseAction,
  type PlaylistOverride,
  type RepeatMode,
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
  resetInnertube,
  likeTrack,
  getRadioForTrack,
  getArtistView
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
  cancelDownload,
  cancelAllDownloads,
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
// System tray icon. Lives for the whole app lifetime; the menu items
// proxy back to the renderer via webContents.send('tray:command', cmd).
let tray: Tray | null = null
// Flips true on Cmd+Q / Alt+F4 / tray-Quit / autoUpdater quit, so the
// `close` interceptor lets the window actually close instead of
// hiding it back into the tray. Reset is never needed — once we're
// quitting, we're quitting.
let forceQuit = false
// In-memory mirror of the persisted closeAction. The `close` handler
// fires synchronously and can't `await getCloseAction()` from disk, so
// we load it on startup and re-sync whenever the user toggles the
// Settings UI (via the IPC handler below).
let closeActionCache: CloseAction = 'tray'

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

  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: useSaved ? saved!.width : 1200,
    height: useSaved ? saved!.height : 800,
    x: useSaved ? saved!.x : undefined,
    y: useSaved ? saved!.y : undefined,
    minWidth: 940,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    // Frameless on both platforms but with the OS-native window-control
    // affordances:
    //   Windows — 'hidden' (no chrome, our custom min/max/close render
    //             in the header).
    //   macOS   — 'hiddenInset' keeps the traffic lights (red/yellow/
    //             green) at the top-left, positioned to vertically
    //             centre on our 40px-tall header. The renderer hides
    //             our right-side custom window-controls on darwin
    //             since traffic lights cover the same functions.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 14, y: 16 } : undefined,
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
  // Push the maximized flag to the renderer so the custom titlebar's
  // maximize/restore button can swap its icon when the user uses Aero
  // snap, the system menu, or a double-click on the drag region —
  // anything that toggles the state without going through our buttons.
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximize-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximize-changed', false))
  mainWindow.on('close', (event) => {
    // Save the final geometry regardless of whether we're actually
    // closing or just minimising to tray — the user might restart
    // tomorrow having hidden the window today, and the bounds should
    // still survive that.
    if (saveStateTimer) {
      clearTimeout(saveStateTimer)
      saveStateTimer = null
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const isMaximized = mainWindow.isMaximized()
      const b = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
      if (b.width >= 200 && b.height >= 200) {
        try {
          void setWindowState({
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
            isMaximized
          })
        } catch (err) {
          console.warn('[window-state] final save failed:', err)
        }
      }
    }
    // Hide-to-tray interception. `closeActionCache` is the in-memory
    // mirror of config.closeAction; `forceQuit` is true when the user
    // picked Quit (tray menu / Cmd+Q / before-quit fired for any
    // reason), in which case we let the close go through.
    if (closeActionCache === 'tray' && !forceQuit) {
      event.preventDefault()
      mainWindow?.hide()
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
  //
  // We implement Range request handling ourselves rather than delegating
  // to net.fetch(file:// ...). Without proper byte-range support the
  // <audio> element sees `seekable = [0, 0]` and clamps any seek to 0 —
  // the seek bar becomes a "restart" button. 206 Partial Content with
  // Content-Range tells the player it can seek anywhere in the file.
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

    let fileSize: number
    try {
      fileSize = statSync(path).size
    } catch (err) {
      console.warn(`[media://] stat failed for ${path}:`, err)
      return new Response('not found', { status: 404 })
    }

    // Pick a MIME type the <audio>/<img> element will accept. yt-dlp's
    // bestaudio for Premium is webm/Opus; medium falls back to m4a/AAC.
    // Thumbnails are always saved as .jpg (we don't sniff source format).
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const mime = kind === 'thumb'
      ? 'image/jpeg'
      : ext === 'webm' ? 'audio/webm'
      : ext === 'm4a' || ext === 'mp4' ? 'audio/mp4'
      : ext === 'opus' ? 'audio/ogg'
      : ext === 'mp3' ? 'audio/mpeg'
      : 'application/octet-stream'

    const rangeHeader = request.headers.get('range')
    if (!rangeHeader) {
      // Full-file response, but advertise byte-range support so the
      // first follow-up seek triggers a 206 path.
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        status: 200,
        headers: {
          'Content-Length': String(fileSize),
          'Content-Type': mime,
          'Accept-Ranges': 'bytes'
        }
      })
    }

    // Range: bytes=START-END (END is optional). HTML5 audio sends these
    // formats; we don't need to support multipart ranges.
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
    if (!m) {
      return new Response('invalid range', {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` }
      })
    }
    const start = Number(m[1])
    const end = m[2] ? Math.min(Number(m[2]), fileSize - 1) : fileSize - 1
    if (Number.isNaN(start) || start >= fileSize || start > end) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` }
      })
    }
    const chunkSize = end - start + 1
    return new Response(
      Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream,
      {
        status: 206,
        headers: {
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Type': mime,
          'Accept-Ranges': 'bytes'
        }
      }
    )
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
  // Like / remove like (POST /like/like + /like/removelike via page-proxy).
  // Renderer sends boolean for the desired state; backend returns true if
  // YT accepted the action.
  ipcMain.handle('metadata:like', (_event, videoId: string, like: boolean) =>
    likeTrack(videoId, like)
  )
  // Radio for a track — yt.music.getUpNext(videoId). Returns the related
  // tracks as a fresh sourceList for the player.
  ipcMain.handle('metadata:radio', (_event, videoId: string) => getRadioForTrack(videoId))
  // Artist page — /browse on a channelId. Returns header + top songs +
  // album/single/related carousels for the new artist view.
  ipcMain.handle('metadata:artist', (_event, channelId: string) => getArtistView(channelId))
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
  // Cancel an in-flight per-track download (clicking ↓ on a track that's
  // currently being fetched). Kills the underlying yt-dlp process; the
  // .part file is swept up in downloadOne's catch block.
  ipcMain.handle('downloads:cancel', (_event, videoId: string) => cancelDownload(videoId))
  // Cancel an in-flight BULK download (the playlist-header progress
  // chip's ✕ button). Kills the currently-running yt-dlp AND tells the
  // downloadMany loop to stop dispatching new tracks. Already-completed
  // tracks stay on disk.
  ipcMain.handle('downloads:cancelAll', () => cancelAllDownloads())
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
  // Custom-titlebar window controls — the native chrome is hidden, so
  // the renderer's header buttons drive these via IPC. isMaximized is
  // read on mount; maximize-changed is pushed so the icon stays in
  // sync with the OS-side Aero-snap / double-click-titlebar gestures.
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

  // Mini-player. Same BrowserWindow, just resized + always-on-top +
  // its own renderer layout. Two presets: 'compact' (horizontal pill,
  // 420×96) and 'square' (cover-focused, 280×360). preMini bounds
  // are stashed so exit can restore exactly what the user had.
  ipcMain.handle(
    'window:enterMini',
    (_event, layout: 'compact' | 'square') => enterMiniMode(layout)
  )
  ipcMain.handle(
    'window:setMiniLayout',
    (_event, layout: 'compact' | 'square') => setMiniLayout(layout)
  )
  ipcMain.handle('window:exitMini', () => exitMiniMode())
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
    // Rebuild the tray menu — it caches the labels at create time, so
    // the new lang only takes effect after a refresh.
    rebuildTrayMenu(lang)
  })
  // Audio quality preset for new downloads — see formatSelectorFor() in
  // downloads.ts. Doesn't retroactively re-download anything.
  ipcMain.handle('settings:getAudioQuality', () => getAudioQuality())
  ipcMain.handle('settings:setAudioQuality', (_event, q: AudioQuality) => setAudioQuality(q))
  // Shuffle + repeat persist across launches so the streamer can set
  // them once and not have to flip them every session.
  ipcMain.handle('settings:getShuffleMode', () => getShuffleMode())
  ipcMain.handle('settings:setShuffleMode', (_event, on: boolean) => setShuffleMode(on))
  ipcMain.handle('settings:getRepeatMode', () => getRepeatMode())
  ipcMain.handle('settings:setRepeatMode', (_event, m: RepeatMode) => setRepeatMode(m))
  // Per-playlist override (custom track order + pinned setVideoIds).
  // Lets reshuffle / drag-reorder / pin survive a restart. Saving null
  // deletes the entry — equivalent to "reset to YT's natural order".
  ipcMain.handle('settings:getPlaylistOverride', (_event, id: string) =>
    getPlaylistOverride(id)
  )
  ipcMain.handle(
    'settings:setPlaylistOverride',
    (_event, id: string, override: PlaylistOverride | null) =>
      setPlaylistOverride(id, override)
  )

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

  // Settings: close-button action (tray vs quit) — Tray section below.
  ipcMain.handle('settings:getCloseAction', () => getCloseAction())
  ipcMain.handle('settings:setCloseAction', async (_event, action: CloseAction) => {
    await setCloseAction(action)
    // Keep the in-memory mirror in sync so the close interceptor uses
    // the new value without a restart.
    closeActionCache = action
  })
  // Crossfade duration in seconds — 0 disables. Renderer reads on
  // mount and any time the user moves the Settings slider.
  ipcMain.handle('settings:getCrossfadeDuration', () => getCrossfadeDuration())
  ipcMain.handle('settings:setCrossfadeDuration', (_event, seconds: number) =>
    setCrossfadeDuration(seconds)
  )

  // Seed the in-memory closeAction BEFORE the window is created — the
  // close handler reads from this synchronously and we don't want a
  // first-launch race where the user closes the app before the value
  // landed.
  closeActionCache = await getCloseAction()

  await createWindow()
  await createTray()

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
    // Spin up the yt-dlp daemon pool. No warmup — it just queues
    // ahead of user clicks. The first click pays YoutubeDL construction
    // cost (~5-7s) on one daemon; subsequent clicks land on the warm
    // daemon at ~3s. No-op on Windows/Linux.
    try {
      startYtdlpDaemon(arg)
    } catch (err) {
      console.warn('[startup-reconnect] daemon start failed:', err)
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

// Cmd+Q / Alt+F4-driven app.quit / autoUpdater quit / tray-Quit all
// flow through `before-quit` first. Setting forceQuit lets the close
// handler skip the tray interception so the window actually closes.
app.on('before-quit', () => {
  forceQuit = true
  // Tell the persistent yt-dlp daemon to exit cleanly so it gets a
  // chance to flush its caches; falls through to SIGTERM if it doesn't.
  stopYtdlpDaemon()
})

// ---------------------------------------------------------------------------
// SYSTEM TRAY — icon + minimal menu (show / play-pause / prev / next / quit).
// Menu items proxy back to the renderer via `tray:command` so the existing
// playback machinery (which all lives in the renderer) stays the source of
// truth. Tray itself is permanent — even when closeAction='quit', the tray
// is still useful for quick access while the window is minimised.
// ---------------------------------------------------------------------------

// Per-language labels for the tray menu. Tray lives in main, can't reach
// the renderer's i18n.ts; this small mirror is rebuilt on `setLang`.
const TRAY_LABELS = {
  ru: {
    showHide: 'Показать / Скрыть',
    playPause: 'Воспроизвести / Пауза',
    prev: 'Предыдущий трек',
    next: 'Следующий трек',
    quit: 'Выйти'
  },
  en: {
    showHide: 'Show / Hide',
    playPause: 'Play / Pause',
    prev: 'Previous',
    next: 'Next',
    quit: 'Quit'
  }
} as const

async function createTray(): Promise<void> {
  const isMac = process.platform === 'darwin'
  const trayImage = nativeImage.createFromPath(icon)
  // Tray icon sizing differs per platform:
  //   Windows — system tray expects 16px; resize so the raccoon doesn't
  //             get auto-downscaled with bad filtering.
  //   macOS   — menu bar at standard scaling is 22px; Retina pulls a
  //             2x. setTemplateImage(true) tells AppKit to render the
  //             icon as a monochrome mask that follows the menu-bar
  //             theme (white on dark, black on light) — this matters
  //             because our coloured raccoon would clash with the
  //             user's wallpaper otherwise. The colored icon stays as
  //             the app icon in the Dock + window; the tray gets a
  //             desaturated template variant for the menu bar.
  const resized = trayImage.resize(
    isMac ? { width: 22, height: 22 } : { width: 16, height: 16 }
  )
  if (isMac) resized.setTemplateImage(true)
  tray = new Tray(resized)
  tray.setToolTip('eCoda')
  rebuildTrayMenu(await getLang())
  // Single-click on Windows = show + focus. Double-click is also wired
  // to the same handler so users with old Windows muscle-memory hit the
  // same outcome. On macOS, single click opens the menu by default —
  // we don't override that to stay native-feeling.
  if (!isMac) {
    tray.on('click', showAndFocusWindow)
    tray.on('double-click', showAndFocusWindow)
  }
}

function rebuildTrayMenu(lang: Lang): void {
  if (!tray) return
  const L = TRAY_LABELS[lang] ?? TRAY_LABELS.ru
  const menu = Menu.buildFromTemplate([
    {
      label: 'eCoda',
      enabled: false
    },
    { type: 'separator' },
    {
      label: L.showHide,
      click: () => {
        if (!mainWindow) return
        if (mainWindow.isVisible() && mainWindow.isFocused()) {
          mainWindow.hide()
        } else {
          showAndFocusWindow()
        }
      }
    },
    { type: 'separator' },
    {
      label: L.playPause,
      click: () => sendTrayCommand('play-pause')
    },
    {
      label: L.prev,
      click: () => sendTrayCommand('prev')
    },
    {
      label: L.next,
      click: () => sendTrayCommand('next')
    },
    { type: 'separator' },
    {
      label: L.quit,
      click: () => {
        forceQuit = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function showAndFocusWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function sendTrayCommand(cmd: 'play-pause' | 'next' | 'prev'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('tray:command', cmd)
}

// ---------------------------------------------------------------------------
// MINI-PLAYER — same BrowserWindow, resized + always-on-top + reskinned by
// the renderer. We stash the pre-mini bounds + minimum-size so exit can
// snap back exactly. Two presets:
//   compact (A): 420×96  — Spotify-style horizontal pill
//   square  (B): 280×360 — cover-focused vertical card
// The renderer switches its template based on a 'window:mini-changed'
// push, so the OS-resize and the layout swap stay in sync.
// ---------------------------------------------------------------------------
const MINI_SIZES = {
  compact: { width: 420, height: 108 },
  // 280×320: 14px seek + 26px top-bar + 180px cover + ~38px meta
  // + ~50px transport row + paddings. Prior 360px window left ~60px
  // of dead space below the transport row.
  square: { width: 280, height: 320 }
} as const

let preMiniBounds: { x: number; y: number; width: number; height: number } | null = null
let preMiniMinSize: { width: number; height: number } | null = null
let miniActive = false

function enterMiniMode(layout: 'compact' | 'square'): void {
  if (!mainWindow || miniActive) {
    if (mainWindow && miniActive) setMiniLayout(layout)
    return
  }
  // Unmaximize first so getBounds reports the restored rect (otherwise
  // exit would snap back to the maximised dimensions = same as mini-
  // size, defeating the restore).
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  preMiniBounds = mainWindow.getBounds()
  preMiniMinSize = { width: 940, height: 560 }
  // Drop the minimum so the resize below isn't clamped, then place the
  // mini window in the bottom-right corner of the current display.
  mainWindow.setMinimumSize(120, 80)
  const dims = MINI_SIZES[layout]
  const display = screen.getDisplayMatching(preMiniBounds).workArea
  const x = display.x + display.width - dims.width - 24
  const y = display.y + display.height - dims.height - 24
  mainWindow.setBounds({ x, y, width: dims.width, height: dims.height }, false)
  mainWindow.setAlwaysOnTop(true, 'normal')
  // Lock the window size — mini-player has two fixed-size presets
  // (compact + square). User-resize would just stretch the layout
  // weirdly, and the resize-edge hit area was eating clicks meant for
  // the top-of-shell seek strip. The toggle button swaps presets.
  mainWindow.setResizable(false)
  miniActive = true
  mainWindow.webContents.send('window:mini-changed', { active: true, layout })
}

function setMiniLayout(layout: 'compact' | 'square'): void {
  if (!mainWindow || !miniActive) return
  const dims = MINI_SIZES[layout]
  // Keep the bottom-right corner anchored when swapping sizes so the
  // mini-player doesn't seem to "jump" across the screen mid-toggle.
  // setBounds works programmatically even when resizable is locked.
  const cur = mainWindow.getBounds()
  const x = cur.x + cur.width - dims.width
  const y = cur.y + cur.height - dims.height
  mainWindow.setBounds({ x, y, width: dims.width, height: dims.height }, false)
  mainWindow.webContents.send('window:mini-changed', { active: true, layout })
}

function exitMiniMode(): void {
  if (!mainWindow || !miniActive) return
  miniActive = false
  mainWindow.setAlwaysOnTop(false)
  // Restore user-resize before restoring bounds + min size so the
  // window's interactive feel goes back to exactly what it was.
  mainWindow.setResizable(true)
  if (preMiniMinSize) {
    mainWindow.setMinimumSize(preMiniMinSize.width, preMiniMinSize.height)
  }
  if (preMiniBounds) {
    mainWindow.setBounds(preMiniBounds, false)
  }
  preMiniBounds = null
  preMiniMinSize = null
  mainWindow.webContents.send('window:mini-changed', { active: false, layout: 'compact' })
}
